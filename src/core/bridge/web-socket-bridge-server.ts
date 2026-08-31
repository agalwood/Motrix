import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { AsyncWorkTracker } from '@core/inspector-activity/async-work-tracker'
import {
  type DownloadCancelParams,
  DownloadCancelParamsSchema,
  type DownloadSubmitParams,
  DownloadSubmitParamsSchema,
  ErrorCodes,
  InitializeParamsSchema,
  Methods,
  makeMdxpError,
  Notifications,
  Tools,
} from '@motrix/mdxp'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type Browser,
  type ClientIdentity,
  clientKey,
  makeSessionKey,
  type PairRequestPayload,
} from '@shared/protocol/bridge'
import { ResponseError } from 'vscode-jsonrpc'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import { BridgeConnection } from './bridge-connection'
import type { Mbp1CredentialStore } from './credential-store'
import type { DeviceCodeService } from './device-code-service'
import { createInitializeHandler } from './handlers/initialize-handler'
import {
  type ReadHandlerDeps,
  registerReadHandlers,
} from './handlers/read-handlers'
import {
  registerWriteHandlers,
  type WriteHandlerDeps,
} from './handlers/write-handlers'
import { MAX_ENVELOPE_FRAME_BYTES } from './mbp1/envelope'
import {
  type EnvelopeChannel,
  type EnvelopeStream,
  type EnvelopeStreamFaultKind,
  wrapWithEnvelope,
} from './mbp1/envelope-message-stream'
import { PairFloodControl } from './mbp1/flood-control'
import { NonceService } from './mbp1/nonce-service'
import { type PairDialogRequest, PairSession } from './mbp1/pair-session'
import { PreAuthTable } from './mbp1/pre-auth-table'
import { ReconnectRateLimit } from './mbp1/reconnect-rate-limit'
import { ReconnectSession } from './mbp1/reconnect-session'
import { TicketReplayCache } from './mbp1/ticket-verify'
import { MdxpDispatcher } from './mdxp-dispatcher'
import {
  contextFromConnection,
  type MdxpSessionContext,
} from './mdxp-session-context'
import type { PairingPromptEnqueueResult } from './pairing-prompt-controller'
import type { PairingService } from './pairing-service'
import type { TrustedExtensionRegistry } from './trusted-extension-registry'
import type { WebSocketLike } from './web-socket-message-stream'

export interface PairRequestArgs {
  extensionId: string
  browser: Browser
  extensionName: string
  extensionVersion: string
}

export interface BridgeServerOptions {
  pairing: PairingService
  registry: TrustedExtensionRegistry
  motrixVersion: string
  runtime: 'electron' | 'server'
  ffmpegAvailable: boolean
  /**
   * Machine-owner Bearer token for the unary `POST /mdxp` transport. Generated
   * per bridge start, mirrored into `endpoint.json` (mode 0600). Held in memory
   * here so the unary handler can authenticate same-host CLI/agent requests.
   */
  localToken: string
  /**
   * Device-code pairing for cli/agent clients (Spec 7b). When present, the
   * `POST /mdxp/pair/request` + `POST /mdxp/pair/poll` HTTP routes are enabled;
   * absent → those routes 404 (e.g. a shell with no approval path wired yet).
   */
  deviceCode?: DeviceCodeService
  /**
   * Fired when a device-code `pair/request` arrives, so the shell can surface an
   * approval prompt (the bootstrap wires this to `bus.emitPairRequested`). The
   * server itself stays bus-agnostic; only the shell knows how to prompt.
   */
  onPairRequested?: (payload: PairRequestPayload) => void
  /**
   * Public URL of the approval UI, returned to the CLI as `verificationUri` for
   * a device-code request. MUST be injected by the shell — it is NOT derivable
   * from the request Host, because the approval UI is a DIFFERENT service from
   * this bridge: on the desktop it is the Electron renderer (no URL → omit), on
   * the server shell it is the Fastify web app on a different port (set via
   * `MOTRIX_PUBLIC_URL`). When unset, `verificationUri` is omitted entirely
   * rather than pointing the user at this bridge (which 404s `/`).
   */
  verificationUri?: string
  /**
   * This bridge instance's stable identity, reported by `GET /discovery` and
   * bound into both MBP1 transcripts (§4.1, §6.2, §8). A routing hint only —
   * never a trust signal, and emitted verbatim however the shell configured it.
   */
  instanceId?: string
  /**
   * Rotates on every bridge start and is never persisted (§9.2). An NM ticket
   * minted under a previous generation downgrades to `unverified` rather than
   * aborting, which is also what keeps the per-process replay cache sound
   * across restarts.
   */
  serverGeneration?: string
  /** Reported verbatim by `GET /discovery` (§4.1). */
  appVersion?: string
  /**
   * The durable MBP1 credential store, shared by both session paths (§6.7, §8).
   * Typed as the real class rather than a narrowed interface so `tsc` checks it
   * against `PairCredentialIssuer` / `ReconnectCredentialAuthenticator` — those
   * exist for testability, and without a production assignment the compiler
   * would only ever have seen the fakes.
   */
  credentials?: Mbp1CredentialStore
  /**
   * Reads the immutable allowlist **only** — never the NM manifest set and
   * never the user registry, both of which admit user-added ids (§5).
   */
  isOfficialId?: (browser: Browser, id: string) => boolean
  /**
   * Queues the §7.1 approval prompt. The prompt controller reports a typed
   * refusal instead of manufacturing a handle when its own lifecycle cannot
   * safely publish one.
   */
  queueMbp1Dialog?: (args: PairDialogRequest) => PairingPromptEnqueueResult
  /**
   * Composition-root kill switch for the four Extension MBP1 routes. The
   * credential/projection management runtime may be prepared while this is
   * false, but `/discovery`, `/nonce`, `/pair`, and `/v1` remain indistinguishable
   * from unknown routes. Omission preserves the Desktop/test default.
   */
  extensionMbp1RoutesEnabled?: boolean
  /** Optional shell-owned raw request boundary for a prefixed/public MBP1
   * surface. It must make Host, path, method, query, proxy and admission
   * decisions without trusting framework-normalized URL fields. */
  extensionMbp1RoutePolicy?: (
    request: ExtensionMbp1RouteRequest
  ) => ExtensionMbp1RouteDecision
  /**
   * Synchronous shell-owned admission gate for an Origin-derived extension
   * identity. A `false` verdict (or a thrown error) refuses both MBP1 upgrade
   * routes before a nonce, rate-limit allowance, pre-authentication slot, or
   * session is consumed. Omission preserves the existing desktop behavior.
   */
  canAdmitExtensionIdentity?: (
    identity: ClientIdentity & { kind: 'extension' }
  ) => boolean
  /**
   * Fired once an extension session authenticates over MBP1 — first pair or
   * reconnect alike. It is the only remaining signal that an extension became
   * usable, now that `motrix/initialize` no longer mints anything: the shell's
   * paired-client list, revoke command, and revoke-kick all hang off it.
   */
  onExtensionAuthenticated?: (
    identity: ClientIdentity & { kind: 'extension' },
    /** The exact credential that authenticated this transport. */
    credentialId: string
  ) => void
}

export interface ExtensionMbp1RouteRequest {
  readonly rawTarget: string
  readonly method: string
  readonly transport: 'http' | 'websocket'
  readonly rawHeaders: readonly string[]
  readonly directPeerAddress: string | undefined
}

export type ExtensionMbp1RouteName = 'discovery' | 'nonce' | 'pair' | 'v1'

export type ExtensionMbp1RouteDecision =
  | { readonly kind: 'not-extension' }
  | { readonly kind: 'reject'; readonly status: 403 | 404 | 405 | 429 }
  | {
      readonly kind: 'route'
      readonly route: ExtensionMbp1RouteName
      readonly pairNonce?: string
      /** Idempotent capacity lease release, owned by the handshake lifetime. */
      readonly releaseAdmission?: () => void
    }

/**
 * The MBP1 options resolved as a unit. They arrive together or not at all: a
 * `/pair` session needs every one of them, so admitting a connection against a
 * half-configured surface would mean discovering the gap mid-handshake, with a
 * dialog possibly already on screen. One `null` check, one place to audit.
 */
interface Mbp1Wiring {
  instanceId: string
  serverGeneration: string
  appVersion: string
  credentials: Mbp1CredentialStore
  isOfficialId: (browser: Browser, id: string) => boolean
  queueMbp1Dialog: (args: PairDialogRequest) => PairingPromptEnqueueResult
}

function resolveMbp1Wiring(opts: BridgeServerOptions): Mbp1Wiring | null {
  const {
    instanceId,
    serverGeneration,
    appVersion,
    credentials,
    isOfficialId,
    queueMbp1Dialog,
  } = opts
  if (
    instanceId === undefined ||
    serverGeneration === undefined ||
    appVersion === undefined ||
    credentials === undefined ||
    isOfficialId === undefined ||
    queueMbp1Dialog === undefined
  ) {
    return null
  }
  // Assigning the REAL `Mbp1CredentialStore` here is what makes `tsc` check it
  // against the narrowed `PairCredentialIssuer` / `ReconnectCredentialAuthenticator`
  // the two session modules consume: those interfaces exist for testability, so
  // without a production assignment the compiler has only ever seen the fakes.
  return {
    instanceId,
    serverGeneration,
    appVersion,
    credentials,
    isOfficialId,
    queueMbp1Dialog,
  }
}

export interface BridgeSession {
  conn: BridgeConnection
  extensionId: string
  browser: Browser
  startedAt: number
  /** The AEAD stream under this session's MDXP connection; `usage` exposes the
   *  §10 outbound frame/block counters. */
  envelope: EnvelopeStream
}

const EXTENSION_REVOCATION_LEASE_BRAND: unique symbol = Symbol(
  'motrix.bridge.extension-revocation-lease'
)

/**
 * Process-local proof that this server has already entered the synchronous
 * revoke critical section for one verified Extension identity. The WeakMap
 * claim, not the structural fields, is authoritative at runtime.
 */
export interface ExtensionRevocationLease {
  readonly [EXTENSION_REVOCATION_LEASE_BRAND]: true
  readonly identity: ClientIdentity & { kind: 'extension' }
}

interface ExtensionRevocationClaim {
  readonly server: WebSocketBridgeServer
  readonly sessionKey: string
  readonly identity: ClientIdentity & { kind: 'extension' }
  phase: 'gated' | 'credentials-deleted' | 'completed'
  deletePromise: Promise<number> | null
  revokedCount: number | null
}

