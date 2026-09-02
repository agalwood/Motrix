import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  acquireBridgeDataDirLock,
  type BridgeDataDirLockHandle,
  type BridgeDataDirLockRecoveryAuthority,
} from '@core/bridge/bridge-data-dir-lock'
import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { BridgeOwnership } from '@core/bridge/bridge-ownership'
import { DeviceCodeService } from '@core/bridge/device-code-service'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import { recoverExtensionPairingProjectionWriterLock } from '@core/bridge/file-extension-pairing-projection-store'
import { FilePairingStore } from '@core/bridge/file-pairing-store'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import { PairingService } from '@core/bridge/pairing-service'
import { FileRegistryStoreAdapter } from '@core/bridge/registry-store-adapter'
import { resolveCliPair } from '@core/bridge/resolve-cli-pair'
import { toPairedClientInfo } from '@core/bridge/to-paired-client-info'
import { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import {
  type ResolveOptions,
  UrlResolutionService,
} from '@core/bridge/url-resolution-service'
import {
  type MethodHandlers,
  WebSocketBridgeServer,
} from '@core/bridge/web-socket-bridge-server'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
import type { BridgeErrorCode } from '@core/bridge-receiver/errors'
import { Notifications } from '@motrix/mdxp'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type BridgeStatusInfo,
  type ClientIdentity,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type { Handler } from '@shared/protocol/handler-types'
import { CancellationTokenSource } from 'vscode-jsonrpc'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'
import { RemoteExtensionSurfacePolicy } from './remote-extension-surface-policy'
import { ServerExtensionMbp1Runtime } from './server-extension-mbp1-runtime'

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

/** Extension-only download application surface. The Server composition root
 * builds the existing BridgeReceiver against its live task/engine services;
 * bootstrap owns its recovery, admission and shutdown ordering. */
export interface ServerExtensionReceiver {
  handle: NonNullable<MethodHandlers['submitDownload']>
  cancel: (taskId: string) => Promise<void>
  restoreInflight: () => Promise<void>
  start: () => void
  stopAndDrain: () => Promise<void>
}

export interface ServerBridgeOptions {
  /** Server data dir (env MOTRIX_DATA_DIR / platform.userDataDir); the bridge
   *  state lives under `<userDataDir>/bridge/`. */
  userDataDir: string
  host: string
  port: number
  /** Persisted bridge port policy. Isolated tests may omit it and fall back to
   * the requested listener port. */
  fixedPort?: BridgeStatusInfo['fixedPort']
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
  /** Production supplies an authority derived from the already-bound main
   * control-plane port. Omitted only by isolated tests with a fresh data dir. */
  bridgeDataDirLockRecoveryAuthority?: BridgeDataDirLockRecoveryAuthority
  /** Process-lifetime lock supplied by the Server composition root. When
   * present, this runtime borrows it and never releases it on restart. */
  bridgeDataDirLock?: BridgeDataDirLockHandle
  /** Parser-issued all-or-nothing remote Extension configuration. */
  remoteExtensionConfig?: RemoteExtensionConfig
  /** Preloaded process-lifetime registry supplied by ServerBridgeManager. */
  trustedExtensionRegistry?: TrustedExtensionRegistry
  /** Required when remote Extension support is enabled. Absence keeps the
   * public MBP1 surface from starting instead of exposing a connect-only shell. */
  createExtensionReceiver?: (context: {
    dataDir: string
    bridgeBus: BridgeEventBus
  }) => ServerExtensionReceiver | Promise<ServerExtensionReceiver>
}

/**
 * Stand the SAME `@core/bridge` runtime up in the Node/server shell, exposing
 * the agent-facing unary `POST /mdxp` + SSE `GET /mdxp/events` surface
 * (read/write methods + the stats/task firehose) on a configurable host:port.
 *
 * Mirrors the desktop bootstrap minus every Electron piece: NO
 * PairingDialogController (headless; web-UI approval is Spec 7),
 * NO NativeMessagingInstaller (no browser NM on a server),
 * NO ipcMain. Remote Extension routes are atomic: MBP1 authorization, the raw
 * public-route policy, and the real download receiver must all be present
 * before any of the four routes becomes visible.
 */
export async function bootstrapBridgeForServer(
  opts: ServerBridgeOptions
): Promise<ServerBridgeRuntime> {
  const dataDir = join(opts.userDataDir, 'bridge')
  await mkdir(dataDir, { recursive: true })
  const ownership = new BridgeOwnership()
  const dataDirLock =
    opts.bridgeDataDirLock ??
    (await acquireBridgeDataDirLock(dataDir, {
      recoverExisting: opts.bridgeDataDirLockRecoveryAuthority,
    }))
  if (opts.bridgeDataDirLock === undefined) {
    ownership.own('bridge-data-dir-lock', () => dataDirLock.release())
  }
  try {
    const pairing = new PairingService(
      new FilePairingStore(join(dataDir, 'pairing.json'))
    )
    await pairing.load()
    const bridgeBus = new BridgeEventBus()
    const remoteExtensionEnabled =
      opts.remoteExtensionConfig !== undefined &&
      isIssuedRemoteExtensionConfig(opts.remoteExtensionConfig) &&
      opts.remoteExtensionConfig.status === 'enabled'
    if (
      remoteExtensionEnabled &&
      opts.host !== '127.0.0.1' &&
      opts.host !== '::1' &&
      opts.host !== 'localhost'
    ) {
      throw new Error('remote Extension bridge must bind to loopback')
    }
    if (remoteExtensionEnabled) {
      await recoverExtensionPairingProjectionWriterLock(
        join(dataDir, 'extension-pairings.json'),
        dataDirLock
      )
    }
    const extensionMbp1 = remoteExtensionEnabled
      ? await ServerExtensionMbp1Runtime.load({
          dataDir,
          bus: bridgeBus,
          publicAuthority:
            opts.remoteExtensionConfig?.status === 'enabled'
              ? opts.remoteExtensionConfig.publicWebSocketAuthority
              : '',
        })
      : null
    const remoteExtensionSurface =
      remoteExtensionEnabled && opts.remoteExtensionConfig !== undefined
        ? new RemoteExtensionSurfacePolicy(opts.remoteExtensionConfig)
        : null
    if (remoteExtensionSurface !== null) {
      ownership.own('remote-extension-surface', () =>
        remoteExtensionSurface.dispose()
      )
    }
    if (extensionMbp1 !== null) {
      ownership.own('extension-mbp1', () => extensionMbp1.stopAndDrain())
    }
    if (remoteExtensionEnabled && opts.createExtensionReceiver === undefined) {
      throw new Error('remote Extension receiver is not configured')
    }
    const extensionReceiver = remoteExtensionEnabled
      ? await opts.createExtensionReceiver?.({
          dataDir: join(dataDir, 'receiver'),
          bridgeBus,
        })
      : null
    if (remoteExtensionEnabled && extensionReceiver == null) {
      throw new Error('remote Extension receiver is unavailable')
    }
    if (extensionReceiver != null) {
      ownership.own('extension-receiver', () =>
        extensionReceiver.stopAndDrain()
      )
      await extensionReceiver.restoreInflight()
    }
    let boundPort = opts.port
    const registry =
      opts.trustedExtensionRegistry ??
      new TrustedExtensionRegistry(
        new FileRegistryStoreAdapter(join(dataDir, 'registry.json')),
        extensionMbp1 === null
          ? []
          : [...extensionMbp1.identityResolver.officialEntries]
      )
    if (opts.trustedExtensionRegistry === undefined) await registry.load()

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
      motrixVersion: opts.motrixVersion,
      runtime: 'server',
      ffmpegAvailable: false,
      localToken,
      deviceCode,
      onPairRequested: (payload) => bridgeBus.emitPairRequested(payload),
      verificationUri: opts.verificationUri,
      ...(extensionMbp1 === null
        ? {}
        : {
            instanceId: extensionMbp1.instanceId,
            serverGeneration,
            appVersion: opts.motrixVersion,
            credentials: extensionMbp1.credentials,
            isOfficialId: (browser, id) =>
              extensionMbp1.identityResolver.isOfficialId(browser, id),
            queueMbp1Dialog: (request) =>
              extensionMbp1.prompts.queueMbp1Prompt(request),
            canAdmitExtensionIdentity: (identity) =>
              extensionMbp1.extensionPairings.canAdmitIdentity(identity),
            onExtensionAuthenticated: (identity, credentialId) =>
              extensionMbp1.onAuthenticated(identity, credentialId),
            extensionMbp1RoutesEnabled:
              remoteExtensionSurface !== null && extensionReceiver != null,
            extensionMbp1RoutePolicy: (request) =>
              remoteExtensionSurface?.evaluate(request) ?? {
                kind: 'reject',
                status: 404,
              },
          }),
    })
    if (extensionMbp1 !== null) {
      extensionMbp1.attachServer(server)
      await extensionMbp1.recoverBeforeListen()
    }

    const urlResolution = new UrlResolutionService(() =>
      Array.from(server.iterSessions())
        .filter((session) => session.conn.isReady())
        .map((session) => session.conn)
    )
    const inFlightResolves = new Map<string, CancellationTokenSource>()
    ownership.own('url-resolutions', () => {
      for (const cts of inFlightResolves.values()) cts.cancel()
      inFlightResolves.clear()
    })

    // bridge:* RPC handlers the web renderer reaches via /rpc/{command,query}.
    const bridgeCommandHandlers: Record<string, Handler> = {
      [BridgeCommands.ResolvePair]: async (
        params: ResolvePairParams
      ): Promise<ResolvePairResult> => {
        if (params.kind === 'cli') {
          return resolveCliPair(deviceCode, params, (paired) =>
            bridgeBus.emitPaired({ identity: paired.identity })
          )
        }
        return (
          extensionMbp1?.settleExtensionPrompt(params) ?? {
            ok: false,
            reason: 'unavailable',
          }
        )
      },
      [BridgeCommands.RevokePair]: async (params: {
        identity: ClientIdentity
      }) => {
        if (params.identity.kind === 'extension') {
          if (extensionMbp1 === null) {
            throw new Error('extension pairing is unavailable')
          }
          await extensionMbp1.revoke(params.identity)
          return
        }
        await pairing.revoke(params.identity, 'user-revoked')
        bridgeBus.emitRevoked({ identity: params.identity })
      },
      [BridgeCommands.AddTrusted]: async (params: {
        id: string
        browser: 'chromium' | 'firefox'
        label?: string
      }) => {
        await registry.add(
          params.id,
          params.browser,
          'user-added',
          params.label
        )
      },
      [BridgeCommands.RemoveTrusted]: async (params: {
        id: string
        browser: 'chromium' | 'firefox'
      }) => {
        await registry.remove(params.id, params.browser)
      },
    }
    const bridgeQueryHandlers: Record<string, Handler> = {
      [BridgeQueries.ListPaired]: async () => [
        ...(extensionMbp1?.extensionPairings.list().map(toPairedClientInfo) ??
          []),
        ...pairing.listPaired().map(toPairedClientInfo),
      ],
      [BridgeQueries.ListPendingPairRequests]: async () => [
        ...deviceCode.listPending(),
        ...(extensionMbp1?.prompts.listPending() ?? []),
      ],
      [BridgeQueries.ListTrusted]: async () => registry.list(),
      [BridgeQueries.ProbeUrl]: async (url: string) => urlResolution.probe(url),
      [BridgeQueries.ResolveUrl]: async (
        requestId: string,
        url: string,
        options: ResolveOptions = {}
      ) => {
        const cts = new CancellationTokenSource()
        inFlightResolves.set(requestId, cts)
        try {
          return await urlResolution.resolve(url, options, cts.token)
        } finally {
          inFlightResolves.delete(requestId)
        }
      },
      [BridgeQueries.CancelResolveUrl]: async (requestId: string) => {
        inFlightResolves.get(requestId)?.cancel()
      },
      [BridgeQueries.GetStatus]: async (): Promise<BridgeStatusInfo> => ({
        port: boundPort,
        degraded: false,
        extensionPairingHealth:
          extensionMbp1 === null ||
          extensionMbp1.extensionPairings.getHealth() === 'ready'
            ? 'ready'
            : 'degraded',
        fixedPort: opts.fixedPort ?? opts.port,
        instanceId: extensionMbp1?.instanceId ?? 'extension-mbp1-disabled',
      }),
    }

    // Register every application method BEFORE start() (no
    // listening-without-handlers race). A remotely enabled Server cannot reach
    // this point without its real receiver, so discovery never advertises a
    // connect-only bridge.
    if (extensionReceiver != null) {
      server.setHandlers({
        submitDownload: (params, ctx) => extensionReceiver.handle(params, ctx),
        cancelDownload: ({ taskId }) => extensionReceiver.cancel(taskId),
      })
      extensionReceiver.start()
    }
    server.registerReadMethods(opts.readHandlerDeps)
    server.registerWriteMethods(opts.writeHandlerDeps)

    // Acquire persistence ownership before the listener so reverse-order
    // shutdown first stops request admission, then drains every markActive
    // write accepted by that listener.
    ownership.own('pairing-persistence', () => pairing.stopAndDrain())
    // Own the server before bind so a partial listen failure is rolled back.
    ownership.own('server', () => server.stop())
    const port = await server.start(opts.host, opts.port)
    boundPort = port

    // Per-session Extension task lifecycle push. This mirrors the Desktop
    // shell: BridgeReceiver publishes against the authenticated session key;
    // the shell converts those events into encrypted MDXP notifications on
    // that session only. The global SSE stream below remains a separate agent
    // surface and must not substitute for this routing.
    bridgeBus.on('TaskProgress', ({ sessionKey, params }) => {
      server
        .getSession(sessionKey)
        ?.conn.sendNotification(Notifications.TaskProgress, params)
    })
    bridgeBus.on('TaskCompleted', ({ sessionKey, params }) => {
      server
        .getSession(sessionKey)
        ?.conn.sendNotification(Notifications.TaskCompleted, params)
    })
    bridgeBus.on('TaskError', ({ sessionKey, params }) => {
      server
        .getSession(sessionKey)
        ?.conn.sendNotification(Notifications.TaskError, params)
    })

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
