import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { BridgeOwnership } from '@core/bridge/bridge-ownership'
import { DeviceCodeService } from '@core/bridge/device-code-service'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import { FilePairingStore } from '@core/bridge/file-pairing-store'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import { PairingService } from '@core/bridge/pairing-service'
import { FileRegistryStoreAdapter } from '@core/bridge/registry-store-adapter'
import { resolveCliPair } from '@core/bridge/resolve-cli-pair'
import { toPairedClientInfo } from '@core/bridge/to-paired-client-info'
import { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
import type { BridgeErrorCode } from '@core/bridge-receiver/errors'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type ClientIdentity,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type { Handler } from '@shared/protocol/handler-types'

/** What `bootstrapBridgeForServer` returns; `localToken`/`port` are exposed for
 *  the host + tests (the CLI discovers them via `endpoint.json`). The bridge:*
 *  handler maps are merged into the Fastify RPC routes by the server entry so
 *  the web renderer can drive device-code approval + the paired-client list. */
export interface ServerBridgeRuntime {
  server: WebSocketBridgeServer
  port: number
  localToken: string
  bridgeCommandHandlers: Record<string, Handler>
  bridgeQueryHandlers: Record<string, Handler>
  shutdown: () => Promise<void>
}

export interface ServerBridgeOptions {
  /** Server data dir (env MOTRIX_DATA_DIR / platform.userDataDir); the bridge
   *  state lives under `<userDataDir>/bridge/`. */
  userDataDir: string
  host: string
  port: number
  motrixVersion: string
  /** The process-lifetime core EventBus (for the SSE firehose + re-emitting
   *  bridge approval events so the web broadcaster forwards them). */
  eventBus: {
    on(event: string, listener: (payload: unknown) => void): unknown
    off(event: string, listener: (payload: unknown) => void): unknown
    emit(event: string, ...args: unknown[]): void
  }
  readHandlerDeps: ReadHandlerDeps
  writeHandlerDeps: WriteHandlerDeps
  localize?: (code: BridgeErrorCode) => string
  /** Public URL of the web approval UI (`MOTRIX_PUBLIC_URL`), surfaced to the
   *  CLI as a device-code `verificationUri`. Omitted when unset — the bridge
   *  must never advertise its own port (it does not serve the UI). */
  verificationUri?: string
  /** Test-only override for the device-code pending-request TTL (production
   *  always relies on {@link DeviceCodeService}'s own 5-minute default) — lets
   *  a test observe the real TTL-timer expiry push over a real HTTP + real
   *  clock round trip without waiting 5 minutes. */
  deviceCodeTtlMs?: number
}

/**
 * Stand the SAME `@core/bridge` runtime up in the Node/server shell, exposing
 * the agent-facing unary `POST /mdxp` + SSE `GET /mdxp/events` surface
 * (read/write methods + the stats/task firehose) on a configurable host:port.
 *
 * Mirrors the desktop bootstrap minus every Electron piece: NO
 * PairingDialogController (headless; web-UI approval is Spec 7),
 * NO NativeMessagingInstaller (no browser NM on a server),
 * NO ipcMain. The extension `download/submit` WS path is intentionally NOT wired
 * here — the server's value is the agent HTTP MDXP surface.
 */
export async function bootstrapBridgeForServer(
  opts: ServerBridgeOptions
): Promise<ServerBridgeRuntime> {
  const dataDir = join(opts.userDataDir, 'bridge')
  const pairing = new PairingService(
    new FilePairingStore(join(dataDir, 'pairing.json'))
  )
  await pairing.load()
  const registry = new TrustedExtensionRegistry(
    new FileRegistryStoreAdapter(join(dataDir, 'registry.json')),
    []
  )
  await registry.load()

  // Machine-owner Bearer token for the unary/SSE transports (same model as the
  // desktop). On a NAS it lives in endpoint.json (readable only on the host); a
  // remote CLI obtains a token via Spec 7 device-code pairing.
  // Agent /mdxp secret — self-minted, written to endpoint.json. Distinct from
  // the operator control-plane token (Spec 9 / F1): the two planes no longer
  // share a secret, so a leak/loss of one does not compromise the other.
  // Per-start, deliberately NOT persisted like the desktop shell's
  // `loadOrCreateBridgeIdentity`: extension pairing is headless-denied here
  // (no NM tickets are ever minted against this token), so a restart
  // invalidating every previously-issued Bearer token is a wanted property,
  // not a gap.
  const localToken = randomBytes(32).toString('base64url')
  // One generation for the life of this process, named here (rather than
  // inlined at the endpoint write below) so a future second write site can't
  // accidentally mint a fresh one and make every NM ticket look stale.
  const serverGeneration = randomUUID()

  // Device-code pairing for cli/agent clients. The approval prompt is surfaced
  // in the WEB UI: bridge events are re-emitted onto the core EventBus, which
  // the Fastify broadcaster forwards over /rpc/events. (The desktop uses
  // Electron IPC for the same events; only the server shell takes this path.)
  const bridgeBus = new BridgeEventBus()
  // onLifecycle re-emits the cli device-code settle/expire push onto the SAME
  // bridgeBus channel the desktop shell uses, so it flows through the
  // identical re-emit-onto-eventBus wiring below (→ /rpc/events broadcaster).
  const deviceCode = new DeviceCodeService(pairing, {
    ttlMs: opts.deviceCodeTtlMs,
    onLifecycle: {
      settled: (requestId, outcome) =>
        bridgeBus.emitPairRequestSettled({
          key: pairRequestKey({ kind: 'cli', requestId }),
          outcome,
        }),
      expired: (requestId) =>
        bridgeBus.emitPairRequestExpired({
          key: pairRequestKey({ kind: 'cli', requestId }),
        }),
    },
  })
  bridgeBus.on('PairRequested', (p) =>
    opts.eventBus.emit(BridgeEvents.PairRequested, p)
  )
  bridgeBus.on('Paired', (p) => opts.eventBus.emit(BridgeEvents.Paired, p))
  bridgeBus.on('Revoked', (p) => opts.eventBus.emit(BridgeEvents.Revoked, p))
  bridgeBus.on('Error', (p) => opts.eventBus.emit(BridgeEvents.Error, p))
  bridgeBus.on('PairRequestSettled', (p) =>
    opts.eventBus.emit(BridgeEvents.PairRequestSettled, p)
  )
  bridgeBus.on('PairRequestExpired', (p) =>
    opts.eventBus.emit(BridgeEvents.PairRequestExpired, p)
  )

  const server = new WebSocketBridgeServer({
    pairing,
    registry,
    // None of the six MBP1 options (instanceId, serverGeneration, appVersion,
    // credentials, isOfficialId, queueMbp1Dialog) are wired for this runtime,
    // so `/pair` and `/v1` both 404 (they resolve as a unit — see
    // `resolveMbp1Wiring`): there is no extension WebSocket surface here at
    // all, not even reconnect for a previously-paired extension. cli/agent
    // clients pair through the device-code flow below instead, approved in
    // the web UI.
    motrixVersion: opts.motrixVersion,
    runtime: 'server',
    ffmpegAvailable: false,
    localToken,
    deviceCode,
    onPairRequested: (payload) => bridgeBus.emitPairRequested(payload),
    verificationUri: opts.verificationUri,
  })

  // bridge:* RPC handlers the web renderer reaches via /rpc/{command,query}.
  const bridgeCommandHandlers: Record<string, Handler> = {
    [BridgeCommands.ResolvePair]: async (
      params: ResolvePairParams
    ): Promise<ResolvePairResult> => {
      // Only cli (device-code) approval has a server-shell path; the extension
      // /pair WS flow is not wired here (headless).
      if (params.kind === 'cli') {
        return resolveCliPair(deviceCode, params, (paired) =>
          bridgeBus.emitPaired({ identity: paired.identity })
        )
      }
      return { ok: true }
    },
    [BridgeCommands.RevokePair]: async (params: {
      identity: ClientIdentity
    }) => {
      await pairing.revoke(params.identity, 'user-revoked')
      bridgeBus.emitRevoked({ identity: params.identity })
    },
  }
  const bridgeQueryHandlers: Record<string, Handler> = {
    [BridgeQueries.ListPaired]: async () =>
      pairing.listPaired().map(toPairedClientInfo),
    // cli-only — unlike the desktop shell, there is no PairingDialogController
    // here to union in (extension pairing is headless-denied, above).
    [BridgeQueries.ListPendingPairRequests]: async () =>
      deviceCode.listPending(),
  }

  // Register the agent-facing methods BEFORE start() (no listening-without-
  // handlers race). Read/write/SSE only — no extension submit/cancel handlers.
  server.registerReadMethods(opts.readHandlerDeps)
  server.registerWriteMethods(opts.writeHandlerDeps)

  const ownership = new BridgeOwnership()
  try {
    // Acquire persistence ownership before the listener so reverse-order
    // shutdown first stops request admission, then drains every markActive
    // write accepted by that listener.
    ownership.own('pairing-persistence', () => pairing.stopAndDrain())
    // Own the server before bind so a partial listen failure is rolled back.
    ownership.own('server', () => server.stop())
    const port = await server.start(opts.host, opts.port)

    const streamSource = new BridgeStreamSource(server, opts.localize)
    ownership.own('stream-source', () => streamSource.detach(opts.eventBus))
    streamSource.attach(opts.eventBus)

    // Clear every device-code TTL timer so none fires — into a torn-down
    // bridgeBus, re-emitting a stale PairRequestExpired onto the shared,
    // process-lifetime opts.eventBus — after this bridge instance is gone.
    // Mirrors the desktop shell's `ownership.own('device-code', ...)`.
    ownership.own('device-code', () => deviceCode.dispose())

    const endpointWriter = new EndpointFileWriter(
      join(dataDir, 'endpoint.json')
    )
    // A failed atomic replace may still have created temporary/discovery state.
    ownership.own('endpoint', () => endpointWriter.clear())
    await endpointWriter.write(port, localToken, serverGeneration)

    return {
      server,
      port,
      localToken,
      bridgeCommandHandlers,
      bridgeQueryHandlers,
      shutdown: () => ownership.dispose(),
    }
  } catch (error) {
    return ownership.rollback(error)
  }
}