const extensionRevocationClaims = new WeakMap<
  object,
  ExtensionRevocationClaim
>()

/**
 * Optional per-method handlers registered via `setHandlers()`. `motrix/initialize`
 * and `system/ping` are wired by the server itself; these are the shell-supplied
 * domain handlers. Each receives validated params (the dispatcher validates at
 * the boundary) plus the transport-neutral `MdxpSessionContext`.
 */
export type MethodHandlers = {
  submitDownload?: (
    params: DownloadSubmitParams,
    ctx: MdxpSessionContext
  ) => Promise<{ taskId: string }>
  cancelDownload?: (
    params: DownloadCancelParams,
    ctx: MdxpSessionContext
  ) => Promise<void>
}

/**
 * v1 control-plane methods exposed over the extension WebSocket to a paired
 * session. The pairing dialog is the authorization gate — a paired extension
 * is trusted to manage downloads. Each is gated on `dispatcher.has()`, so a
 * shell that did not register the v1 methods simply omits them. `download/add`
 * is deliberately excluded (extensions add via `download/submit`); it stays
 * reachable only over the agent-facing unary `POST /mdxp` transport.
 */
const EXTENSION_WS_CONTROL_PLANE = [
  Methods.TaskList,
  Methods.TaskGet,
  Methods.TaskPause,
  Methods.TaskResume,
  Methods.TaskRemove,
  Methods.TaskReveal,
  Methods.StatsGet,
  Methods.EngineStatus,
] as const

const SSE_HEARTBEAT_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** §4: the candidate range the bridge tries in order before falling back. */
export const BRIDGE_CANDIDATE_PORTS = [
  16802, 16803, 16804, 16805, 16806,
] as const

/** §4: total pre-authentication connections admitted per route at once. */
const PRE_AUTH_CAP = 32
/** Let a maximum-size active §10 envelope through while replacing `ws`'s
 *  100 MiB default with a bound an unauthenticated peer cannot exceed. */
export const MAX_WEBSOCKET_PAYLOAD_BYTES = MAX_ENVELOPE_FRAME_BYTES
const REVOKE_NOTIFICATION_GRACE_MS = 50

/**
 * How long a `/pair` connection may stay pre-authenticated.
 *
 * It must EXCEED the §7.2 code lifetime (`CODE_LIFETIME_MS = 120 s`), not
 * undercut it: the user is reading a code off one screen and typing it into
 * another, and a shorter table deadline would kill legitimate pairings while
 * they type and make the session's own `expired` branch unreachable in
 * production. The code lifetime stays the real bound; this is the backstop for
 * a peer that upgrades and then says nothing at all.
 */
const PAIR_PRE_AUTH_DEADLINE_MS = 150_000

/**
 * How long a `/v1` connection may stay pre-authenticated. §8's own 10 s
 * protocol deadline fires first and produces a proper `authFailed`; this is
 * deliberately a little longer so the uniform failure — not a bare socket
 * close — is what a real client sees.
 */
const RECONNECT_PRE_AUTH_DEADLINE_MS = 15_000

/** RFC 6455 close codes used when the envelope stream refuses a frame (§10).
 *  Exported so tests can assert on the exact wire value rather than
 *  duplicating it as an untethered magic number. */
export const WS_CLOSE_PROTOCOL_ERROR = 1002
export const WS_CLOSE_INTERNAL_ERROR = 1011
/**
 * §10 usage-bound closure (`EnvelopeLimitError`): a direction reached its
 * frame- or block-count bound and this connection MUST be re-established via
 * reconnect (§8) with fresh keys. Neither 1002 nor 1011 fits — this is not
 * the peer breaking §10, and it is not this process malfunctioning; it is
 * the backstop for the exact condition §10 requires to happen before either
 * bound is exceeded. Sending 1011 here (as an internal error) told a
 * conforming client this process crashed, when the designed response is to
 * silently reconnect instead of surfacing an error to the user.
 *
 * RFC 6455 §7.4.2 reserves 1000-2999 for the protocol/extensions/IANA-
 * registered schemes and 3000-3999 for IANA-registered libraries — using
 * either for a code with a meaning specific to this application would
 * misuse the registry the same way 1002/1011 would. 4000-4999 is reserved
 * for exactly this: private use "by prior agreement between WebSocket
 * applications", which MBP1 endpoints are. `4001` is arbitrary within that
 * range; what matters is only that it differs from 1002/1011 so a client can
 * branch on it.
 */
export const WS_CLOSE_ENVELOPE_USAGE_LIMIT = 4001

/** Maps an envelope-stream fault to the RFC 6455 close code the wiring sends. */
function closeCodeForEnvelopeFault(kind: EnvelopeStreamFaultKind): number {
  switch (kind) {
    case 'peer-violation':
      return WS_CLOSE_PROTOCOL_ERROR
    case 'usage-limit':
      return WS_CLOSE_ENVELOPE_USAGE_LIMIT
    case 'internal':
      return WS_CLOSE_INTERNAL_ERROR
  }
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * `host[:port]`, with an IPv6 literal in brackets (RFC 7230 §5.4). Used only
 * to split a Host header; `isLoopbackHost` above validates a *bind* host and
 * carries no port, so the two are not interchangeable.
 */
const HOST_HEADER = /^(?:\[([0-9a-fA-F:]+)\]|([^:[\]]+)):(\d{1,5})$/

/**
 * §4.3: while bound to loopback, every route and upgrade must reject a `Host`
 * that is not `127.0.0.1[:port]`, `localhost[:port]`, or `[::1][:port]`. That
 * closes DNS rebinding — a page on an attacker's domain can reach the loopback
 * port, but the browser sends the attacker's hostname in `Host`.
 *
 * The port is REQUIRED and must equal the port actually bound. On loopback
 * there is no proxy rewriting anything and every real client sends the port it
 * connected to, so exact matching costs nothing and additionally refuses a
 * same-host confused deputy pointed at a different port. A `Host` with no port
 * implies 80, which this server never binds.
 */
function isLoopbackHostHeader(
  rawHost: string | undefined,
  boundPort: number
): boolean {
  if (!rawHost) {
    return false
  }
  const parts = HOST_HEADER.exec(rawHost)
  if (!parts) {
    return false
  }
  const name = (parts[1] ?? parts[2] ?? '').toLowerCase()
  return LOOPBACK_HOSTS.has(name) && Number(parts[3]) === boundPort
}

/**
 * The §5 verified peer, derived from the upgrade `Origin` header and nothing
 * else — never a query parameter, never a self-reported message field.
 *
 * `extensionId` is the origin's host component uniformly. On Chromium that IS
 * the extension id, and `pair-session.ts` separately enforces
 * `Origin host === claimedExtensionId`. On Firefox it is the `moz-extension`
 * UUID rather than the Gecko id: the Gecko id is self-reported and
 * unverifiable there, so keying the live-session map by it would let one
 * extension evict another's session simply by claiming its id. Showing the
 * claimed id is a UI concern, not a session-identity one.
 */
interface ExtensionPeer {
  browser: Browser
  extensionId: string
  origin: string
}

function parseExtensionOrigin(origin: string): ExtensionPeer | null {
  const browser: Browser | null = origin.startsWith('chrome-extension://')
    ? 'chromium'
    : origin.startsWith('moz-extension://')
      ? 'firefox'
      : null
  if (browser === null) {
    return null
  }
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return null
  }
  if (host === '') {
    return null
  }
  return { browser, extensionId: host, origin }
}

function normalizeRevocationIdentity(
  identity: ClientIdentity & { kind: 'extension' }
): ClientIdentity & { kind: 'extension' } {
  if (
    identity?.kind !== 'extension' ||
    (identity.browser !== 'chromium' && identity.browser !== 'firefox') ||
    typeof identity.extensionId !== 'string' ||
    identity.extensionId.length === 0 ||
    identity.extensionId.length > 256
  ) {
    throw new Error('extension revocation identity rejected')
  }
  const scheme =
    identity.browser === 'chromium' ? 'chrome-extension' : 'moz-extension'
  const parsed = parseExtensionOrigin(`${scheme}://${identity.extensionId}`)
  if (
    parsed === null ||
    parsed.browser !== identity.browser ||
    parsed.extensionId !== identity.extensionId
  ) {
    throw new Error('extension revocation identity rejected')
  }
  return Object.freeze({
    kind: 'extension' as const,
    browser: identity.browser,
    extensionId: identity.extensionId,
  })
}

/** A `/pair` connection held in the pre-authentication table (§4, §7.3). */
interface PairPreAuthEntry {
  readonly ws: WebSocket
  /** Verified Origin-derived identity used for revoke-critical cancellation. */
  readonly sessionKey: string
  /** Assigned immediately after admission; `null` only inside `admit` itself. */
  session: PairSession | null
  /** Whether an approval dialog was actually shown for this session — the one
   *  §7.3 outcome flag `PairSession` does not expose. */
  queuedDialog: boolean
  confirmed: boolean
  /** §7.3's counter must move exactly once per session, whichever terminal
   *  path (success, deadline, close) gets there first. */
  outcomeRecorded: boolean
  readonly releaseAdmission: () => void
}

/** A `/v1` connection held in the pre-authentication table (§4, §8). */
interface ReconnectPreAuthEntry {
  readonly ws: WebSocket
  /** Verified Origin-derived identity used for revoke-critical cancellation. */
  readonly sessionKey: string
  session: ReconnectSession | null
  readonly releaseAdmission: () => void
}

export class WebSocketBridgeServer {
  private http: HttpServer
  private wss: WebSocketServer
  private readonly mbp1: Mbp1Wiring | null
  private readonly nonces = new NonceService()
  private readonly floodControl = new PairFloodControl()
  /**
   * §9.2's one-shot ticket store, one instance per bridge start. Its scope is
   * this process, which is sound only because `serverGeneration` also rotates
   * per start: a ticket replayed into a later process downgrades to
   * `unverified`, which is what presenting no ticket yields anyway.
   */
  private readonly replay = new TicketReplayCache()
  /** §8's per-origin + global reconnect throttle. Deliberately separate from
   *  `floodControl`: see `mbp1/reconnect-rate-limit.ts` for why sharing
   *  counters between the two would be a bug in both directions. */
  private readonly reconnectRate = new ReconnectRateLimit()
  private readonly preAuthPair: PreAuthTable<PairPreAuthEntry>
  private readonly preAuthReconnect: PreAuthTable<ReconnectPreAuthEntry>
  /** The host and port actually bound, for the §4.3 Host guard. */
  private boundHost: string | null = null
  private boundPort = 0
  private sessions = new Map<string, BridgeSession>()
  /** Session keys in the durable-revocation critical section. Matching
   *  pre-auth sessions are cancelled, new upgrades are refused, and any MBP1
   *  flow that still finishes concurrently is refused again at adoption. */
  private readonly revokingExtensionKeys = new Map<
    string,
    ExtensionRevocationLease
  >()
  // Open SSE connections (GET /mdxp/events) → their heartbeat timer + the
  // authenticated caller identity. The CLI `watch` firehose; a global
  // (non-session) push of $/task/* + $/stats. The identity is retained so a
  // pairing revoke/rotation can close exactly the matching streams — a token
  // checked only at connect time would otherwise leak the firehose for the
  // life of the connection.
  private sseClients = new Map<
    ServerResponse,
    { heartbeat: NodeJS.Timeout; identity: ClientIdentity }
  >()
  private readonly dispatcher = new MdxpDispatcher()
  private readonly requestWork = new AsyncWorkTracker()
  private stopPromise: Promise<void> | null = null

  constructor(private opts: BridgeServerOptions) {
    this.mbp1 = resolveMbp1Wiring(opts)
    // `PreAuthTable` holds unauthenticated connections OUT of `this.sessions`,
    // which is what makes "a `/pair` attempt cannot evict a live authenticated
    // session" true by construction rather than by discipline (§4).
    this.preAuthPair = new PreAuthTable<PairPreAuthEntry>({
      cap: PRE_AUTH_CAP,
      deadlineMs: PAIR_PRE_AUTH_DEADLINE_MS,
      onDeadline: (entry) => this.expirePairPreAuth(entry),
    })
    this.preAuthReconnect = new PreAuthTable<ReconnectPreAuthEntry>({
      cap: PRE_AUTH_CAP,
      deadlineMs: RECONNECT_PRE_AUTH_DEADLINE_MS,
      onDeadline: (entry) => {
        try {
          entry.session?.dispose('timeout')
        } finally {
          entry.releaseAdmission()
          // `dispose` deliberately does NOT close the socket — both session
          // modules read it as "the peer is already gone, or the wiring is
          // closing it" — so the wiring must close, or a peer that upgrades and
          // then says nothing holds its slot until the process exits.
          entry.ws.close()
        }
      },
    })
    // `motrix/initialize` is always available; the shell registers domain
    // methods (download/*) later via setHandlers().
    this.dispatcher.register(
      'motrix/initialize',
      InitializeParamsSchema,
      createInitializeHandler({
        motrixVersion: opts.motrixVersion,
        runtime: opts.runtime,
        ffmpegAvailable: opts.ffmpegAvailable,
        supportsTaskReveal: () => this.dispatcher.has(Methods.TaskReveal),
      })
    )
    // Revocation/rotation must reach live SSE firehose streams, not just future
    // requests. The server owns the connections AND is the token trust boundary,
    // so it enforces the cutoff itself — driven by the authoritative pairing
    // events, every revoke path (desktop IPC, server RPC, future auto-expiry) is
    // covered without each call site remembering to close streams. `pairing` is
    // created per bridge bootstrap, 1:1 with this server, so these listeners do
    // not accumulate across re-enable cycles. WS sessions are NOT closed here:
    // their graceful notify-then-dispose is shell policy (`main/bridge`).
    opts.pairing.on('revoked', ({ identity }) =>
      this.closeSseForIdentity(identity)
    )
    opts.pairing.on('rotated', ({ identity }) =>
      this.closeSseForIdentity(identity)
    )
    this.http = createServer()
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    })

    this.http.on('upgrade', (req, socket, head) => {
      const route = this.resolveExtensionMbp1Route(req, 'websocket')
      if (route.kind === 'not-extension') return this.reject(socket, 404)
      if (route.kind === 'reject') {
        return this.reject(socket, route.status === 405 ? 404 : route.status)
      }
      if (route.route !== 'pair' && route.route !== 'v1') {
        route.releaseAdmission?.()
        return this.reject(socket, 404)
      }
      const protoHeader = req.headers['sec-websocket-protocol'] ?? ''

      // §5: the verified origin, and every identity fact taken from it, comes
      // from this header alone.
      const peer = parseExtensionOrigin(req.headers.origin ?? '')
      if (peer === null) {
        route.releaseAdmission?.()
        return this.reject(socket, 401)
      }
      if (
        !String(protoHeader)
          .split(',')
          .map((s) => s.trim())
          .includes('motrix-bridge.v1')
      ) {
        route.releaseAdmission?.()
        return this.reject(socket, 401)
      }
      const mbp1 = this.mbp1
      if (mbp1 === null || this.opts.extensionMbp1RoutesEnabled === false) {
        route.releaseAdmission?.()
        // Both routes speak MBP1 and nothing else (§4). A shell that has not
        // wired it has no extension WebSocket surface at all — the same 404 an
        // unknown path gets, so the response says nothing about which it was.
        return this.reject(socket, 404)
      }

      const identity: ClientIdentity & { kind: 'extension' } = {
        kind: 'extension',
        browser: peer.browser,
        extensionId: peer.extensionId,
      }

      if (route.route === 'pair') {
        if (!this.canAdmitExtensionIdentity(identity)) {
          route.releaseAdmission?.()
          return this.reject(socket, 401)
        }
        return this.handleMbp1PairUpgrade(
          req,
          socket,
          head,
          route.pairNonce ?? '',
          peer,
          identity,
          mbp1,
          route.releaseAdmission ?? (() => undefined)
        )
      }
      if (route.route === 'v1') {
        if (!this.canAdmitExtensionIdentity(identity)) {
          route.releaseAdmission?.()
          return this.reject(socket, 401)
        }
        return this.handleMbp1ReconnectUpgrade(
          req,
          socket,
          head,
          peer,
          identity,
          mbp1,
          route.releaseAdmission ?? (() => undefined)
        )
      }
      route.releaseAdmission?.()
      this.reject(socket, 404)
    })

    this.http.on('request', (req, res) => {
      const extensionRoute = this.resolveExtensionMbp1Route(req, 'http')
      if (extensionRoute.kind === 'reject') {
        res.writeHead(extensionRoute.status)
        res.end()
        return
      }
      // GET /discovery — §4.1. Unauthenticated, replayable, and explicitly a
      // routing hint rather than a trust signal: an extension may pin a port
      // only after a mutually-authenticated MBP1 session on it. `instanceId`
      // is emitted verbatim, whatever the shell configured.
      if (
        extensionRoute.kind === 'route' &&
        extensionRoute.route === 'discovery'
      ) {
        const mbp1 = this.mbp1
        if (mbp1 === null || this.opts.extensionMbp1RoutesEnabled === false) {
          res.writeHead(404)
          res.end()
          return
        }
        writeJson(res, 200, {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: mbp1.instanceId,
          appVersion: mbp1.appVersion,
          runtime: this.opts.runtime,
          extensionPairing: { protocol: 'mbp1', versions: [1] },
          applicationProtocols: { mdxp: ['1.0'] },
        })
        extensionRoute.releaseAdmission?.()
        return
      }
      // POST /nonce — §4.2. The former GET route is gone and now falls through
      // to the bare 404 below, which is what the spec requires.
      if (extensionRoute.kind === 'route' && extensionRoute.route === 'nonce') {
        // `/nonce` is part of the same Extension-only MBP1 surface as
        // `/discovery`, `/pair`, and `/v1`. A shell which did not provide the
        // complete MBP1 wiring must expose none of the four routes; issuing a
        // nonce here would otherwise create a misleading partial surface and
        // violate the dependency-omission gate.
        if (
          this.mbp1 === null ||
          this.opts.extensionMbp1RoutesEnabled === false
        ) {
          res.writeHead(404)
          res.end()
          extensionRoute.releaseAdmission?.()
          return
        }
        this.handleNonceIssue(req, res)
        extensionRoute.releaseAdmission?.()
        return
      }
      if (extensionRoute.kind === 'route') {
        extensionRoute.releaseAdmission?.()
        res.writeHead(404)
        res.end()
        return
      }
      // §4.3 DNS-rebinding guard for every non-Extension route.
      if (!this.hostHeaderAllowed(req)) {
        writeJson(res, 403, {
          error: { code: ErrorCodes.PermissionDenied, message: 'forbidden' },
        })
        return
      }
      let pathname: string
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      } catch {
        res.writeHead(404)
        res.end()
        return
      }
      // GET /mdxp/events — Server-Sent Events firehose for CLI/agents (watch).
      if (req.method === 'GET' && pathname === '/mdxp/events') {
        this.handleSseConnect(req, res)
        return
      }
      // POST /mdxp — stateless unary JSON-RPC for same-machine CLI/agents.
      if (req.method === 'POST' && pathname === '/mdxp') {
        this.requestWork
          .run(() => this.handleUnaryMdxp(req, res))
          .catch(() => {
            if (!res.headersSent) {
              writeJsonRpc(res, 500, {
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: ErrorCodes.InternalError,
                  message: 'internal error',
                },
              })
            }
          })
        return
      }
      // POST /mdxp/pair/request — device-code pairing (Spec 7b). UN-authenticated
      // by design: a fresh CLI has no token. DeviceCodeService rate-limits and
      // TTL-bounds; approval in the Motrix UI is the security gate.
      if (req.method === 'POST' && pathname === '/mdxp/pair/request') {
        this.requestWork
          .run(() => this.handlePairRequest(req, res))
          .catch(() => {
            if (!res.headersSent) {
              writeJson(res, 500, {
                error: {
                  code: ErrorCodes.InternalError,
                  message: 'internal error',
                },
              })
            }
          })
        return
      }
      // POST /mdxp/pair/poll — the CLI polls for the decision/token. POST (not
      // GET) so the requestId travels in the body, NOT the URL — keeping the
      // poll capability out of access logs / proxy history. UN-authenticated:
      // the high-entropy requestId IS the capability; the token is delivered
      // one-time (DeviceCodeService).
      if (req.method === 'POST' && pathname === '/mdxp/pair/poll') {
        this.requestWork
          .run(() => this.handlePairPoll(req, res))
          .catch(() => {
            if (!res.headersSent) {
              writeJson(res, 500, {
                error: {
                  code: ErrorCodes.InternalError,
                  message: 'internal error',
                },
              })
            }
          })
        return
      }
      res.writeHead(404)
      res.end()
    })
  }

  /**
   * Bind the bridge HTTP/WS server. Defaults to loopback + an ephemeral port
   * (the desktop's behavior — `endpoint.json` carries the chosen port). The
   * server shell (Spec 6) passes a fixed host/port. Binding a NON-loopback host
   * requires a configured `localToken` — fail closed so we never stand up an
   * unauthenticated LAN surface. (Remote token issuance is Spec 7.)
   */
  async start(host = '127.0.0.1', port = 0): Promise<number> {
    this.assertBindAllowed(host)
    const bound = await this.listenOnce(host, port)
    this.recordBinding(host, bound)
    return bound
  }

  /**
   * Bind the first free port of `ports`, in order, falling back to an
   * ephemeral one (§4). `degraded` reports that fallback, so a caller can tell
   * "an extension's port pin will still work" from "every candidate was taken
   * and a sweep is required".
   *
   * Deliberately additive rather than a replacement for {@link start}: the
   * server shell binds a configured host and port from its operator's config
   * and must never walk off it.
   */
  async startOnFirstFree(
    host: string,
    ports: readonly number[]
  ): Promise<{ port: number; degraded: boolean }> {
    // Hoisted out of the loop: the guard is about the host, not the port.
    this.assertBindAllowed(host)
    for (const candidate of ports) {
      try {
        const bound = await this.listenOnce(host, candidate)
        this.recordBinding(host, bound)
        return { port: bound, degraded: false }
      } catch (err) {
        // Only a taken port advances the scan. EACCES, EADDRNOTAVAIL, and
        // friends are configuration faults that the next port would hit too,
        // and swallowing them would turn a misconfiguration into a silent
        // ephemeral bind on an address nobody expects.
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw err
        }
      }
    }
    const bound = await this.listenOnce(host, 0)
    this.recordBinding(host, bound)
    return { port: bound, degraded: true }
  }

  /** Binding a NON-loopback host requires a configured `localToken` — fail
   *  closed so we never stand up an unauthenticated LAN surface. */
  private assertBindAllowed(host: string): void {
    if (!isLoopbackHost(host) && !this.opts.localToken) {
      throw new Error(
        `refusing to bind the MDXP bridge to non-loopback host "${host}" without a token`
      )
    }
  }

  /**
   * One `listen` attempt, resolving the bound port or rejecting with the raw
   * error. The error listener is removed on BOTH outcomes: re-`listen`ing the
   * same `HttpServer` after a failed attempt would otherwise leave the earlier
   * attempt's rejection handler armed, so a later error would settle an
   * already-settled promise or abort the whole scan.
   */
  private listenOnce(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.http.removeListener('error', onError)
        reject(err)
      }
      this.http.once('error', onError)
      this.http.listen(port, host, () => {
        this.http.removeListener('error', onError)
        const addr = this.http.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('failed to bind'))
      })
    })
  }

  private recordBinding(host: string, port: number): void {
    this.boundHost = host
    this.boundPort = port
  }

  private resolveExtensionMbp1Route(
    req: IncomingMessage,
    transport: 'http' | 'websocket'
  ): ExtensionMbp1RouteDecision {
    const policy = this.opts.extensionMbp1RoutePolicy
    if (policy !== undefined) {
      try {
        return policy({
          rawTarget: req.url ?? '/',
          method: req.method ?? '',
          transport,
          rawHeaders: req.rawHeaders,
          directPeerAddress: req.socket.remoteAddress,
        })
      } catch {
        return { kind: 'reject', status: 404 }
      }
    }

    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return { kind: 'reject', status: 404 }
    }
    const route =
      url.pathname === '/discovery'
        ? 'discovery'
        : url.pathname === '/nonce'
          ? 'nonce'
          : url.pathname === '/pair'
            ? 'pair'
            : url.pathname === '/v1'
              ? 'v1'
              : null
    if (route === null) return { kind: 'not-extension' }
    if (!this.hostHeaderAllowed(req)) return { kind: 'reject', status: 403 }
    if (
      (transport === 'http' && route !== 'discovery' && route !== 'nonce') ||
      (transport === 'websocket' && route !== 'pair' && route !== 'v1')
    ) {
      return { kind: 'reject', status: 404 }
    }
    const expectedMethod = route === 'nonce' ? 'POST' : 'GET'
    if (req.method !== expectedMethod) return { kind: 'reject', status: 404 }
    return route === 'pair'
      ? { kind: 'route', route, pairNonce: url.searchParams.get('nonce') ?? '' }
      : { kind: 'route', route }
  }

  /**
   * §4.3, scoped to a loopback bind. The non-loopback server shell keeps its
   * existing token + reverse-proxy model and is explicitly out of MBP1 scope;
   * applying the rule there would 403 every request it serves, since a proxied
   * request legitimately carries the operator's public hostname.
   */
  private hostHeaderAllowed(req: IncomingMessage): boolean {
    if (this.boundHost === null || !isLoopbackHost(this.boundHost)) {
      return true
    }
    return isLoopbackHostHeader(req.headers.host, this.boundPort)
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise

    // Gate every MDXP dispatcher path before touching transports. Closing
    // sockets prevents new ingress; the tracker below retains only handlers
    // accepted before this point.
    const acceptedHandlers = this.requestWork.stopAndDrain()
    this.stopPromise = this.closeTransportsAndDrain(acceptedHandlers)
    return this.stopPromise
  }

  private async closeTransportsAndDrain(
    acceptedHandlers: Promise<void>
  ): Promise<void> {
    // Pre-authentication connections never enter `sessions`, so the dispose
    // loop below would not touch them. Cancel their deadline timers here or
    // they fire `onDeadline` into a stopped server — `unref()` keeps them from
    // holding the process open but does not stop them running while it lives.
    // Their sockets die with the `wss.clients` terminate loop further down.
    for (const entry of this.preAuthPair.takeWhere(() => true)) {
      entry.releaseAdmission()
    }
    for (const entry of this.preAuthReconnect.takeWhere(() => true)) {
      entry.releaseAdmission()
    }
    for (const session of this.sessions.values()) {
      session.conn.dispose()
    }
    this.sessions.clear()
    // End open SSE streams first — otherwise http.close() hangs waiting for the
    // keep-alive connections to drain.
    for (const [res, { heartbeat }] of this.sseClients) {
      clearInterval(heartbeat)
      res.end()
    }
    this.sseClients.clear()
    // Force-close every live WebSocket before closing the HTTP server.
    // `conn.dispose()` only detaches listeners — it does NOT close the socket —
    // and `wss.close()` (noServer mode) does NOT terminate established client
    // sockets either. `http.close()`'s callback fires only once ALL connections
    // have ended, so an upgraded WebSocket the extension keeps open would block
    // it forever. Because app quit awaits bridge stop, that hang is exactly why
    // the first Cmd+Q appeared to do nothing. terminate() is immediate; the
    // peer is going away regardless.
    for (const ws of this.wss.clients) {
      ws.terminate()
    }
    await new Promise<void>((resolve) => {
      // In noServer mode close() reports "not running" when bind itself
      // failed. Supply a callback so that benign rollback condition is
      // consumed instead of becoming an unhandled `error` event.
      this.wss.close(() => {})
      this.http.close(() => resolve())
      // Belt-and-suspenders: destroy any straggler connection (a half-open
      // keep-alive, an SSE stream mid-drain, a socket that escaped client
      // tracking) so the close callback always fires. Node 18.2+ / Electron 41.
      this.http.closeAllConnections()
    })
    await acceptedHandlers
  }

  /**
   * Issue a one-shot pairing nonce directly, bypassing the `POST /nonce` route
   * (§4.2). A thin façade over {@link NonceService}, kept so in-process callers
   * need not speak HTTP to themselves.
   *
   * Throws when a cap is hit rather than retrying: callers expect a string, and
   * silently retrying past a breached cap would defeat the very limit that was
   * reached.
   */
  issuePairNonce(): string {
    const issued = this.nonces.issue(null)
    if ('error' in issued) {
      throw new Error('pairing nonce issuance is rate-limited')
    }
    return issued.nonce
  }

  /** Register the shell's domain handlers. Call BEFORE the first connection. */
  setHandlers(handlers: MethodHandlers): void {
    if (handlers.submitDownload) {
      this.dispatcher.register(
        'download/submit',
        DownloadSubmitParamsSchema,
        handlers.submitDownload
      )
    }
    if (handlers.cancelDownload) {
      const cancel = handlers.cancelDownload
      this.dispatcher.register(
        'download/cancel',
        DownloadCancelParamsSchema,
        async (params, ctx) => {
          await cancel(params, ctx)
          return { ok: true }
        }
      )
    }
  }

  /**
   * Register the v1 READ methods (`task/list`, `task/get`, `stats/get`,
   * `engine/status`) on the dispatcher, backed by the shell's managers. Call
   * BEFORE start(), like setHandlers(). These methods are reachable both via
   * the unary `POST /mdxp` transport (agent-facing) AND — for the methods in
   * `EXTENSION_WS_CONTROL_PLANE` — over the extension WebSocket for a paired
   * session. `download/add` remains `POST /mdxp` only.
   */
  registerReadMethods(deps: ReadHandlerDeps): void {
    registerReadHandlers(this.dispatcher, deps)
  }

  /**
   * Register the v1 WRITE methods (`task/pause`, `task/resume`, `task/remove`,
   * optional `task/reveal`, `download/add`) on the dispatcher. Call BEFORE
   * start(). Pause/resume/remove are available on both unary and paired WS;
   * `task/reveal` is deliberately paired-WS only, while `download/add` is unary
   * only (extensions add via `download/submit`).
   */
  registerWriteMethods(deps: WriteHandlerDeps): void {
    registerWriteHandlers(this.dispatcher, deps)
  }

  /**
   * Push an SSE event to every connected `GET /mdxp/events` client (best-effort;
   * a broken socket is dropped, not retried). The bootstrap subscribes the core
   * EventBus and calls this with MDXP-shaped `$/task/*` / `$/stats` payloads.
   */
  broadcastStreamEvent(event: string, data: unknown): void {
    if (this.sseClients.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.sseClients.keys()) {
      try {
        res.write(frame)
      } catch {
        // Drop a broken stream; req 'close' will clean it up.
      }
    }
  }

  /**
   * Resolve the agent-surface Bearer credential for `POST /mdxp` + SSE. Accepts
   * EITHER the machine-owner `localToken` (local same-host access) OR a paired
   * `cli` token minted by device-code pairing (the remote/NAS path). Extension
   * tokens are NOT admitted here — extensions use the WebSocket `/v1` route —
   * and any unknown/non-cli token is rejected (fail closed). Returns the calling
   * identity, or null when unauthenticated.
   */
  private resolveBearer(authHeader: string | undefined): ClientIdentity | null {
    const raw = authHeader ?? ''
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : ''
    if (!token) return null
    if (token === this.opts.localToken) {
      return { kind: 'cli', id: 'local' }
    }
    const paired = this.opts.pairing.findByToken(token)
    if (paired && paired.identity.kind === 'cli') {
      this.opts.pairing.markActive(paired.identity)
      return paired.identity
    }
    return null
  }

  private handleSseConnect(req: IncomingMessage, res: ServerResponse): void {
    const identity = this.resolveBearer(req.headers.authorization)
    if (!identity) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { code: ErrorCodes.PermissionDenied, message: 'unauthorized' },
        })
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    // Heartbeat keeps intermediaries from closing an idle stream. unref() so a
    // lingering stream never keeps the process alive.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        // ignore; close handler removes it
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref()
    this.sseClients.set(res, { heartbeat, identity })
    const cleanup = () => {
      clearInterval(heartbeat)
      this.sseClients.delete(res)
    }
    req.on('close', cleanup)
    // Defensive: a socket error on a long-lived stream must not crash the
    // process as an unhandled 'error' event.
    res.on('error', cleanup)
  }

  /**
   * Close every open SSE stream authenticated as `identity` (matched by
   * {@link clientKey}). Called on pairing revoke/rotation so a dropped token
   * cannot keep reading the `$/task/*` + `$/stats` firehose. No-op for an
   * identity with no live stream (e.g. the machine-owner `localToken`, which is
   * never revoked through pairing).
   */
  private closeSseForIdentity(identity: ClientIdentity): void {
    const target = clientKey(identity)
    for (const [res, { heartbeat, identity: client }] of this.sseClients) {
      if (clientKey(client) !== target) continue
      clearInterval(heartbeat)
      this.sseClients.delete(res)
      try {
        res.end()
      } catch {
        // Already torn down; the connection's own close handler is harmless.
      }
    }
  }

  /** Find an active session by `${browser}:${extensionId}` key. */
  getSession(sessionKey: string): BridgeSession | undefined {
    return this.sessions.get(sessionKey)
  }

  /**
   * Enter the verified-identity revoke gate synchronously. This method performs
   * every in-memory authorization cutoff before returning: live MDXP is marked
   * unauthorized, admitted pair/reconnect handshakes are cancelled, and later
   * upgrades/adoption observe the gate. It performs no I/O and is therefore the
   * first operation a shell must call for an operator revoke.
   *
   * Re-entry for the same identity returns the existing nominal lease so an
   * operator retry can resume a durable deletion that previously failed. The
   * gate is released only by {@link completeExtensionRevocation}.
   */
  beginExtensionRevocation(
    identity: ClientIdentity & { kind: 'extension' }
  ): ExtensionRevocationLease {
    const normalized = normalizeRevocationIdentity(identity)
    const sessionKey = makeSessionKey(
      normalized.browser,
      normalized.extensionId
    )
    const existing = this.revokingExtensionKeys.get(sessionKey)

    // Repeat the cutoff even for a resumed attempt: a test double or future
    // transport must not be able to attach work between retry calls.
    this.sessions.get(sessionKey)?.conn.revokeAuthorization()
    this.cancelPreAuthForSessionKey(sessionKey)
    if (existing !== undefined) return existing

    const lease = { identity: normalized } as ExtensionRevocationLease
    Object.defineProperty(lease, EXTENSION_REVOCATION_LEASE_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    })
    Object.freeze(lease)
    extensionRevocationClaims.set(lease, {
      server: this,
      sessionKey,
      identity: normalized,
      phase: 'gated',
      deletePromise: null,
      revokedCount: null,
    })
    this.revokingExtensionKeys.set(sessionKey, lease)
    return lease
  }

  /**
   * Durably remove every credential for a gated identity, then notify and
   * close its live session. A failed write closes the transport without a
   * trusted revoke notification and deliberately retains the deny gate.
   * Concurrent/repeated calls share one deletion attempt; a failed attempt may
   * be retried with the same lease.
   */
  deleteExtensionAuthorization(
    lease: ExtensionRevocationLease,
    reason: string
  ): Promise<number> {
    const claim = this.requireExtensionRevocationClaim(lease)
    if (claim.phase === 'completed') {
      return Promise.reject(new Error('extension revocation lease rejected'))
    }
    if (claim.phase === 'credentials-deleted') {
      return Promise.resolve(claim.revokedCount ?? 0)
    }
    if (claim.deletePromise !== null) return claim.deletePromise

    const operation = this.deleteExtensionAuthorizationOnce(claim, reason)
    claim.deletePromise = operation
    void operation.catch(() => {
      if (claim.phase === 'gated' && claim.deletePromise === operation) {
        claim.deletePromise = null
      }
    })
    return operation
  }

  /** Release a revoke gate only after credential deletion and every durable
   * shell projection/marker cleanup have succeeded. */
  completeExtensionRevocation(lease: ExtensionRevocationLease): void {
    const claim = this.requireExtensionRevocationClaim(lease)
    if (claim.phase !== 'credentials-deleted') {
      throw new Error('extension revocation is incomplete')
    }
    if (this.revokingExtensionKeys.get(claim.sessionKey) !== lease) {
      throw new Error('extension revocation lease rejected')
    }
    claim.phase = 'completed'
    claim.deletePromise = null
    this.revokingExtensionKeys.delete(claim.sessionKey)
    extensionRevocationClaims.delete(lease)
  }

  /** Close any still-live transport while deliberately retaining the deny
   * gate. Used when the shell cannot persist its pending-revoke marker. */
  retainFailedExtensionRevocation(lease: ExtensionRevocationLease): void {
    const claim = this.requireExtensionRevocationClaim(lease)
    this.closeExtensionSessionNow(claim.sessionKey)
  }

  /**
   * Backward-compatible all-in-one façade for callers that have no separate
   * durable projection. New shell code must use begin → durable marker →
   * delete → projection cleanup → complete so no pre-marker await window
   * exists.
   */
  async revokeExtensionAccess(
    identity: ClientIdentity & { kind: 'extension' },
    reason: string
  ): Promise<number> {
    const lease = this.beginExtensionRevocation(identity)
    const revoked = await this.deleteExtensionAuthorization(lease, reason)
    this.completeExtensionRevocation(lease)
    return revoked
  }

  private async deleteExtensionAuthorizationOnce(
    claim: ExtensionRevocationClaim,
    reason: string
  ): Promise<number> {
    const mbp1 = this.mbp1
    if (mbp1 === null) {
      claim.revokedCount = 0
      claim.phase = 'credentials-deleted'
      return 0
    }
    try {
      const revoked = await mbp1.credentials.revokeExtensionIdentity(
        claim.identity.browser,
        claim.identity.extensionId
      )
      claim.revokedCount = revoked
      claim.phase = 'credentials-deleted'
      await this.disconnectExtensionSession(claim.identity, reason)
      return revoked
    } catch (error) {
      // The old key may still be durable. Close without a trusted revoke
      // notice, keep the identity gated, and allow an explicit retry to reuse
      // this same lease.
      this.closeExtensionSessionNow(claim.sessionKey)
      throw error
    }
  }

  private requireExtensionRevocationClaim(
    lease: ExtensionRevocationLease
  ): ExtensionRevocationClaim {
    const claim = extensionRevocationClaims.get(lease)
    if (
      claim === undefined ||
      claim.server !== this ||
      this.revokingExtensionKeys.get(claim.sessionKey) !== lease
    ) {
      throw new Error('extension revocation lease rejected')
    }
    return claim
  }

  /**
   * End every handshake for this verified Origin before durable revocation
   * yields. Otherwise a `/pair` admitted immediately before revoke could
   * finish afterwards and mint/adopt a replacement credential.
   */
  private cancelPreAuthForSessionKey(sessionKey: string): void {
    for (const entry of this.preAuthPair.takeWhere(
      (candidate) => candidate.sessionKey === sessionKey
    )) {
      entry.releaseAdmission()
      try {
        entry.session?.dispose('access-revoked')
      } catch {
        // The authorization cutoff and durable delete must survive a broken
        // dialog/flood-control teardown callback.
      }
      try {
        this.recordPairOutcome(entry)
      } catch {
        // Outcome accounting is secondary to credential removal.
      }
      try {
        entry.ws.close()
      } catch {
        // Already torn down; its close handler is idempotent.
      }
    }
    for (const entry of this.preAuthReconnect.takeWhere(
      (candidate) => candidate.sessionKey === sessionKey
    )) {
      entry.releaseAdmission()
      try {
        entry.session?.dispose('access-revoked')
      } catch {
        // Durable credential removal remains the fail-closed boundary.
      }
      try {
        entry.ws.close()
      } catch {
        // Already torn down; its close handler is idempotent.
      }
    }
  }

  private async disconnectExtensionSession(
    identity: ClientIdentity & { kind: 'extension' },
    reason: string
  ): Promise<void> {
    const sessionKey = makeSessionKey(identity.browser, identity.extensionId)
    const notified = this.sessions.get(sessionKey)
    if (!notified) return

    notified.conn.revokeAuthorization()

    try {
      notified.conn.sendNotification(Notifications.PairRevoked, { reason })
    } catch {
      // A broken writer is already equivalent to a disconnected peer; the
      // authorization cutoff below must still run.
    }
    await new Promise((resolve) =>
      setTimeout(resolve, REVOKE_NOTIFICATION_GRACE_MS)
    )

    // Authentication can replace a map entry while the final notification is
    // draining. Close both the notified record and whichever matching record
    // is current so revocation cannot lose that race.
    const current = this.sessions.get(sessionKey)
    const targets =
      current && current !== notified ? [notified, current] : [notified]
    for (const target of targets) {
      if (this.sessions.get(sessionKey) === target) {
        this.sessions.delete(sessionKey)
      }
      this.closeSessionTransport(target)
    }
  }

  private closeExtensionSessionNow(sessionKey: string): void {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    session.conn.revokeAuthorization()
    this.sessions.delete(sessionKey)
    this.closeSessionTransport(session)
  }

  private closeSessionTransport(session: BridgeSession): void {
    try {
      session.envelope.close(1000)
    } catch {
      // Closing is best-effort, but listener disposal below is not optional.
    }
    try {
      session.conn.dispose()
    } catch {
      // Authorization was already cut and the session-map entry removed.
    }
  }

  /** Iterate active sessions (e.g. for broadcast). */
  *iterSessions(): IterableIterator<BridgeSession> {
    yield* this.sessions.values()
  }

  /**
   * Stateless unary JSON-RPC handler for `POST /mdxp`. Authenticates the
   * machine-owner Bearer token, confines the surface to agent-facing methods,
   * synthesizes a `cli` session context, and routes through the SAME dispatcher
   * the WebSocket transport uses. Loopback-only in Spec 3 (the http server
   * binds 127.0.0.1); remote bind is Spec 6.
   */
  private async handleUnaryMdxp(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Auth: a Bearer token that is EITHER the machine-owner localToken OR a
    // paired cli token (device-code). The caller identity is synthesized from
    // whichever matched.
    const identity = this.resolveBearer(req.headers.authorization)
    if (!identity) {
      writeJsonRpc(res, 401, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCodes.PermissionDenied, message: 'unauthorized' },
      })
      return
    }

    // Body (size-capped to bound an unauthenticated-shaped request's memory).
    let raw: string
    try {
      raw = await readBody(req, MAX_UNARY_BODY_BYTES)
    } catch {
      writeJsonRpc(res, 413, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: ErrorCodes.InvalidRequest,
          message: 'request body too large',
        },
      })
      return
    }

    let msg: {
      jsonrpc?: unknown
      id?: unknown
      method?: unknown
      params?: unknown
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      writeJsonRpc(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCodes.ParseError, message: 'invalid JSON' },
      })
      return
    }
    const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null

    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      writeJsonRpc(res, 400, {
        jsonrpc: '2.0',
        id,
        error: {
          code: ErrorCodes.InvalidRequest,
          message: 'invalid JSON-RPC request',
        },
      })
      return
    }
    const method = msg.method

    // Agent-facing gate: only CLI/agent tools are callable unary. The extension
    // handshake/submit methods (initialize, download/submit, …) are not.
    if (!Tools[method]?.agentFacing) {
      writeJsonRpc(res, 404, {
        jsonrpc: '2.0',
        id,
        error: {
          code: ErrorCodes.CapabilityNotSupported,
          message: `method not available: ${method}`,
        },
      })
      return
    }

    try {
      const ctx: MdxpSessionContext = {
        identity,
        startedAt: Date.now(),
        isReady: () => true,
        markReady: () => {},
        // The bearer was already authenticated by resolveBearer above.
        isAuthorized: () => true,
        markAuthorized: () => {},
        pendingPair: null,
      }
      // The HTTP request wrapper already admitted/tracks this whole handler.
      // Dispatch directly so a shutdown that starts while the body is being
      // read does not re-gate an already-accepted request.
      const result = await this.dispatcher.dispatch(method, msg.params, ctx)
      writeJsonRpc(res, 200, { jsonrpc: '2.0', id, result })
    } catch (err) {
      const error = normalizeUnaryError(err)
      writeJsonRpc(res, httpStatusForUnaryCode(error.code), {
        jsonrpc: '2.0',
        id,
        error,
      })
    }
  }

  /** `POST /mdxp/pair/request` — create a device-code pairing request and fire
   *  an approval prompt. Body: `{ clientName, clientVersion? }`. */
  private async handlePairRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const dc = this.opts.deviceCode
    if (!dc) {
      writeJson(res, 404, {
        error: {
          code: ErrorCodes.CapabilityNotSupported,
          message: 'device-code pairing not available',
        },
      })
      return
    }
    let raw: string
    try {
      raw = await readBody(req, MAX_PAIR_BODY_BYTES)
    } catch {
      writeJson(res, 413, {
        error: {
          code: ErrorCodes.InvalidRequest,
          message: 'request body too large',
        },
      })
      return
    }
    let body: {
      clientName?: unknown
      clientVersion?: unknown
      deviceId?: unknown
    }
    try {
      body = JSON.parse(raw)
    } catch {
      writeJson(res, 400, {
        error: { code: ErrorCodes.ParseError, message: 'invalid JSON' },
      })
      return
    }
    const clientName =
      typeof body.clientName === 'string' ? body.clientName.trim() : ''
    if (!clientName || clientName.length > 200) {
      writeJson(res, 400, {
        error: {
          code: ErrorCodes.InvalidParams,
          message: 'clientName is required',
        },
      })
      return
    }
    const clientVersion =
      typeof body.clientVersion === 'string'
        ? body.clientVersion.slice(0, 64)
        : 'unknown'
    // Optional persisted device handle: lets the SAME CLI re-pair into the same
    // cli identity (so its prior token rotates). DeviceCodeService validates the
    // shape and falls back to a minted id — never trust it as an identity key.
    const deviceId =
      typeof body.deviceId === 'string' ? body.deviceId : undefined

    let result: ReturnType<DeviceCodeService['request']>
    try {
      result = dc.request(clientName, clientVersion, deviceId)
    } catch (err) {
      const error = normalizeUnaryError(err)
      writeJson(res, httpStatusForUnaryCode(error.code), { error })
      return
    }

    // Surface the approval prompt (extension parity: the shell decides how).
    this.opts.onPairRequested?.({
      kind: 'cli',
      requestId: result.requestId,
      userCode: result.userCode,
      clientName,
      clientVersion,
    })

    // verificationUri comes ONLY from injected config (the approval UI is a
    // separate service). Omit it when unset — never derive it from the request
    // Host, which is THIS bridge (it 404s `/`).
    const responseBody: {
      requestId: string
      userCode: string
      expiresAt: number
      interval: number
      verificationUri?: string
    } = {
      requestId: result.requestId,
      userCode: result.userCode,
      expiresAt: result.expiresAt,
      interval: PAIR_POLL_INTERVAL_SEC,
    }
    if (this.opts.verificationUri) {
      responseBody.verificationUri = this.opts.verificationUri
    }
    writeJson(res, 200, responseBody)
  }

  /** `POST /mdxp/pair/poll` `{ requestId }` — report the pending request's
   *  status, delivering the token once approved (one-time). */
  private async handlePairPoll(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const dc = this.opts.deviceCode
    if (!dc) {
      writeJson(res, 404, {
        error: {
          code: ErrorCodes.CapabilityNotSupported,
          message: 'device-code pairing not available',
        },
      })
      return
    }
    let raw: string
    try {
      raw = await readBody(req, MAX_PAIR_BODY_BYTES)
    } catch {
      writeJson(res, 413, {
        error: {
          code: ErrorCodes.InvalidRequest,
          message: 'request body too large',
        },
      })
      return
    }
    let body: { requestId?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      writeJson(res, 400, {
        error: { code: ErrorCodes.ParseError, message: 'invalid JSON' },
      })
      return
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (!requestId) {
      writeJson(res, 400, {
        error: {
          code: ErrorCodes.InvalidParams,
          message: 'requestId is required',
        },
      })
      return
    }
    writeJson(res, 200, dc.poll(requestId))
  }

  private reject(socket: Duplex, code: 401 | 403 | 404 | 429): void {
    socket.write(`HTTP/1.1 ${code} ${REJECT_REASONS[code]}\r\n\r\n`)
    socket.destroy()
  }

  /** `POST /nonce` — §4.2 one-shot pairing nonce issuance. */
  private handleNonceIssue(req: IncomingMessage, res: ServerResponse): void {
    // §4.2: the custom header makes the request non-simple, so the browser
    // preflight (we grant no CORS) stops a cross-origin page before it reaches
    // this handler at all. The caps below do not depend on that holding.
    if (req.headers['x-motrix-bridge'] !== '1') {
      writeJson(res, 403, {
        error: { code: ErrorCodes.PermissionDenied, message: 'forbidden' },
      })
      return
    }
    // The native-messaging host has no Origin; `issue(null)` skips the
    // per-origin quota by design and still applies both global caps.
    const issued = this.nonces.issue(req.headers.origin ?? null)
    if ('error' in issued) {
      writeJson(res, 429, {
        error: {
          code: ErrorCodes.RateLimited,
          message: 'nonce issuance is rate-limited',
        },
      })
      return
    }
    writeJson(res, 200, issued)
  }

  /**
   * `/pair` — the §6 first-pair state machine, and nothing else. There is no
   * token mode and no legacy frame format to downgrade into.
   */
  private handleMbp1PairUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pairNonce: string,
    peer: ExtensionPeer,
    identity: ClientIdentity & { kind: 'extension' },
    mbp1: Mbp1Wiring,
    releaseAdmission: () => void
  ): void {
    const sessionKey = makeSessionKey(peer.browser, peer.extensionId)
    // A revoke owns this verified Origin until durable removal and transport
    // teardown finish. Refuse before consuming the one-shot nonce so the user
    // can retry after the critical section rather than being forced to mint a
    // new nonce for a request the server intentionally did not admit.
    if (this.revokingExtensionKeys.has(sessionKey)) {
      releaseAdmission()
      this.reject(socket, 401)
      return
    }
    // §4/§6.1: after the server-owned revocation gate, consuming the one-shot
    // nonce is the FIRST protocol admission action — before any session
    // object, dialog, or flood-control slot exists.
    //
    // An unknown or replayed nonce is refused HERE rather than admitted and
    // failed with `pairError {expired}`. Requiring a live nonce to occupy a
    // pre-authentication slot is what puts `POST /nonce`'s three caps
    // (outstanding, global rate, per-origin rate) in front of the pre-auth
    // table; without it, upgrades are free and a peer that connects and then
    // stays silent could fill all 32 slots for the whole deadline at no cost.
    // `PairSessionDeps.nonceValid` therefore stays `true` for every session
    // this demux builds, and remains as the session's own defence in depth.
    if (!this.nonces.consume(pairNonce)) {
      releaseAdmission()
      this.reject(socket, 401)
      return
    }
    // No `extensionId`/`browser`/`extensionName` query reads: §5 forbids
    // trusting self-reported identity, and every one of those now comes from
    // `pairHello` bound to the verified Origin.

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      // Defence in depth for a future asynchronous upgrade implementation:
      // never admit a socket if revoke began after the pre-upgrade check.
      if (this.revokingExtensionKeys.has(sessionKey)) {
        releaseAdmission()
        ws.close()
        return
      }
      const entry: PairPreAuthEntry = {
        ws,
        sessionKey,
        session: null,
        queuedDialog: false,
        confirmed: false,
        outcomeRecorded: false,
        releaseAdmission,
      }
      if (!this.preAuthPair.admit(entry)) {
        // §4: the table is full. Nothing is constructed, so this attempt
        // cannot touch flood control or any live session.
        entry.releaseAdmission()
        ws.close()
        return
      }
      // A dead socket's `send` emits 'error'; without a listener that is an
      // unhandled event and takes the process down.
      ws.on('error', () => {})

      const session = new PairSession({
        nonceValid: true,
        pairNonce,
        verifiedOrigin: peer.origin,
        // Both from the same `parseExtensionOrigin` result, so `/pair` and
        // `/v1` cannot disagree about which browser a credential belongs to.
        browser: peer.browser,
        instanceId: mbp1.instanceId,
        serverGeneration: mbp1.serverGeneration,
        localToken: this.opts.localToken,
        isOfficialId: mbp1.isOfficialId,
        credentials: mbp1.credentials,
        replay: this.replay,
        // §7.3 admission is core's and runs before ticket validation, so a
        // session refused `busy` never burns a legitimate ticket's one-shot
        // replay slot. Passed straight through — `release` in particular must
        // not be double-called, since pending slots are keyed by origin alone.
        admit: (origin) => this.floodControl.admit(origin),
        release: (origin) => this.floodControl.release(origin),
        queueDialog: (args) => {
          const result = mbp1.queueMbp1Dialog(args)
          // §7.3 counts a failed attempt only after the code-bearing prompt
          // actually reached the shell. A typed enqueue refusal or failed
          // publisher showed no code and must not penalize the peer.
          if (result.ok) {
            void result.handle.published.then(
              (status) => {
                if (status === 'delivered') entry.queuedDialog = true
              },
              () => {}
            )
          }
          return result
        },
        sendText: (json) => sendText(ws, json),
        sendBinary: (frame) => sendBinary(ws, frame),
        // The reason names an internal step, so it stays off the wire and out
        // of every log (§11).
        close: () => ws.close(),
        onAuthenticated: (channel, credentialId) => {
          // Synchronous, in the same tick: no `await` may separate the
          // session's `committed` state from this handover, or the post-commit
          // drop guards swallow the client's first real frames.
          detachPreAuth()
          this.preAuthPair.settle(entry)
          entry.releaseAdmission()
          entry.confirmed = true
          this.recordPairOutcome(entry)
          this.adoptAuthenticatedSession(ws, identity, channel, credentialId)
        },
        now: () => Date.now(),
        random: (n) => new Uint8Array(randomBytes(n)),
      })
      entry.session = session

      const pump = createPreAuthFramePump(ws, (frame, isBinary) =>
        isBinary
          ? session.handleBinary(asProtocolBytes(frame))
          : // The true byte length, not the decoded string's length: §6.1's
            // 16 KiB pre-authentication cap is measured on the wire.
            session.handleText(frame.toString('utf8'), frame.length)
      )
      const onMessage = (data: RawData, isBinary: boolean): void => {
        pump.push(rawToBuffer(data), isBinary)
      }
      const detachPreAuth = (): void => {
        ws.off('message', onMessage)
        pump.handOver()
      }
      ws.on('message', onMessage)

      ws.on('close', () => {
        detachPreAuth()
        this.preAuthPair.settle(entry)
        entry.releaseAdmission()
        session.dispose('socket-closed')
        // §7.3 names the early disconnect explicitly: a guesser must not be
        // able to dodge the failure counter by closing the socket.
        this.recordPairOutcome(entry)
      })
    })
  }

  /**
   * `/v1` — the §8 challenge–response. The upgrade carries no credentials in
   * the URL. The public raw-route policy rejects every query (including a
   * historical `?token=`) before this handler can run, and no token auth path
   * exists behind it.
   */
  private handleMbp1ReconnectUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    peer: ExtensionPeer,
    identity: ClientIdentity & { kind: 'extension' },
    mbp1: Mbp1Wiring,
    releaseAdmission: () => void
  ): void {
    const sessionKey = makeSessionKey(peer.browser, peer.extensionId)
    // Keep a revoke critical section closed to both credential reuse and new
    // first-pair credential creation for the same verified Origin.
    if (this.revokingExtensionKeys.has(sessionKey)) {
      releaseAdmission()
      this.reject(socket, 401)
      return
    }
    // §8's closing requirement: reconnect attempts are rate-limited per
    // verified origin and globally. Refused HERE rather than after the upgrade,
    // for the same reason `/pair` refuses an unknown nonce before it: a
    // throttled peer should not get a WebSocket, a pre-authentication slot, or
    // a session object out of the attempt.
    //
    // This is not an authentication oracle. It answers only "you are asking too
    // often", which is true regardless of whether any credential exists — §8's
    // requirement that an unknown `credentialId` and a bad MAC be
    // indistinguishable concerns what happens *after* admission.
    if (!this.reconnectRate.admit(peer.origin)) {
      releaseAdmission()
      this.reject(socket, 429)
      return
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (this.revokingExtensionKeys.has(sessionKey)) {
        releaseAdmission()
        ws.close()
        return
      }
      const entry: ReconnectPreAuthEntry = {
        ws,
        sessionKey,
        session: null,
        releaseAdmission,
      }
      if (!this.preAuthReconnect.admit(entry)) {
        entry.releaseAdmission()
        ws.close()
        return
      }
      ws.on('error', () => {})

      const session = new ReconnectSession({
        verifiedOrigin: peer.origin,
        // Derived from the Origin scheme, never from a stored or claimed
        // field: §8 binds the live connection's values into the MAC.
        browser: peer.browser,
        instanceId: mbp1.instanceId,
        credentials: mbp1.credentials,
        sendText: (json) => sendText(ws, json),
        close: () => ws.close(),
        onAuthenticated: (channel, credential) => {
          detachPreAuth()
          this.preAuthReconnect.settle(entry)
          entry.releaseAdmission()
          this.adoptAuthenticatedSession(
            ws,
            identity,
            channel,
            credential.credentialId
          )
        },
        now: () => Date.now(),
        random: (n) => new Uint8Array(randomBytes(n)),
      })
      entry.session = session

      const pump = createPreAuthFramePump(ws, (frame, isBinary) =>
        // §8 pre-channel framing is text-only, exactly as §6.1. A binary frame
        // is routed through the same handler with a body that cannot parse, so
        // the session emits its own uniform `protocolViolation` rather than the
        // wiring inventing a second, differently-shaped failure path.
        session.handleText(isBinary ? '' : frame.toString('utf8'), frame.length)
      )
      const onMessage = (data: RawData, isBinary: boolean): void => {
        pump.push(rawToBuffer(data), isBinary)
      }
      const detachPreAuth = (): void => {
        ws.off('message', onMessage)
        pump.handOver()
      }
      ws.on('message', onMessage)

      ws.on('close', () => {
        detachPreAuth()
        this.preAuthReconnect.settle(entry)
        entry.releaseAdmission()
        session.dispose('socket-closed')
      })

      // The server speaks first on `/v1`; the listener is already attached, so
      // a fast client's response cannot race it.
      session.start()
    })
  }

  /**
   * Promote a socket that has completed MBP1 into the live session map, with
   * MDXP running inside the AEAD envelope.
   *
   * The caller MUST have detached its pre-authentication `'message'` listener
   * in the same tick: Node fans `'message'` out to every listener, so a
   * surviving one would advance the opener's strict sequence a second time and
   * the real consumer would see a mismatch on the very next frame.
   */
  adoptAuthenticatedSession(
    ws: WebSocketLike,
    identity: ClientIdentity & { kind: 'extension' },
    channel: EnvelopeChannel,
    credentialId: string
  ): void {
    // Byte-identical to `clientKey(identity)`, which the SSE revoke matcher
    // and `getSession` both rely on.
    const sessionKey = makeSessionKey(identity.browser, identity.extensionId)
    const startedAt = Date.now()
    // The handed-over endpoints, never fresh ones: their sequence counters
    // continue from the handshake (`/pair` has already sealed
    // `credentialCommitted`).
    const envelope = wrapWithEnvelope(ws, channel, (fault) => {
      // §10: any gap, repeat, tampered frame, post-activation text frame, or
      // usage-bound reached (inbound or outbound) closes immediately. The
      // close code separates "the peer broke the protocol", "this process
      // did", and "a usage bound was reached — reconnect" without naming
      // which check failed — every §10 violation of a given kind reports the
      // same code (§11).
      ws.close(closeCodeForEnvelopeFault(fault.kind))
    })
    const conn = new BridgeConnection(envelope, {
      sessionKey,
      extensionId: identity.extensionId,
      browser: identity.browser,
      startedAt,
    })
    // MBP1 authenticated the transport below MDXP, so the session is
    // authorized on arrival. No handler grants this any more.
    conn.markAuthorized()
    if (this.revokingExtensionKeys.has(sessionKey)) {
      conn.revokeAuthorization()
      this.closeSessionTransport({
        conn,
        extensionId: identity.extensionId,
        browser: identity.browser,
        startedAt,
        envelope,
      })
      return
    }
    this.applyHandlers(conn, null)

    const session: BridgeSession = {
      conn,
      extensionId: identity.extensionId,
      browser: identity.browser,
      startedAt,
      envelope,
    }
    // Register BEFORE disposing the predecessor, and only ever from here —
    // the unconditional pre-construction eviction this replaces let an
    // unauthenticated `/pair` connection kick a live authenticated session
    // just by opening a socket (§4).
    const existing = this.sessions.get(sessionKey)
    this.sessions.set(sessionKey, session)
    existing?.conn.dispose()

    ws.on('close', () => {
      // Only ever remove OUR OWN entry: the replaced socket's imminent close
      // must not delete the replacement that just took its key.
      if (this.sessions.get(sessionKey) === session) {
        this.sessions.delete(sessionKey)
      }
      conn.dispose()
    })

    conn.listen()
    // Deliberately synchronous and un-awaited: the session handover and the
    // exact credential evidence are published in this adoption tick. The
    // shell may schedule follow-up work, but cannot block the live transport.
    this.opts.onExtensionAuthenticated?.(identity, credentialId)
  }

  private canAdmitExtensionIdentity(
    identity: ClientIdentity & { kind: 'extension' }
  ): boolean {
    try {
      return this.opts.canAdmitExtensionIdentity?.(identity) ?? true
    } catch {
      // Projection/recovery state is an authorization input. A broken gate
      // must close the surface, not turn an upgrade into an uncaught error.
      return false
    }
  }

  /** §7.3's counter moves exactly once per `/pair` session, on whichever
   *  terminal path arrives first. */
  private recordPairOutcome(entry: PairPreAuthEntry): void {
    if (entry.outcomeRecorded) {
      return
    }
    entry.outcomeRecorded = true
    this.floodControl.recordOutcome({
      queuedDialog: entry.queuedDialog,
      // §7.2 never gives a consumed attempt back, so reading it after the fact
      // is exactly the "reached pakeA and did not confirm" test §7.3 wants.
      consumedAttempt: (entry.session?.attemptCount ?? 0) > 0,
      confirmed: entry.confirmed,
    })
  }

  private expirePairPreAuth(entry: PairPreAuthEntry): void {
    try {
      entry.session?.dispose('timeout')
      this.recordPairOutcome(entry)
    } finally {
      entry.releaseAdmission()
      // `dispose` deliberately does NOT close the socket — both session modules
      // read it as "the peer is already gone, or the wiring is closing it" — so
      // the wiring must, and must do so even if the bookkeeping above throws.
      // This runs from a timer callback, where a lost close means a peer that
      // upgraded and then said nothing holds its slot for the process's life.
      entry.ws.close()
    }
  }

  private applyHandlers(
    conn: BridgeConnection,
    pairArgs: PairRequestArgs | null
  ): void {
    const ctx = contextFromConnection(conn, pairArgs)
    // Every method EXCEPT the handshake pair (motrix/initialize, system/ping)
    // requires an authorized session. Under MBP1 every WebSocket session is
    // authorized before this runs, so the gate is defence in depth rather than
    // the live boundary: it is what stops a future transport that admits an
    // unauthorized connection from silently reaching the control plane. The
    // dispatcher itself has no authz notion, so the gate lives at the wiring.
    const authorizedDispatch = (
      method: string,
      params: unknown
    ): Promise<unknown> => {
      if (!ctx.isAuthorized()) {
        const error = makeMdxpError(
          ErrorCodes.PermissionDenied,
          'session is not authorized; complete pairing first',
          { appCode: 'pair.required' }
        )
        // vscode-jsonrpc preserves a ResponseError on the wire; rejecting its
        // handler with the package's plain MdxpError shape collapses to -32603.
        return Promise.reject(
          new ResponseError(error.code, error.message, error.data)
        )
      }
      return this.dispatchTracked(method, params, ctx)
    }
    // motrix/initialize is always registered on the dispatcher; download/* are
    // present only after the shell calls setHandlers(). Each onRequest routes
    // through the dispatcher, which validates params and runs the handler with
    // the transport-neutral ctx.
    conn.onRequest(
      'motrix/initialize',
      (params) =>
        this.dispatchTracked('motrix/initialize', params, ctx) as never
    )
    if (this.dispatcher.has('download/submit')) {
      conn.onRequest(
        'download/submit',
        (params) => authorizedDispatch('download/submit', params) as never
      )
    }
    if (this.dispatcher.has('download/cancel')) {
      conn.onRequest(
        'download/cancel',
        (params) => authorizedDispatch('download/cancel', params) as never
      )
    }
    // Control-plane over WS: a paired session may drive task management + read
    // stats/engine. Additive — handlers/schemas live on the shared dispatcher.
    const wireDispatched = (
      method: (typeof EXTENSION_WS_CONTROL_PLANE)[number]
    ) => {
      if (this.dispatcher.has(method)) {
        conn.onRequest(
          method,
          (params) => authorizedDispatch(method, params) as never
        )
      }
    }
    for (const method of EXTENSION_WS_CONTROL_PLANE) wireDispatched(method)
    // system/ping is universal — wire it unconditionally.
    conn.onRequest('system/ping', (params) => ({
      sentAt: params.sentAt,
      recvAt: Date.now(),
    }))
    conn.onNotification('motrix/initialized', () => {
      conn.markReady()
    })
  }

  private dispatchTracked(
    method: string,
    params: unknown,
    ctx: MdxpSessionContext
  ): Promise<unknown> {
    return this.requestWork.run(() =>
      this.dispatcher.dispatch(method, params, ctx)
    )
  }
}

const REJECT_REASONS = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
} as const

/** One WebSocket text frame carrying one JSON object (§6.1). */
function sendText(ws: WebSocket, json: object): void {
  if (ws.readyState !== ws.OPEN) {
    return
  }
  ws.send(JSON.stringify(json))
}

/** One WebSocket binary frame carrying one sealed envelope (§10). */
function sendBinary(ws: WebSocket, frame: Uint8Array): void {
  if (ws.readyState !== ws.OPEN) {
    return
  }
  ws.send(frame, { binary: true })
}

/**
 * Normalize whatever `ws` delivered into one contiguous `Buffer`. In the
 * default `binaryType: 'nodebuffer'` mode that is already a `Buffer`, but the
 * declared `RawData` also admits a fragment array and an `ArrayBuffer`, and a
 * pre-authentication frame's byte length is load-bearing (§6.1's 16 KiB cap).
 */
function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data)
}

/**
 * The same bytes as a plain `Uint8Array`, zero-copy — so §6.1's byte-length
 * accounting is unaffected.
 *
 * `mbp1/` hands its byte inputs to `@noble` helpers that accept a value only
 * when `value instanceof Uint8Array`, and a `Buffer` fails that check whenever
 * the two were built in different realms. Handing `EnvelopeOpener.open` a
 * `Buffer` therefore risks a `TypeError` from inside the AEAD layer, which
 * `PairSession.handleBinary` would report to the peer as a §10 envelope
 * violation — our own fault dressed up as the peer's.
 */
function asProtocolBytes(frame: Buffer): Uint8Array {
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
}

interface PreAuthFramePump {
  /** Enqueue one raw frame from the socket. */
  push(frame: Buffer, isBinary: boolean): void
  /** Stop feeding the handshake and release the unread tail. */
  handOver(): void
}

/**
 * Feeds pre-authentication frames to a session **one at a time**, and hands
 * the unread tail to whoever takes the socket over.
 *
 * Serializing is the first half: both session handlers are `async` and await
 * the credential store, so a per-event call would let a second frame enter the
 * state machine mid-transition.
 *
 * Releasing the tail is the second half, and it is the part that is easy to
 * miss. A client may pipeline its first MDXP request straight behind the last
 * handshake frame, without waiting for `credentialCommitted` /
 * `reconnectAccept`. That frame is already queued here when the handover
 * happens, and the session's post-handover guards **drop** such frames rather
 * than treating them as violations — so dispatching it would swallow the
 * request AND leave the envelope opener one sequence number behind, killing the
 * connection on the next frame with a mismatch that looks like tampering.
 * Re-emitting it on the socket instead delivers it to the MDXP consumer that
 * has just attached, in order.
 */
function createPreAuthFramePump(
  ws: WebSocket,
  consume: (frame: Buffer, isBinary: boolean) => Promise<void>
): PreAuthFramePump {
  const pending: Array<[Buffer, boolean]> = []
  let running = false
  let handedOver = false

  const drain = async (): Promise<void> => {
    if (running) {
      return
    }
    running = true
    try {
      while (!handedOver) {
        const next = pending.shift()
        if (next === undefined) {
          break
        }
        await consume(next[0], next[1])
      }
    } catch {
      // Both session handlers contain their own faults, so a rejection here is
      // an internal one. Close rather than strand every later frame; nothing is
      // logged, because the value may carry protocol state (§11).
      pending.length = 0
      ws.close(WS_CLOSE_INTERNAL_ERROR)
    } finally {
      running = false
    }
    if (handedOver && pending.length > 0) {
      for (const [frame, isBinary] of pending.splice(0)) {
        ws.emit('message', frame, isBinary)
      }
    }
  }

  return {
    push(frame, isBinary) {
      pending.push([frame, isBinary])
      void drain()
    },
    handOver() {
      handedOver = true
    },
  }
}

/** Generous cap for the unary body; the read methods carry tiny params, and
 *  download/add's torrent base64 (Spec 4) stays comfortably under this. */
const MAX_UNARY_BODY_BYTES = 4 * 1024 * 1024

/** The device-code `pair/request` body is tiny ({ clientName, clientVersion }). */
const MAX_PAIR_BODY_BYTES = 4 * 1024

/** Suggested CLI poll cadence (seconds) returned in the request response. */
const PAIR_POLL_INTERVAL_SEC = 2

/** Plain-JSON HTTP response (the device-code routes are REST-ish, not JSON-RPC). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  // no-store: device-code responses can carry the requestId / the issued token;
  // they must never be cached by a proxy or the browser.
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

interface JsonRpcEnvelope {
  jsonrpc: '2.0'
  id: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function writeJsonRpc(
  res: ServerResponse,
  status: number,
  body: JsonRpcEnvelope
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Map an MDXP error code to the unary HTTP status (per Spec 3 §5). */
function httpStatusForUnaryCode(code: number): number {
  switch (code) {
    case ErrorCodes.InvalidParams:
      return 400
    case ErrorCodes.PermissionDenied:
    case ErrorCodes.PairRevoked:
      return 403
    case ErrorCodes.CapabilityNotSupported:
      return 404
    case ErrorCodes.ResourceUnavailable:
      // A missing/absent resource (e.g. task/pause on an unknown id) is a
      // not-found, not an internal server error.
      return 404
    case ErrorCodes.RateLimited:
      return 429
    default:
      return 500
  }
}

interface NormalizedError {
  code: number
  message: string
  data?: unknown
}

/** `makeMdxpError` returns a plain `{ code, message, data? }` object (not an
 *  Error), so detect it structurally. */
function isMdxpErrorShape(
  e: unknown
): e is { code: number; message: string; data?: unknown } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'number' &&
    typeof (e as { message?: unknown }).message === 'string'
  )
}

/**
 * Map an AppError's string `ErrorCode` onto an MDXP numeric code. Core handlers
 * (e.g. `handleCreateTask` behind `download/add`) throw `AppError`, whose
 * string `code` would otherwise escape {@link isMdxpErrorShape} and collapse to
 * an opaque 500. Translating preserves a meaningful code + the real message.
 */
function appErrorToMdxpCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.IpcInvalidPayload:
    case ErrorCode.InvalidSelection:
    case ErrorCode.SettingsInvalid:
      return ErrorCodes.InvalidParams
    case ErrorCode.TaskNotFound:
      return ErrorCodes.ResourceUnavailable
    case ErrorCode.IpcRateLimited:
      return ErrorCodes.RateLimited
    default:
      return ErrorCodes.AdapterError
  }
}

/** Normalize any thrown value into an MDXP-shaped error for the unary response. */
function normalizeUnaryError(err: unknown): NormalizedError {
  if (err instanceof AppError) {
    return { code: appErrorToMdxpCode(err.code), message: err.message }
  }
  if (isMdxpErrorShape(err)) {
    return err.data !== undefined
      ? { code: err.code, message: err.message, data: err.data }
      : { code: err.code, message: err.message }
  }
  return { code: ErrorCodes.InternalError, message: 'internal error' }
}
