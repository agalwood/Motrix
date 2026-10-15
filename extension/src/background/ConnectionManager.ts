import type {
  DownloadSubmitParams,
  DownloadSubmitResult,
  InitializeParams,
  MdxpConnection,
  MdxpRequestMap,
  TaskCompletedParams,
  TaskErrorParams,
  TaskProgressParams,
} from '@motrix/mdxp'
import {
  createMdxpConnection,
  DownloadSubmitResultSchema,
  ErrorCodes,
  InitializeResultSchema,
  Methods,
  Notifications,
} from '@motrix/mdxp'
import type { BgAdapterRegistry } from '@/background/AdapterRegistry'
import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import type { BootstrapProvider } from '@/background/BootstrapProvider'
import { ConnectionGate } from '@/background/ConnectionGate'
import { createBootstrapProvider } from '@/background/createBootstrapProvider'
import {
  beforeDeadline,
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import {
  type BackendAttemptLease,
  type BackendAttemptMutationCapability,
  type CurrentBackendAttempt,
  EndpointCatalogService,
} from '@/background/EndpointCatalogService'
import type { ResolvedEndpointConfig } from '@/background/EndpointConfigStore'
import {
  EndpointConfigStore,
  LOCAL_ENDPOINT_ID,
} from '@/background/EndpointConfigStore'
import {
  EnvelopeMessageReader,
  EnvelopeMessageWriter,
} from '@/background/EnvelopeWebSocketStream'
import { log } from '@/background/log'
import {
  type BackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'
import {
  deriveRemoteBridgeRoute,
  remotePairUrl,
} from '@/background/mbp1/bridge-route'
import { getClientInstallationId } from '@/background/mbp1/client-installation-id'
import {
  type CredentialAttemptStore,
  CredentialStore,
  type Principal,
} from '@/background/mbp1/credential-store'
import {
  type DiscoveryResult,
  DiscoveryService,
} from '@/background/mbp1/discovery-service'
import type { EnvelopeCodec } from '@/background/mbp1/envelope'
import { FirstPairBackoff } from '@/background/mbp1/first-pair-backoff'
import {
  type FrameChannel,
  pairUrl,
  reconnectUrl,
} from '@/background/mbp1/frames'
import {
  type PairingCodeProvider,
  type PairingCodeRequest,
  type PairingCodeSource,
  PairingFlow,
  type PairingFlowDeps,
  PairingFlowError,
  type PairingFlowResult,
} from '@/background/mbp1/pairing-flow'
import { PinStore } from '@/background/mbp1/pin-store'
import {
  ReconnectFlow,
  type ReconnectFlowDeps,
  ReconnectFlowError,
  type ReconnectFlowResult,
} from '@/background/mbp1/reconnect-flow'
import { RemoteDiscoveryService } from '@/background/mbp1/remote-discovery-service'
import {
  type BindingKeypair,
  generateBindingKeypair,
} from '@/background/mbp1/ticket-bootstrap'
import { computeVerifiedOrigin } from '@/background/mbp1/verified-origin'
import { NativeBootstrapError } from '@/background/NativeBootstrap'
import {
  createLeaseBoundRemoteBackendPolicyStore,
  type RemoteBackendPolicyReplacement,
  type RemoteBackendPolicyV1,
} from '@/background/RemoteBackendPolicyStore'
import {
  RpcNotReadyError,
  RpcRecovery,
  type RpcSession,
  rpcDeadline,
} from '@/background/RpcRecovery'
import {
  applyRemoteSubmitPolicy,
  RemoteAutomaticTakeoverConsentRequiredError,
} from '@/background/remote-submit-policy'
import { notificationText } from '@/background/SafariNotificationTransport'
import { TaskEventStore } from '@/background/TaskEventStore'
import type { UrlResolutionDispatcher } from '@/background/UrlResolutionDispatcher'
import { WebSocketClient } from '@/background/WebSocketClient'
import { WebSocketFrameChannel } from '@/background/WebSocketFrameChannel'
import { extensionBrowser as browser } from '@/shared/browser'
import {
  type BrowserKind,
  requireProtocolBrowser,
  supportsBackendConnections,
} from '@/shared/browserKind'
import { i18n } from '@/shared/i18n'
import {
  type ConnectionIntent,
  type ConnectionPhase,
  DOWNLOAD_ERROR,
} from '@/shared/integration'
import type {
  NotificationSource,
  Notify,
  NotifyInput,
} from '@/shared/notifications'

export type ConnectionState =
  | 'disconnected'
  | 'bootstrapping'
  | 'connecting'
  | 'handshaking'
  /** A first-pair flow is parked on the user typing the §7.1 code; the
   *  prompt payload is `getPendingPairingCode()`. Entered/left only by the
   *  manager's provider wrapper — see the state machine diagram below. */
  | 'awaiting-code'
  | 'connected'
  /** Terminal: server refused pairing (e.g. user denied dialog, token
   *  revoked). No further reconnect attempts until user explicitly
   *  triggers connect()/clearGateAndStart(). */
  | 'denied'

export interface ServerIdentity {
  name: string
  version: string
  runtime: 'electron' | 'server'
  /** MBP1-authenticated backend identity. Omitted only on compatibility
   * paths where no authenticated instance was available. Discovery's
   * untrusted routing hint is never copied here. */
  instanceId?: string
}

/**
 * A live local candidate from `listPairCandidates()`, trimmed to what a
 * picker UI needs. `instanceId` is the §4.1 routing hint — display only,
 * never a signal — same as everywhere else it appears before a session is
 * authenticated.
 *
 * Both fields are nullable because an NM-bootstrap-sourced candidate (the
 * one path that returns exactly one result, so a picker never actually
 * shows it) carries neither: the NM host reply has no `instanceId` field at
 * all, and only a `/discovery` sweep response carries `appVersion`.
 */
export interface PairCandidate {
  port: number
  instanceId: string | null
  appVersion: string | null
}

export interface ConnectionManagerClientInfo {
  /** MDXP client identity discriminant — this client is the browser extension.
   *  (mdxp generalized initialize.client to a `kind` union in Spec 2; the
   *  no-kind compat shim still accepts older builds, but new builds send it.) */
  kind: 'extension'
  name: string
  version: string
  extensionId: string
  browser: BrowserKind
  browserVersion: string
  locale: string
}

/**
 * A `FrameChannel` (bridge-pairing-protocol.md §6.1) plus the one extra seam
 * `ConnectionManager` needs on success: handing the live socket — and any
 * frame that arrived on it before the handover — to a fresh transport layer
 * once a flow has verified the peer. Not part of `FrameChannel` itself,
 * since `PairingFlow`/`ReconnectFlow` never call it — only the caller that
 * owns the socket afterward does. `WebSocketFrameChannel` satisfies this
 * structurally without declaring it (see that class's own doc for why
 * `queuedFrames` must not be dropped).
 */
export interface Mbp1FrameChannel extends FrameChannel {
  release(): { socket: WebSocket; queuedFrames: Uint8Array[] }
}

export interface ConnectionManagerOptions {
  /** dependency-injection slots, mainly for tests */
  bootstrap?: BootstrapProvider
  client?: WebSocketClient
  endpointConfigStore?: EndpointConfigStore
  /** Serializes endpoint catalogue changes with the short-lived durable
   *  mutations issued by a captured connection attempt. Production wiring
   *  must share this instance with `EndpointCatalogService`. */
  backendOperationCoordinator?: BackendOperationCoordinator
  /** Sole issuer/revalidator of opaque endpoint-attempt leases. Production
   * wiring passes the same EndpointCatalogService that owns profile writes. */
  endpointLifecycleService?: Pick<
    EndpointCatalogService,
    | 'issueBackendAttemptLease'
    | 'runWithBackendAttemptLease'
    | 'bindBackendAttemptLease'
  >
  /** Cross-SW-restart pause gate (Chrome MV3 service workers die every
   *  ~30s of idle). Prevents new pair attempts while one is pending. */
  gate?: ConnectionGate
  /** Adapter registry: feeds motrix/initialize.adapters[] + url/probe.
   *  Omit (default empty) for tests that don't exercise adapter routing. */
  adapterRegistry?: BgAdapterRegistry
  /** Resolver: handles incoming url/resolve via content-script delegation.
   *  Omit to refuse url/resolve requests. */
  resolutionDispatcher?: UrlResolutionDispatcher
  clientInfo: ConnectionManagerClientInfo
  /** In-flight task progress store. Defaults to a fresh TaskEventStore. */
  taskEvents?: TaskEventStore
  /** OS notification callback. Defaults to browser.notifications.create. */
  notify?: Notify
  /** Max time for an ordinary MDXP request before the caller may recover. */
  requestTimeoutMs?: number
  rpcRecoveryTimeouts?: {
    probeTimeoutMs?: number
    reconnectTimeoutMs?: number
    retryTimeoutMs?: number
    totalTimeoutMs?: number
  }
  /** Max time for the pairing/initialize handshake, including user approval. */
  initializeTimeoutMs?: number
  /** Delay before the single unattended probe after an established socket
   *  closes. Gives a restarting Server a bounded window to bind its listener;
   *  this is not a retry loop. Defaults to 250ms. */
  closeReconnectDelayMs?: number

  // -- MBP1 (local endpoint) dependencies -----------------------------------
  /** §6.7/§12 credential storage for the local (MBP1) path. */
  credentialStore?: CredentialStore
  /** §12 pin storage for the local (MBP1) path. */
  pinStore?: PinStore
  /** §4 discovery chain for the local (MBP1) path. Defaults to a real
   *  `DiscoveryService` adapted onto `bootstrap` — see the constructor. */
  discoveryService?: DiscoveryService
  /** Direct HTTP(S) discovery/nonce adapter for configured WS/WSS Servers. */
  remoteDiscoveryService?: RemoteDiscoveryService
  /** §7.3 first-pair backoff for the local (MBP1) path. */
  firstPairBackoff?: FirstPairBackoff
  /**
   * Where a first-pair code comes from. No default: attempting a first pair
   * without one throws a clear, diagnosable error rather than hanging.
   * `service-worker.ts`'s real provider must itself enforce
   * `request.timeoutMs` — this flow has no way to cancel a pending call, so
   * a provider that just waits for the popup forever would hold the session
   * open past every deadline §6.5/§7.2 set.
   */
  pairingCodeSource?: PairingCodeSource
  /** DI seam: constructs the pre-auth channel a flow will drive. Defaults to
   *  a real `WebSocketFrameChannel`. */
  createFrameChannel?: () => Mbp1FrameChannel
  /** DI seam: constructs the flow that drives a §6 first pairing. Defaults to
   *  a real `PairingFlow`. */
  createPairingFlow?: (deps: PairingFlowDeps) => Pick<PairingFlow, 'run'>
  /** DI seam: constructs the flow that drives a §8 reconnect. Defaults to a
   *  real `ReconnectFlow`. */
  createReconnectFlow?: (deps: ReconnectFlowDeps) => Pick<ReconnectFlow, 'run'>
  /**
   * DI seam: wraps a live, already-authenticated socket and its derived
   * `EnvelopeCodec` as an `MdxpConnection`. Defaults to a real
   * `EnvelopeMessageReader`/`Writer` pair — see `EnvelopeWebSocketStream.ts`.
   * The `EnvelopeCodec` passed in always comes from the pairing/reconnect
   * flow's own return value; nothing here constructs a second one.
   * `queuedFrames` are whatever `Mbp1FrameChannel.release()` had already
   * buffered and MUST be drained, in order, before any new inbound frame —
   * see that method's own doc for why dropping one desyncs the envelope.
   */
  createEnvelopeConnection?: (
    socket: WebSocket,
    envelope: EnvelopeCodec,
    queuedFrames: Uint8Array[]
  ) => MdxpConnection
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 90_000

export type BackendCompatibilityFailureReason =
  | 'backendUpgradeRequired'
  | 'extensionUpgradeRequired'
  | 'unsupportedRemote'

export class BackendCompatibilityError extends Error {
  readonly reason: BackendCompatibilityFailureReason

  constructor(reason: BackendCompatibilityFailureReason, message: string) {
    super(message)
    this.name = 'BackendCompatibilityError'
    this.reason = reason
  }
}

export type RemoteConnectionFailureReason =
  | 'remoteDiscoveryUnavailable'
  | 'remotePairingUnavailable'
  | 'remoteTransportUnavailable'

class RemoteConnectionError extends Error {
  readonly reason: RemoteConnectionFailureReason

  constructor(reason: RemoteConnectionFailureReason, message: string) {
    super(message)
    this.name = 'RemoteConnectionError'
    this.reason = reason
  }
}

function isStrictlyNewerMdxp(version: string): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor > 0)
}

/**
 * Classify an authenticated peer's malformed/incompatible initialize result.
 * Discovery is only an unauthenticated hint; this is the authoritative verdict
 * after MBP1 has proved which backend we are talking to.
 */
function initializeCompatibilityFailureReason(
  value: unknown
): BackendCompatibilityFailureReason {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'backendUpgradeRequired'
  }
  const result = value as Record<string, unknown>
  if (
    typeof result.protocolVersion === 'string' &&
    isStrictlyNewerMdxp(result.protocolVersion)
  ) {
    return 'extensionUpgradeRequired'
  }
  return 'backendUpgradeRequired'
}

/** Internal cancellation signal for async work that belongs to a connection
 * attempt superseded by stop() or a newer connect(). */
class StaleConnectionAttemptError extends Error {
  constructor() {
    super('connection attempt superseded')
    this.name = 'StaleConnectionAttemptError'
  }
}

class StoredPairingUnavailableError extends Error {
  readonly reason = 'storedPairingUnavailable'
  constructor() {
    super(
      'Stored pairing could not reconnect; retry or explicitly forget it before pairing again'
    )
  }
}

/**
 * `connectLocalMbp1`'s recovery-order walk exhausted every stored credential
 * during an attempt nobody asked for (`autostart()`, or the automatic
 * post-close probe-reconnect) — never during a user-initiated one. §6.7/§12
 * both require fresh code-entry pairing to wait for the user or an explicit
 * revocation; falling through here regardless would put an unrequested
 * approval dialog on the user's Motrix and count against its §7.3 lockout
 * on every unattended wake, escalating a stale-credential situation the
 * user has not even seen yet into an hour-long server-side lockout.
 *
 * Lands the manager in `disconnected` (via `connect()`'s ordinary catch
 * path) with `reason` set so a UI can explain why, and touches no
 * credential or pin — the retained set is left exactly as `recoverOrder`
 * found it, for a later retry (a fresh wake, or the user asking explicitly).
 */
class RecoveryExhaustedUnattendedError extends Error {
  readonly reason = 'recoveryExhaustedUnattended'
  constructor() {
    super(
      'every stored MBP1 credential failed and this attempt was not ' +
        'user-initiated; not falling back to fresh code-entry pairing'
    )
    this.name = 'RecoveryExhaustedUnattendedError'
  }
}

/**
 * Security-relevant identity of the selected endpoint at the instant a
 * connection attempt starts. `activeEndpointId` is retained separately from
 * the resolved endpoint on purpose: `resolveActiveEndpoint()` safely falls
 * back to local for a missing/cleanup-pending profile, but a connection
 * attempt must never reinterpret that transient remote selection as local.
 */
interface EndpointIncarnation {
  readonly activeEndpointId: string
  readonly endpointConfig: ResolvedEndpointConfig
  readonly authority: BackendAuthority
  readonly gate: ConnectionGate
}

interface EndpointAttemptScope extends EndpointIncarnation {
  readonly generation: number
  readonly lease: BackendAttemptLease
  readonly mutation: BackendAttemptMutationCapability
  readonly credentials: CredentialAttemptStore
}

function isSameEndpointIncarnation(
  left: EndpointIncarnation,
  right: EndpointIncarnation
): boolean {
  if (left.activeEndpointId !== right.activeEndpointId) return false
  if (left.endpointConfig.mode !== right.endpointConfig.mode) return false
  if (left.endpointConfig.mode === 'local') return true
  if (right.endpointConfig.mode === 'local') return false
  return (
    left.endpointConfig.endpointId === right.endpointConfig.endpointId &&
    left.endpointConfig.remoteUrl === right.endpointConfig.remoteUrl &&
    left.endpointConfig.revision === right.endpointConfig.revision
  )
}

/**
 * Orchestrates the full transport stack:
 *   MBP1 discovery → authenticated WebSocket → motrix/initialize →
 *   ws-close-driven reconnect.
 *
 * State machine:
 *   disconnected ─connect()→ bootstrapping ─ok→ connecting ─ok→ handshaking ─ok→ connected
 *                                    (first pair) handshaking ⇄ awaiting-code (code provider pending)
 *                         └ err → dormant (disconnected)                           │
 *                                              one probe-reconnect ←── ws close ──┘
 *   stop() at any state → disconnected (closes WS).
 *
 * Entry points:
 *   autostart()           — SW startup: checks MBP1 credentials.
 *   connect({allowLaunch}) — single attempt; true = wake Motrix if needed.
 *   clearGateAndStart()   — popup "Connect": clears gate, calls connect(allowLaunch:true).
 */
export class ConnectionManager {
  private state: ConnectionState = 'disconnected'
  private readonly stateListeners: Array<(s: ConnectionState) => void> = []
  private currentConn: MdxpConnection | null = null
  /** Captured authority/revision for the live authenticated session. Durable
   * policy reads revalidate this snapshot immediately before outbound I/O. */
  private currentEndpointScope: EndpointAttemptScope | null = null
  private currentAuthenticatedInstanceId: string | null = null
  /**
   * The raw socket behind a *local* (MBP1) `currentConn`, or null for a
   * remote connection. Remote's `currentConn` is a `WebSocketClient`-owned
   * socket, so `this.client.close()` already tears it down; a local
   * connection's socket comes from `channel.release()` instead and
   * `this.client` never learns of it, so `stop()`/`enterDenied()` need this
   * separate handle to close it too — otherwise a denied/torn-down MBP1
   * session leaks an open WebSocket indefinitely.
   */
  private currentMbp1Socket: WebSocket | null = null
  /**
   * Channel whose socket is still owned by PairingFlow/ReconnectFlow. Unlike
   * `currentMbp1Socket`, this exists before authentication and may remain open
   * while a user reads/types a pairing code. Keeping it on the manager lets
   * stop() close it synchronously instead of waiting for the protocol TTL.
   */
  private preAuthChannel: Mbp1FrameChannel | null = null
  private lastErrorMessage: string | null = null
  /**
   * `PairingFlowError`/`ReconnectFlowError`'s own `reason`/`retryAtMs`, kept
   * alongside the plain-string message so a UI can render §7.3's backoff
   * state ("try again later") without parsing English out of an error
   * message. `retryAtMs` here is always the value the client's own
   * `FirstPairBackoff` computed — never anything the server reported — since
   * a fake or relaying peer can claim whatever `attemptsRemaining`/timing it
   * likes.
   */
  private lastErrorReason: string | null = null
  private lastErrorRetryAtMs: number | null = null
  /** Owner of the process-local presentation state below. Durable state is
   * scoped by its stores; this snapshot prevents an old selected Server's
   * transient error/prompt/retry verdict from appearing under a newly
   * selected endpoint while its connection attempt is being captured. */
  private presentationEndpointIncarnation: EndpointIncarnation | null = null
  /** Set exactly while the provider wrapper holds `awaiting-code`; read
   *  through `getPendingPairingCode()`, which additionally gates on the
   *  state so a stopped attempt's record is invisible even before the
   *  un-cancellable provider promise is reaped by its own §7.2 timeout. */
  private pendingPairingCode: {
    request: PairingCodeRequest
    deadlineMs: number
    owner: EndpointIncarnation
  } | null = null
  /** Full local cleanup + persisted denial for an authenticated revocation.
   * A user may click Reconnect as soon as the synchronous `denied` transition
   * renders; that retry must wait until stale credentials are gone. */
  private pendingRevocationCleanup: Promise<void> | null = null
  /** The candidate a caller explicitly picked via `choosePairCandidate`,
   *  consumed (and cleared) by the next first-pair attempt. `null` means
   *  "use whatever `discoverForFirstPair` ranks first", the existing
   *  default. */
  private preferredCandidatePort: number | null = null
  private readonly bootstrap: BootstrapProvider
  private readonly client: WebSocketClient
  private readonly endpointConfigStore: EndpointConfigStore
  private readonly backendOperationCoordinator: BackendOperationCoordinator
  private readonly endpointLifecycleService: Pick<
    EndpointCatalogService,
    | 'issueBackendAttemptLease'
    | 'runWithBackendAttemptLease'
    | 'bindBackendAttemptLease'
  >
  private readonly gate: ConnectionGate
  private readonly opts: ConnectionManagerOptions
  private readonly taskEvents: TaskEventStore
  private readonly notify: Notify
  private readonly rpcRecovery: RpcRecovery
  private readonly requestTimeoutMs: number
  private readonly initializeTimeoutMs: number
  private readonly closeReconnectDelayMs: number
  private initializeRequest: {
    conn: MdxpConnection
    params: InitializeParams
  } | null = null
  private capabilitiesRefreshFlight: Promise<
    ReturnType<ConnectionManager['getServerCapabilities']>
  > | null = null
  private serverCapabilities: {
    ffmpegAvailable: boolean
    selectionKinds: string[]
    taskReveal: boolean
    downloadDirectories?: boolean | undefined
  } | null = null
  private serverIdentity: ServerIdentity | null = null
  /**
   * Set exactly once per first-pair attempt in this session, at the same
   * point `connectFirstPairMbp1` decides what to pass as `discovery` to
   * `PairingFlow.run`: whether the candidate that answered presented no
   * §9.1 attestation ticket at all (`nmTicket === undefined`) — the host
   * degraded to ticketless. This is **not** the §5 identity tri-state; that
   * is the *server's* verdict about the extension, shown in Motrix's own
   * dialog, and never reaches the client at all.
   *
   * `null` until a first-pair attempt has actually run this session — a
   * plain reconnect (`connectLocalMbp1` succeeding via `recoverOrder`)
   * never re-presents a ticket, so it has no way to answer either way.
   * Reset alongside `serverIdentity` so a stale value from an earlier
   * attempt never survives into a later one.
   */
  private degraded: boolean | null = null
  /** Last URL passed to client.connect() — exposed for tests / observability. */
  public lastConnectUrl: string | null = null
  /** DEBUG: monotonic connectOnce counter. Each increment = one NM
   *  bootstrap spawn (in local mode). TODO(remove-after-rootcause). */
  private attemptSeq = 0
  /** Monotonic ownership token for async connection work. stop() and every
   *  accepted connect() invalidate all earlier continuations and callbacks. */
  private generation = 0
  /** One user-authorized connection lifecycle at a time. Endpoint activation,
   *  the Options Pair button, popup Connect, and an explicit handoff can all
   *  express the same intent before `connectOnce` has advanced the visible
   *  state. Joining that flight is security-relevant: restarting after the
   *  Server queued its prompt records a failed §7.3 attempt and can lock the
   *  replacement out. `stop()` clears the flight so an endpoint/lifecycle
   *  change can start a genuinely new intent. */
  private explicitConnectFlight: Promise<void> | null = null
  private readyFlight: Promise<void> | null = null
  private lastAttemptIntent: ConnectionIntent | null = null
  private connectionPhase: ConnectionPhase = 'idle'

  private readonly credentialStore: CredentialStore
  private readonly pinStore: PinStore
  private readonly discoveryService: DiscoveryService
  private readonly remoteDiscoveryService: RemoteDiscoveryService
  private readonly firstPairBackoff: FirstPairBackoff
  private readonly createFrameChannel: () => Mbp1FrameChannel
  private readonly createPairingFlow: (
    deps: PairingFlowDeps
  ) => Pick<PairingFlow, 'run'>
  private readonly createReconnectFlow: (
    deps: ReconnectFlowDeps
  ) => Pick<ReconnectFlow, 'run'>
  private readonly createEnvelopeConnection: (
    socket: WebSocket,
    envelope: EnvelopeCodec,
    queuedFrames: Uint8Array[]
  ) => MdxpConnection

  constructor(opts: ConnectionManagerOptions) {
    this.opts = opts
    this.bootstrap =
      opts.bootstrap ?? createBootstrapProvider(opts.clientInfo.browser)
    this.client = opts.client ?? new WebSocketClient()
    this.endpointConfigStore =
      opts.endpointConfigStore ?? new EndpointConfigStore()
    this.backendOperationCoordinator =
      opts.backendOperationCoordinator ?? new BackendOperationCoordinator()
    this.endpointLifecycleService =
      opts.endpointLifecycleService ??
      new EndpointCatalogService(
        this.endpointConfigStore,
        {
          retire: async () => {
            throw new Error('test-only endpoint lifecycle cannot retire')
          },
        },
        { coordinator: this.backendOperationCoordinator }
      )
    this.gate = opts.gate ?? new ConnectionGate()
    this.taskEvents = opts.taskEvents ?? new TaskEventStore()
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.rpcRecovery = new RpcRecovery({
      requestTimeoutMs: this.requestTimeoutMs,
      ...opts.rpcRecoveryTimeouts,
      session: () =>
        this.state === 'connected' && this.currentConn
          ? { conn: this.currentConn, generation: this.generation }
          : null,
      reconnect: (session, timeoutMs) =>
        this.recoverRpcSession(session, timeoutMs),
    })
    this.initializeTimeoutMs =
      opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    this.closeReconnectDelayMs = opts.closeReconnectDelayMs ?? 250
    if (
      !Number.isSafeInteger(this.closeReconnectDelayMs) ||
      this.closeReconnectDelayMs < 0
    ) {
      throw new TypeError(
        'closeReconnectDelayMs must be a non-negative integer'
      )
    }
    this.notify =
      opts.notify ??
      ((n: NotifyInput) => {
        if (
          typeof browser !== 'undefined' &&
          typeof browser.notifications !== 'undefined'
        ) {
          void browser.notifications
            .create({
              type: 'basic',
              iconUrl: browser.runtime.getURL('icons/icon-128.png'),
              title: n.title,
              message: n.message,
            })
            .catch(() => {})
        }
      })

    this.credentialStore = opts.credentialStore ?? new CredentialStore()
    this.pinStore = opts.pinStore ?? new PinStore()
    this.firstPairBackoff = opts.firstPairBackoff ?? new FirstPairBackoff()
    this.discoveryService =
      opts.discoveryService ??
      new DiscoveryService({
        pins: this.pinStore,
        nativeBootstrap: {
          bootstrap: async (o) => {
            const result = await this.bootstrap.discover({
              allowLaunch: o.allowLaunch,
              ...(o.bindingPub === undefined
                ? {}
                : { bindingPub: o.bindingPub }),
            })
            return {
              port: result.wsPort,
              nonce: result.nonce,
              nmTicket: result.nmTicket ?? undefined,
            }
          },
        },
      })
    this.remoteDiscoveryService =
      opts.remoteDiscoveryService ?? new RemoteDiscoveryService()
    this.createFrameChannel =
      opts.createFrameChannel ?? (() => new WebSocketFrameChannel())
    this.createPairingFlow =
      opts.createPairingFlow ?? ((deps) => new PairingFlow(deps))
    this.createReconnectFlow =
      opts.createReconnectFlow ?? ((deps) => new ReconnectFlow(deps))
    this.createEnvelopeConnection =
      opts.createEnvelopeConnection ??
      ((socket, envelope, queuedFrames) =>
        createMdxpConnection(
          new EnvelopeMessageReader(socket, envelope, queuedFrames),
          new EnvelopeMessageWriter(socket, envelope)
        ))
  }

  getLastAttemptIntent(): ConnectionIntent | null {
    return this.lastAttemptIntent
  }

  getConnectionPhase(): ConnectionPhase {
    return this.connectionPhase
  }

  /** Prepare a retained pairing without granting first-pair or clearing a gate.
   * Each caller owns its deadline; the bounded underlying flight is shared. */
  async ensureReady(options: {
    intent: 'automatic-download' | 'explicit-download' | 'view-tasks'
    deadlineAt?: number
    assertCurrent?: () => void
  }): Promise<void> {
    requireProtocolBrowser(this.opts.clientInfo.browser)
    const deadlineAt = options.deadlineAt ?? Date.now() + 30_000
    const check = (): void => {
      options.assertCurrent?.()
      if (Date.now() >= deadlineAt) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.preparationTimeout)
      }
    }
    check()
    if (this.rpcRecovery.isRecovering()) {
      await beforeDeadline(this.rpcRecovery.ready(deadlineAt), deadlineAt)
      check()
    }
    if (this.state === 'connected' && this.getRpcStatus().health === 'healthy')
      return
    this.rpcRecovery.reset()
    let flight = this.readyFlight ?? this.explicitConnectFlight
    if (flight === null) {
      // A passive probe must not prevent a real download from waking the App.
      // Explicit pairing owns its own flight and is joined above.
      this.stopCurrentAttempt()
      const work = this.connectExpected(
        {
          allowLaunch: true,
          userInitiated: true,
          allowFirstPair: false,
          intent: options.intent,
        },
        null
      )
      let owned: Promise<void>
      owned = beforeDeadline(work, Date.now() + 30_000)
        .catch((error) => {
          if (this.readyFlight === owned) this.stopCurrentAttempt()
          throw error
        })
        .finally(() => {
          if (this.readyFlight === owned) this.readyFlight = null
        })
      this.readyFlight = owned
      flight = owned
    }
    await beforeDeadline(flight, deadlineAt)
    check()
    if (this.getState() !== 'connected') {
      throw new DownloadPreparationError(
        this.lastErrorReason === DOWNLOAD_ERROR.pairingRequired
          ? DOWNLOAD_ERROR.pairingRequired
          : DOWNLOAD_ERROR.connectionFailed
      )
    }
  }

  getState(): ConnectionState {
    return this.state
  }

  /** Message of the most recent connect/reconnect failure; null after
   *  a successful handshake. UI surfaces this in the popup. */
  getLastError(): string | null {
    return this.lastErrorMessage
  }

  /** `PairingFlowError`/`ReconnectFlowError.reason` behind the last failure,
   *  or `null` if the last failure wasn't one of those (or there was none).
   *  `'backoffLocked'` is what a UI checks for to show the §7.3 backoff
   *  state; see `getLastErrorRetryAtMs()` for the retry time to pair with it. */
  getLastErrorReason(): string | null {
    return this.lastErrorReason
  }

  /** The client's own `FirstPairBackoff`-computed retry time for the last
   *  `'backoffLocked'` failure, or `null`. Never derived from anything the
   *  peer reported. */
  getLastErrorRetryAtMs(): number | null {
    return this.lastErrorRetryAtMs
  }

  /**
   * The pairing-code prompt currently awaiting the user, or `null`.
   * Non-null exactly while the state is `awaiting-code` — the read is
   * gated on the state, so a stopped or superseded attempt's prompt
   * vanishes from every polling surface at once even though the provider
   * promise itself cannot be cancelled (§7.2's timeout reaps it later).
   */
  getPendingPairingCode(): {
    request: PairingCodeRequest
    deadlineMs: number
  } | null {
    const pending = this.pendingPairingCode
    return this.state === 'awaiting-code' &&
      pending !== null &&
      this.presentationEndpointIncarnation !== null &&
      isSameEndpointIncarnation(
        pending.owner,
        this.presentationEndpointIncarnation
      )
      ? pending
      : null
  }

  /**
   * Wraps a function-typed code source so the state machine owns the
   * "awaiting the user's code" phase: entered when the flow invokes the
   * provider, left when it settles. The restore is guarded — it never
   * resurrects a state that `stop()` or supersession already moved on
   * from. String sources (fixed test codes) pass through untouched.
   */
  private wrapPairingCodeSource(
    source: PairingCodeSource,
    scope: EndpointAttemptScope
  ): PairingCodeSource {
    if (typeof source !== 'function') return source
    const provider: PairingCodeProvider = async (request) => {
      this.ensureCurrentAttempt(scope.generation)
      const pending = {
        request,
        deadlineMs: Date.now() + request.timeoutMs,
        owner: scope,
      }
      this.pendingPairingCode = pending
      this.setState('awaiting-code')
      try {
        return await source(request)
      } finally {
        // A stopped attempt's provider cannot be cancelled. If a replacement
        // attempt has already published its own prompt, the old provider's
        // late settlement owns neither that prompt nor the replacement
        // attempt's state transition.
        if (this.pendingPairingCode === pending) {
          this.pendingPairingCode = null
          if (
            this.isCurrentAttempt(scope.generation) &&
            this.state === 'awaiting-code'
          ) {
            this.setState('handshaking')
          }
        }
      }
    }
    return provider
  }

  /** Records an explicit candidate choice (from `bg.chooseCandidate`) for
   *  the next explicit lifecycle intent to use instead of
   *  `discoverForFirstPair`'s own top-ranked result. `connect()` or
   *  `clearGateAndStart()` claims and clears it synchronously, before any
   *  await, so a stopped/superseded discovery cannot leak the choice into a
   *  later pairing session. */
  choosePairCandidate(port: number): void {
    this.preferredCandidatePort = port
  }

  private takePreferredCandidatePort(): number | null {
    const port = this.preferredCandidatePort
    this.preferredCandidatePort = null
    return port
  }

  /**
   * Sweeps for live local candidates to pair with, for a picker UI to show
   * before the user commits to one. Read-only — this does not affect any
   * in-flight `connect()` attempt and does not itself start pairing;
   * `choosePairCandidate` + `connect()`/`clearGateAndStart()` does that.
   */
  async listPairCandidates(opts: {
    allowLaunch: boolean
  }): Promise<PairCandidate[]> {
    requireProtocolBrowser(this.opts.clientInfo.browser)
    const results = await this.discoveryService.discoverForFirstPair(opts)
    return results.map((r: DiscoveryResult) => ({
      port: r.wsPort,
      instanceId: r.instanceId ?? null,
      appVersion: r.appVersion ?? null,
    }))
  }

  /** Capabilities reported by the server during initialize handshake; null
   *  until the first successful handshake. */
  getServerCapabilities(): {
    ffmpegAvailable: boolean
    selectionKinds: string[]
    taskReveal: boolean
    downloadDirectories?: boolean | undefined
  } | null {
    return this.serverCapabilities
  }

  /** Re-read capabilities over the authenticated session without reconnecting,
   * launching Motrix, changing consent, or replaying a download. MDXP initialize
   * is a capability exchange; reuse exactly the session's original declaration. */
  refreshServerCapabilities(): Promise<
    ReturnType<ConnectionManager['getServerCapabilities']>
  > {
    if (this.capabilitiesRefreshFlight) return this.capabilitiesRefreshFlight
    const request = this.initializeRequest
    const scope = this.currentEndpointScope
    if (this.state !== 'connected' || !request || !scope)
      return Promise.resolve(null)
    const generation = this.generation
    const flight = (async () => {
      const rawResult = await this.request(
        Methods.MotrixInitialize,
        request.params
      )
      this.ensureCurrentConnection(generation, request.conn)
      const result = InitializeResultSchema.parse(rawResult)
      const expectedRuntime =
        scope.endpointConfig.mode === 'local' ? 'electron' : 'server'
      if (result.server.runtime !== expectedRuntime) {
        throw new BackendCompatibilityError(
          'unsupportedRemote',
          'Motrix runtime changed during capability refresh'
        )
      }
      this.captureCapabilities(result.capabilities)
      return this.getServerCapabilities()
    })()
    this.capabilitiesRefreshFlight = flight
    const release = () => {
      if (this.capabilitiesRefreshFlight === flight)
        this.capabilitiesRefreshFlight = null
    }
    void flight.then(release, release)
    return flight
  }

  /** Identity reported by the backend during the latest successful handshake. */
  getServerIdentity(): ServerIdentity | null {
    return this.serverIdentity === null ? null : { ...this.serverIdentity }
  }

  /**
   * Whether this session's pairing completed without native-host
   * attestation — no proof of *which* Motrix answered, though the pairing
   * itself was still mutually authenticated by the code. `null` when no
   * first-pair has run this session (see the field doc on `degraded`).
   */
  getDegraded(): boolean | null {
    return this.degraded
  }

  /**
   * Issue a typed MDXP request over the live connection. Used by the
   * background control-plane proxy (popup → bg.* → here → WS). Throws if the
   * session is not connected — callers surface that to the popup as an error.
   */
  async request<M extends keyof MdxpRequestMap>(
    method: M,
    params: MdxpRequestMap[M][0]
  ): Promise<MdxpRequestMap[M][1]> {
    const conn = this.currentConn
    if (conn === null || this.state !== 'connected') {
      throw new Error(`bridge not connected (state: ${this.state})`)
    }
    return this.rpcRecovery.request(method, params)
  }

  getRpcStatus(): import('@/shared/integration').RpcStatus {
    return this.rpcRecovery.snapshot()
  }

  private async recoverRpcSession(
    session: RpcSession,
    timeoutMs: number
  ): Promise<RpcSession> {
    this.ensureCurrentConnection(session.generation, session.conn)
    const scope = this.currentEndpointScope
    if (!scope || timeoutMs <= 0) throw new Error('RPC recovery expired')
    this.stopCurrentAttempt()
    const work = this.connectExpected(
      { allowLaunch: false, userInitiated: false, allowFirstPair: false },
      scope
    )
    const generation = this.generation
    try {
      await rpcDeadline(work, timeoutMs, 'connection recovery')
    } catch (error) {
      if (this.generation === generation) this.stopCurrentAttempt()
      throw error
    }
    if (
      this.generation !== generation ||
      !this.currentConn ||
      this.getState() !== 'connected'
    )
      throw new Error('RPC recovery unavailable')
    return { conn: this.currentConn, generation }
  }

  /** Hand a browser-detected download to Motrix (the page-shaped submit path).
   *  The trigger gesture (resolve active tab → build these params) lands with
   *  real adapter extraction; this is the reachable, typed submit capability. */
  async submitDownload(
    params: DownloadSubmitParams,
    options: {
      automaticTakeover?: boolean
      directoryInstanceId?: string | undefined
      assertCurrent?: () => void
      onSubmitting?: () => Promise<void>
    } = {}
  ): Promise<DownloadSubmitResult> {
    options.assertCurrent?.()
    let outbound = params
    const scope = this.currentEndpointScope
    if (scope?.authority.kind === 'remote') {
      const conn = this.currentConn
      const instanceId = this.currentAuthenticatedInstanceId
      if (instanceId === null || conn === null) {
        throw new Error('authenticated remote instance is unavailable')
      }
      const policy = await this.remotePolicyFor(scope, instanceId).get()
      this.ensureCurrentConnection(scope.generation, conn)
      if (options.automaticTakeover && !policy.allowAutomaticTakeover) {
        throw new RemoteAutomaticTakeoverConsentRequiredError()
      }
      outbound = applyRemoteSubmitPolicy(params, policy)
    }
    // Every logical submit carries an idempotency key. Motrix scopes it to the
    // stable extension identity (browser + extensionId) within its bounded
    // process-local cache. A lost response does not prove the cache still
    // retains the result. Callers reuse their key; an unkeyed call starts a new
    // logical submit and therefore receives a fresh key here.
    const withKey: DownloadSubmitParams = outbound.idempotencyKey
      ? outbound
      : { ...outbound, idempotencyKey: crypto.randomUUID() }
    options.assertCurrent?.()
    const conn = this.currentConn
    const generation = this.generation
    if (
      conn === null ||
      this.state !== 'connected' ||
      this.getRpcStatus().health !== 'healthy'
    ) {
      throw new DownloadPreparationError(DOWNLOAD_ERROR.connectionFailed)
    }
    const assertDirectory = () => {
      if (params.saveDir === undefined) return
      if (this.serverCapabilities?.downloadDirectories !== true)
        throw new DownloadPreparationError(DOWNLOAD_ERROR.directoryUnavailable)
      if (
        !options.directoryInstanceId ||
        options.directoryInstanceId !== this.currentAuthenticatedInstanceId
      )
        throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
    }
    assertDirectory()
    await options.onSubmitting?.()
    options.assertCurrent?.()
    this.ensureCurrentConnection(generation, conn)
    assertDirectory()
    try {
      const result = DownloadSubmitResultSchema.safeParse(
        await this.request(Methods.DownloadSubmit, withKey)
      )
      if (!result.success) throw new DownloadOutcomeUnknownError()
      return result.data
    } catch (error) {
      // Only explicit pre-dispatch rejections prove that no task was accepted.
      // Transport loss, cancellation and generic server errors may arrive after
      // task creation. Never automatically retry or browser-fallback those.
      if (error instanceof RpcNotReadyError) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.connectionFailed)
      }
      const code = (error as { code?: unknown } | null)?.code
      if (
        code === ErrorCodes.InvalidParams &&
        (error as { data?: { appCode?: string } })?.data?.appCode ===
          'download-directory-unavailable'
      ) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.directoryUnavailable)
      }
      if (code === ErrorCodes.CapabilityNotSupported) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.unsupported)
      }
      const rejected: unknown[] = [
        ErrorCodes.ParseError,
        ErrorCodes.InvalidRequest,
        ErrorCodes.MethodNotFound,
        ErrorCodes.InvalidParams,
        ErrorCodes.PermissionDenied,
        ErrorCodes.RateLimited,
        ErrorCodes.PairRevoked,
      ]
      if (rejected.includes(code)) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
      }
      throw new DownloadOutcomeUnknownError()
    }
  }

  /** Current remote authority's consent, bound to the MBP1-authenticated
   * instance. Local or disconnected sessions have no remote policy surface. */
  async getRemoteBackendPolicy(): Promise<RemoteBackendPolicyV1 | null> {
    const scope = this.currentEndpointScope
    const instanceId = this.currentAuthenticatedInstanceId
    if (scope?.authority.kind !== 'remote' || instanceId === null) return null
    return this.remotePolicyFor(scope, instanceId).get()
  }

  /** Replace the complete remote grant set. Callback/takeover grants remain
   * unavailable in this beta because the remote initialize path deliberately
   * registers none of those handlers. Any change closes the live channel so
   * the next connection renegotiates capabilities from the new policy. */
  async replaceRemoteBackendPolicy(
    replacement: RemoteBackendPolicyReplacement
  ): Promise<RemoteBackendPolicyV1> {
    if (
      replacement.allowServerUrlProbe ||
      replacement.allowServerUrlResolve ||
      replacement.allowAutomaticTakeover
    ) {
      throw new Error(
        'remote callback and automatic takeover grants unavailable'
      )
    }
    const scope = this.currentEndpointScope
    const instanceId = this.currentAuthenticatedInstanceId
    if (scope?.authority.kind !== 'remote' || instanceId === null) {
      throw new Error('no authenticated remote Server is active')
    }
    const store = this.remotePolicyFor(scope, instanceId)
    await store.replace(replacement)
    const policy = await store.get()
    this.stop()
    // The message response is the durability/renegotiation acknowledgement
    // consumed by the options UI. Returning while connect() is still in
    // flight lets an immediate MV3 page reload capture `bootstrapping` with
    // no later state subscription to correct it. Complete this single
    // attempt before acknowledging the policy change; connect() already
    // contains failures and leaves an authoritative terminal state.
    await this.connect({
      allowLaunch: false,
      userInitiated: true,
      allowFirstPair: false,
      intent: 'retry-connection',
    })
    return policy
  }

  /** Cancel a previously submitted download by its task id. */
  async cancelDownload(taskId: string): Promise<void> {
    await this.request(Methods.DownloadCancel, { taskId })
  }

  onStateChange(cb: (s: ConnectionState) => void): void {
    this.stateListeners.push(cb)
  }

  /** Restored notifications may only reach the same authenticated endpoint. */
  isNotificationSourceCurrent(source: NotificationSource): boolean {
    const scope = this.currentEndpointScope
    return (
      this.state === 'connected' &&
      scope !== null &&
      source.instanceId !== null &&
      source.instanceId === this.currentAuthenticatedInstanceId &&
      source.endpointId === scope.activeEndpointId &&
      source.endpointRevision ===
        (scope.endpointConfig.mode === 'remote'
          ? scope.endpointConfig.revision
          : 0)
    )
  }

  onActivityChange(cb: () => void): void {
    this.taskEvents.onChange(cb)
  }

  hasActiveTasks(): boolean {
    return this.taskEvents.size > 0
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return
    this.state = s
    if (s === 'disconnected' || s === 'denied') this.connectionPhase = 'idle'
    if (s === 'connected') this.connectionPhase = 'ready'
    for (const cb of this.stateListeners) cb(s)
  }

  private clearPresentationVerdict(): void {
    this.lastErrorMessage = null
    this.lastErrorReason = null
    this.lastErrorRetryAtMs = null
    this.pendingPairingCode = null
    this.lastAttemptIntent = null
  }

  private adoptPresentationEndpoint(incarnation: EndpointIncarnation): void {
    if (
      this.presentationEndpointIncarnation !== null &&
      isSameEndpointIncarnation(
        this.presentationEndpointIncarnation,
        incarnation
      )
    ) {
      return
    }
    this.clearPresentationVerdict()
    this.presentationEndpointIncarnation = incarnation
  }

  private endpointIncarnationFromAttempt(
    attempt: CurrentBackendAttempt
  ): EndpointIncarnation {
    if (attempt.authority.kind === 'local') {
      return {
        activeEndpointId: LOCAL_ENDPOINT_ID,
        endpointConfig: { mode: 'local' },
        authority: LOCAL_BACKEND_AUTHORITY,
        gate: this.gate,
      }
    }
    if (attempt.canonicalWsBase === null)
      throw new StaleConnectionAttemptError()
    const endpointConfig: ResolvedEndpointConfig = {
      mode: 'remote',
      endpointId: attempt.endpointId,
      remoteUrl: attempt.canonicalWsBase,
      revision: attempt.revision,
    }
    return {
      activeEndpointId: attempt.endpointId,
      endpointConfig,
      authority: attempt.authority,
      gate: ConnectionGate.forAuthority(attempt.authority),
    }
  }

  private bindAttemptScope(
    incarnation: EndpointIncarnation,
    generation: number,
    lease: BackendAttemptLease,
    mutation: BackendAttemptMutationCapability
  ): EndpointAttemptScope {
    const credentials = this.credentialStore.forAttempt(
      incarnation.authority,
      mutation
    )
    const scope: EndpointAttemptScope = {
      ...incarnation,
      generation,
      lease,
      mutation,
      credentials,
    }
    return scope
  }

  private async captureEndpointAttempt(
    generation: number,
    expected: EndpointIncarnation | null = null
  ): Promise<EndpointAttemptScope> {
    this.ensureCurrentAttempt(generation)
    const lease = await this.endpointLifecycleService.issueBackendAttemptLease(
      expected?.activeEndpointId
    )
    this.ensureCurrentAttempt(generation)
    return this.endpointLifecycleService.runWithBackendAttemptLease(
      lease,
      async (attempt) => {
        this.ensureCurrentAttempt(generation)
        const incarnation = this.endpointIncarnationFromAttempt(attempt)
        if (
          expected !== null &&
          !isSameEndpointIncarnation(incarnation, expected)
        ) {
          throw new StaleConnectionAttemptError()
        }
        this.adoptPresentationEndpoint(incarnation)
        const mutation = this.endpointLifecycleService.bindBackendAttemptLease(
          lease,
          (currentAttempt) => {
            this.ensureCurrentAttempt(generation)
            const current = this.endpointIncarnationFromAttempt(currentAttempt)
            if (!isSameEndpointIncarnation(current, incarnation)) {
              throw new StaleConnectionAttemptError()
            }
          }
        )
        return this.bindAttemptScope(incarnation, generation, lease, mutation)
      }
    )
  }

  /**
   * The only path from a live attempt to durable gate/credential mutation.
   * The coordinator is held for one storage operation, never for discovery,
   * network I/O, user code entry, or the MDXP handshake.
   */
  private async runEndpointMutation<T>(
    scope: EndpointAttemptScope,
    operation: () => Promise<T>
  ): Promise<T> {
    return scope.mutation.run(async (attempt) => {
      this.ensureCurrentAttempt(scope.generation)
      const current = this.endpointIncarnationFromAttempt(attempt)
      if (!isSameEndpointIncarnation(current, scope)) {
        throw new StaleConnectionAttemptError()
      }
      const result = await operation()
      this.ensureCurrentAttempt(scope.generation)
      return result
    })
  }

  private remotePolicyFor(
    scope: EndpointAttemptScope,
    authenticatedInstanceId: string
  ) {
    if (scope.authority.kind !== 'remote') {
      throw new Error('remote policy requires a remote authority')
    }
    return createLeaseBoundRemoteBackendPolicyStore(
      scope.authority,
      authenticatedInstanceId,
      scope.mutation
    )
  }

  private ownPreAuthChannel(
    channel: Mbp1FrameChannel,
    generation: number
  ): void {
    this.ensureCurrentAttempt(generation)
    if (this.preAuthChannel !== null && this.preAuthChannel !== channel) {
      try {
        channel.close()
      } catch {
        // best-effort
      }
      throw new StaleConnectionAttemptError()
    }
    this.preAuthChannel = channel
  }

  private closePreAuthChannel(channel?: Mbp1FrameChannel): void {
    if (channel !== undefined && this.preAuthChannel !== channel) {
      // The manager may already have closed/disowned it during stop(). A
      // second close is required to be harmless by FrameChannel's contract.
      try {
        channel.close()
      } catch {
        // best-effort
      }
      return
    }
    const owned = this.preAuthChannel
    this.preAuthChannel = null
    if (owned === null) return
    try {
      owned.close()
    } catch {
      // best-effort
    }
  }

  private releasePreAuthChannel(
    channel: Mbp1FrameChannel,
    generation: number
  ): { socket: WebSocket; queuedFrames: Uint8Array[] } {
    this.ensureCurrentAttempt(generation)
    if (this.preAuthChannel !== channel) {
      throw new StaleConnectionAttemptError()
    }
    const released = channel.release()
    this.preAuthChannel = null
    return released
  }

  /** Low-level single attempt. Launch, error presentation and first pairing
   * are independent permissions. Product callers use ensureReady or the
   * explicit pairing/retry entry instead of choosing these flags themselves. */
  async connect(opts: {
    allowLaunch: boolean
    userInitiated: boolean
    allowFirstPair?: boolean
    intent?: ConnectionIntent
  }): Promise<void> {
    await this.connectExpected(opts, null, this.takePreferredCandidatePort())
  }

  private async connectExpected(
    opts: {
      allowLaunch: boolean
      userInitiated: boolean
      allowFirstPair?: boolean
      intent?: ConnectionIntent
    },
    expected: EndpointIncarnation | null,
    preferredCandidatePort: number | null = null
  ): Promise<void> {
    requireProtocolBrowser(this.opts.clientInfo.browser)
    if (this.state !== 'disconnected' && this.state !== 'denied') {
      log.warn('connect called in state', this.state)
      return
    }

    // Claim ownership before the first await. Two callers can both observe
    // `disconnected`; the newer generation wins and the older gate read is
    // discarded when it resumes.
    const generation = ++this.generation
    if (this.state === 'denied') {
      this.lastErrorMessage = null
      this.lastErrorReason = null
      this.lastErrorRetryAtMs = null
      this.setState('disconnected')
    }

    let scope: EndpointAttemptScope | null = null
    try {
      // Select both the durable gate and the credential namespace from the
      // same strict endpoint snapshot. In particular, a cleanup-pending
      // remote selection can never fall through to the injected local gate.
      const attemptScope = await this.captureEndpointAttempt(
        generation,
        expected
      )
      scope = attemptScope
      this.lastAttemptIntent =
        opts.intent ?? (opts.userInitiated ? 'first-pair' : 'background-probe')
      this.ensureCurrentAttempt(generation)

      // SW-restart safety: skip auto-attempt if a pair attempt is still
      // pending (within the gate's TTL) or the user previously hit 'denied'.
      // Surfaces the prior error so the popup can offer Reconnect, which
      // calls clearGateAndStart() to override.
      const shouldAutoConnect = await this.runEndpointMutation(
        attemptScope,
        () => attemptScope.gate.shouldAutoConnect()
      )
      if (!this.isCurrentAttempt(generation)) return
      if (!shouldAutoConnect) {
        const gateState = await this.runEndpointMutation(attemptScope, () =>
          attemptScope.gate.get()
        )
        if (!this.isCurrentAttempt(generation)) return
        log.info(
          `connect gated (reason=${gateState.reason ?? 'unknown'}); ` +
            'awaiting explicit reconnect.'
        )
        this.lastErrorMessage = gateState.lastError
        // Nothing structured survives a persisted gate read across a
        // SW restart — only the plain message does.
        this.lastErrorReason = null
        this.lastErrorRetryAtMs = null
        this.setState(gateState.reason === 'denied' ? 'denied' : 'disconnected')
        return
      }

      // Re-check state after the gate await: the synchronous guard above
      // doesn't protect against two callers racing through it before either
      // reaches connectOnce's setState('bootstrapping').
      if (!this.isCurrentAttempt(generation) || this.state !== 'disconnected') {
        log.warn(`connect raced past gate; aborting (state: ${this.state})`)
        return
      }

      // A proceeding attempt supersedes the previous verdict: `lastError*`
      // describes the most recent COMPLETED attempt, so a live attempt must
      // never sit beside its predecessor's failure.
      this.lastErrorMessage = null
      this.lastErrorReason = null
      this.lastErrorRetryAtMs = null

      await this.connectOnce(
        opts.allowLaunch,
        opts.userInitiated,
        attemptScope,
        preferredCandidatePort,
        opts.allowFirstPair ?? opts.userInitiated
      )
    } catch (e) {
      // A superseded attempt owns neither the visible error/state nor the
      // currently selected endpoint's socket, token, or gate.
      if (!this.isCurrentAttempt(generation)) return
      this.lastErrorMessage = (e as Error).message
      // `PairingFlowError`/`ReconnectFlowError` both carry `reason`, and the
      // former carries `retryAtMs` for `'backoffLocked'` — duck-typed rather
      // than an instanceof check against either class, since both shapes
      // mean the same thing to a UI: "here is why, and (maybe) when to
      // retry, straight from the client's own counter."
      const detail = e as { reason?: unknown; retryAtMs?: unknown }
      this.lastErrorReason =
        typeof detail.reason === 'string' ? detail.reason : null
      this.lastErrorRetryAtMs =
        typeof detail.retryAtMs === 'number' ? detail.retryAtMs : null
      // Connecting on SW wake / autostart routinely fails for fully benign
      // reasons (Motrix not running, NM host not installed). Logging those at
      // `error` cries wolf and buries genuine faults — classify by level.
      const { level, reason } = classifyConnectError(e)
      if (level === 'error') {
        log.error('connect failed', e)
      } else {
        log[level](`not connected: ${reason}`)
      }
      if (this.shouldEnterDenied(e)) {
        await this.enterDenied(e, scope, generation)
      } else {
        // Release the socket before going dormant. A failed attempt otherwise
        // leaves WebSocketClient.this.ws set, so the next connect() throws
        // 'already connected' until a browser restart. Keep ownership of the
        // explicit single-flight until its promise settles; only an external
        // lifecycle stop is allowed to invalidate it early.
        this.stopCurrentAttempt()
      }
    }
  }

  /**
   * SW-startup auto-attach: only if previously paired, and never wakes
   * Motrix (allowLaunch:false = probe-only).
   *
   * Both local and remote endpoints require an authority-scoped committed
   * MBP1 credential before any discovery or socket work. Token-era storage is
   * never a proof of pairing and is never consulted.
   */
  async autostart(): Promise<void> {
    if (!supportsBackendConnections(this.opts.clientInfo.browser)) return
    const generation = this.generation
    const scope = await this.captureEndpointAttempt(generation)
    if (!this.isCurrentAttempt(generation)) return

    const principal: Principal = {
      browser: requireProtocolBrowser(this.opts.clientInfo.browser),
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
    if (!this.isCurrentAttempt(generation)) return
    const order = await scope.credentials.recoverOrder(principal)
    if (!this.isCurrentAttempt(generation)) return
    if (order.length === 0) {
      log.info('autostart: no stored credential → dormant')
      return
    }

    await this.connectExpected(
      { allowLaunch: false, userInitiated: false },
      scope
    )
  }

  /** Explicit Pair/Retry action. Retained credentials still never fall
   * through to first pairing; automatic downloads must use ensureReady. */
  clearGateAndStart(): Promise<void> {
    const active = this.explicitConnectFlight ?? this.readyFlight
    if (active !== null) return active

    this.rpcRecovery.reset()
    const flight = this.runExplicitConnect()
    this.explicitConnectFlight = flight
    const release = (): void => {
      if (this.explicitConnectFlight === flight) {
        this.explicitConnectFlight = null
      }
    }
    // Both handlers consume the derived promise successfully, while callers
    // still receive the original rejection. `finally()` would create a new
    // rejected promise that nobody owns when a fire-and-forget caller starts
    // the flight.
    void flight.then(release, release)
    return flight
  }

  private async runExplicitConnect(): Promise<void> {
    requireProtocolBrowser(this.opts.clientInfo.browser)
    // Claim an explicit picker result before any await or internal stop. It
    // now belongs only to this lifecycle intent; if the intent is stale or
    // cannot start, the choice is discarded rather than leaking into a later
    // unrelated pairing attempt.
    const preferredCandidatePort = this.takePreferredCandidatePort()
    // An attempt awaiting the user's code IS the freshest state a restart
    // could produce; every surface polls the same prompt, so keep it. A
    // restart here would dismiss what the user is reading and burn another
    // §7.3 admission (the server answers `busy` while the first session is
    // still pending). The prompt self-expires (§7.2), so this cannot wedge.
    if (this.state === 'awaiting-code') return
    const revocationCleanup = this.pendingRevocationCleanup
    if (revocationCleanup !== null) await revocationCleanup
    const intentGeneration = this.generation
    const intent = await this.captureEndpointAttempt(intentGeneration)
    await this.runEndpointMutation(intent, () => intent.gate.clear())
    if (this.state !== 'disconnected' && this.state !== 'denied') {
      this.stopCurrentAttempt()
    }
    await this.connectExpected(
      {
        allowLaunch: true,
        userInitiated: true,
        allowFirstPair: true,
        intent: 'first-pair',
      },
      intent,
      preferredCandidatePort
    )
  }

  stop(): void {
    this.rpcRecovery.reset()
    // A lifecycle boundary (endpoint edit/switch, explicit unpair, policy
    // replacement) must never make the next intent join work it just
    // invalidated. The old flight's guarded completion cannot clear a newer
    // replacement.
    this.explicitConnectFlight = null
    this.readyFlight = null
    this.stopCurrentAttempt()
  }

  private stopCurrentAttempt(): void {
    // Invalidate continuations and callbacks before close(), which may fire a
    // close callback synchronously in test doubles (and asynchronously in the
    // browser).
    this.generation += 1
    this.preferredCandidatePort = null
    this.pendingPairingCode = null
    this.closePreAuthChannel()
    try {
      this.currentConn?.dispose()
    } catch {
      /* best effort */
    }
    try {
      this.client.close()
    } catch {
      // best-effort
    }
    if (this.currentMbp1Socket !== null) {
      try {
        this.currentMbp1Socket.close()
      } catch {
        // best-effort
      }
      this.currentMbp1Socket = null
    }
    this.currentConn = null
    this.currentEndpointScope = null
    this.currentAuthenticatedInstanceId = null
    this.serverCapabilities = null
    this.initializeRequest = null
    this.capabilitiesRefreshFlight = null
    this.serverIdentity = null
    this.degraded = null
    this.taskEvents.clear()
    this.setState('disconnected')
  }

  /** Stop because the selected endpoint is about to change. Unlike a normal
   * transport stop after a failed attempt, this synchronously retires the
   * old endpoint's process-local verdict before listeners render the
   * disconnected transition. Durable gate/error state remains in its own
   * authority namespace and can be shown again only if that endpoint is
   * selected later. */
  stopForEndpointChange(): void {
    this.clearPresentationVerdict()
    this.presentationEndpointIncarnation = null
    this.stop()
  }

  private async connectOnce(
    allowLaunch: boolean,
    userInitiated: boolean,
    scope: EndpointAttemptScope,
    preferredCandidatePort: number | null,
    allowFirstPair: boolean
  ): Promise<void> {
    const { generation, endpointConfig } = scope
    this.ensureCurrentAttempt(generation)
    const seq = ++this.attemptSeq
    this.serverIdentity = null
    this.degraded = null
    this.connectionPhase = 'probing'
    this.setState('bootstrapping')
    log.info(
      `[connect#${seq}] connectOnce start; mode=${endpointConfig.mode} ` +
        `allowLaunch=${allowLaunch} userInitiated=${userInitiated}`
    )

    // MBP1 (§6/§8) replaces the retired NM-discover + token path
    // entirely for a local endpoint. `connectLocalMbp1` owns everything from
    // here on for that branch — including its own state transitions,
    // `doInitialize` call, gate handling, and completion — and returns
    // without falling through to the remote-only code below.
    if (endpointConfig.mode === 'local') {
      await this.connectLocalMbp1(
        seq,
        allowLaunch,
        userInitiated,
        scope,
        preferredCandidatePort,
        allowFirstPair
      )
      return
    }

    await this.connectRemoteMbp1(seq, userInitiated, scope, allowFirstPair)
  }

  private async connectRemoteMbp1(
    seq: number,
    userInitiated: boolean,
    scope: EndpointAttemptScope,
    allowFirstPair: boolean
  ): Promise<void> {
    const { generation, authority } = scope
    if (authority.kind !== 'remote') throw new StaleConnectionAttemptError()
    const principal: Principal = {
      browser: requireProtocolBrowser(this.opts.clientInfo.browser),
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
    this.ensureCurrentAttempt(generation)

    const now = Date.now()
    await scope.credentials.ageOutUnacked(now)
    await scope.credentials.cleanupFirstPairOrphans(principal, now)
    const order = await scope.credentials.recoverOrder(principal)
    this.ensureCurrentAttempt(generation)

    const route = deriveRemoteBridgeRoute(authority as RemoteBackendAuthority)
    const discovery = await this.remoteDiscoveryService.discover(route)
    this.ensureCurrentAttempt(generation)
    if (discovery.status === 'incompatible') {
      throw new BackendCompatibilityError(
        discovery.reason,
        discovery.reason === 'extensionUpgradeRequired'
          ? 'the configured Server requires a newer extension'
          : 'the configured Server requires a newer Motrix version'
      )
    }
    if (discovery.status !== 'compatible') {
      throw new RemoteConnectionError(
        'remoteDiscoveryUnavailable',
        `remote Motrix Server discovery is unavailable (${discovery.detail})`
      )
    }

    this.setState('connecting')
    for (const credential of order) {
      const instanceId = credential.authenticatedInstanceId
      if (instanceId === null || instanceId === undefined) continue
      const channel = this.createFrameChannel()
      this.ownPreAuthChannel(channel, generation)
      try {
        this.lastConnectUrl = route.v1Url
        const flow = this.createReconnectFlow({
          channel,
          creds: scope.credentials,
          pins: this.pinStore,
          isCurrent: () => this.isCurrentAttempt(generation),
        })
        const result = await flow.run({
          credential,
          discovery: {
            transport: 'probe',
            wsPort: 0,
            instanceId: discovery.untrustedDocument.instanceId,
            appVersion: discovery.untrustedDocument.appVersion,
            compatibility: 'compatible',
          },
          principal,
          instanceId,
          remoteV1Url: route.v1Url,
        })
        this.ensureCurrentAttempt(generation)
        await this.finishMbp1Connection(
          channel,
          result.envelope,
          scope,
          seq,
          false,
          instanceId
        )
        return
      } catch (error) {
        this.closePreAuthChannel(channel)
        this.ensureCurrentAttempt(generation)
        if (error instanceof ReconnectFlowError) {
          if (
            error.reason === 'channelUnavailable' ||
            error.reason === 'internalError'
          ) {
            if (error.reason === 'channelUnavailable') {
              throw new RemoteConnectionError(
                'remoteTransportUnavailable',
                'the remote Motrix WebSocket could not be opened'
              )
            }
            throw error
          }
          continue
        }
        throw error
      }
    }

    if (!userInitiated) throw new RecoveryExhaustedUnattendedError()
    if (order.length > 0) throw new StoredPairingUnavailableError()
    if (!allowFirstPair)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.pairingRequired)
    if (this.opts.pairingCodeSource === undefined) {
      throw new Error(
        'first-pair requires a pairing code source; none configured'
      )
    }
    const nonce = await this.remoteDiscoveryService.requestNonce(discovery)
    this.ensureCurrentAttempt(generation)
    if (nonce.status !== 'ready') {
      throw new RemoteConnectionError(
        'remotePairingUnavailable',
        'remote Motrix Server pairing nonce is unavailable'
      )
    }
    const codeSource = this.wrapPairingCodeSource(
      this.opts.pairingCodeSource,
      scope
    )
    const channel = this.createFrameChannel()
    this.ownPreAuthChannel(channel, generation)
    try {
      const pairUrl = remotePairUrl(route, nonce.nonce)
      this.lastConnectUrl = pairUrl
      const flow = this.createPairingFlow({
        channel,
        creds: scope.credentials,
        pins: this.pinStore,
        backoff: this.firstPairBackoff,
        isCurrent: () => this.isCurrentAttempt(generation),
      })
      const result = await flow.run({
        code: codeSource,
        discovery: {
          transport: 'probe',
          wsPort: 0,
          nonce: nonce.nonce,
          instanceId: discovery.untrustedDocument.instanceId,
          appVersion: discovery.untrustedDocument.appVersion,
          compatibility: 'compatible',
        },
        principal,
        claimedExtensionId: this.opts.clientInfo.extensionId,
        remotePairUrl: pairUrl,
      })
      this.degraded = true
      this.ensureCurrentAttempt(generation)
      await this.finishMbp1Connection(
        channel,
        result.envelope,
        scope,
        seq,
        true,
        result.instanceId
      )
    } catch (error) {
      this.closePreAuthChannel(channel)
      if (
        error instanceof PairingFlowError &&
        error.reason === 'channelUnavailable'
      ) {
        throw new RemoteConnectionError(
          'remoteTransportUnavailable',
          'the remote Motrix pairing WebSocket could not be opened'
        )
      }
      throw error
    }
  }

  /**
   * The local-endpoint half of `connectOnce`: MBP1 (§6/§8) end to end,
   * entirely replacing the retired NM-discover + token path for this
   * mode. Owns its own state transitions and its own call into
   * `doInitialize` — `connectOnce` does not fall through to the remote-only
   * code after this returns.
   *
   * The `Principal` computed here (verifiedOrigin, clientInstallationId,
   * browser) is what every MBP1 module downstream consumes but nothing
   * before this task constructed — see `verified-origin.ts`'s doc for why
   * `verifiedOrigin` in particular must be exact.
   */
  private async connectLocalMbp1(
    seq: number,
    allowLaunch: boolean,
    userInitiated: boolean,
    scope: EndpointAttemptScope,
    preferredCandidatePort: number | null,
    allowFirstPair: boolean
  ): Promise<void> {
    const { generation } = scope
    const principal: Principal = {
      browser: requireProtocolBrowser(this.opts.clientInfo.browser),
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
    this.ensureCurrentAttempt(generation)

    // §6.7 MAY-level housekeeping, run at the point the store is actually
    // about to be loaded for this attempt: age out `unacked` provisionals
    // whose write-ahead never landed (so no `credentialAck` could
    // legitimately still be pending for them), and drop this principal's
    // own first-pair orphans once the server's provisional TTL has
    // provably elapsed. Neither deletes anything an authenticated
    // reconnect could still need (see their own docs) — without this, the
    // retained set never shrinks except opportunistically inside
    // `writeProvisionalUnacked`, which only runs when a *new* offer
    // arrives.
    const now = Date.now()
    await scope.credentials.ageOutUnacked(now)
    this.ensureCurrentAttempt(generation)
    await scope.credentials.cleanupFirstPairOrphans(principal, now)
    this.ensureCurrentAttempt(generation)

    // §6.7/§12: walk the full recovery order. Retained credentials never
    // fall through to fresh pairing; the user must explicitly remove that
    // pairing first.
    const order = await scope.credentials.recoverOrder(principal)
    this.ensureCurrentAttempt(generation)

    this.setState('connecting')

    let awakened: Map<string, DiscoveryResult> | null = null
    let foundEndpoint = false
    for (let pass = 0; pass < 2; pass++) {
      for (const credential of order) {
        const discovered =
          awakened === null
            ? await this.discoveryService.discoverForReconnect(
                credential.credentialId
              )
            : (awakened.get(credential.credentialId) ?? null)
        this.ensureCurrentAttempt(generation)
        if (discovered === null) {
          // §4.1 discovery found no live endpoint for this candidate at all —
          // an unauthenticated, replayable GET, not a WS upgrade attempt, so
          // none of §8's throttle concerns apply. Ordinary "try the next one".
          continue
        }

        foundEndpoint = true

        // §12: prefer the pin's instanceId (proven by an earlier verified
        // confirmB/reconnectAccept) over the untrusted §4.1 discovery hint —
        // the hint is only a fallback for when no pin exists yet.
        const pin = await this.pinStore.get(credential.credentialId)
        this.ensureCurrentAttempt(generation)
        const instanceId = pin?.instanceId ?? discovered.instanceId
        if (instanceId === undefined) continue

        const url = reconnectUrl(discovered.wsPort)
        this.lastConnectUrl = url
        log.info(
          `[connect#${seq}] MBP1 reconnect attempt port=${discovered.wsPort}`
        )

        const channel = this.createFrameChannel()
        this.ownPreAuthChannel(channel, generation)

        let result: ReconnectFlowResult
        try {
          const flow = this.createReconnectFlow({
            channel,
            creds: scope.credentials,
            pins: this.pinStore,
            isCurrent: () => this.isCurrentAttempt(generation),
          })
          this.connectionPhase = 'authenticating'
          result = await flow.run({
            credential,
            discovery: discovered,
            principal,
            instanceId,
          })
        } catch (error) {
          this.closePreAuthChannel(channel)
          // If THIS attempt is already stale, bail immediately rather than
          // trying another candidate on a superseded generation — this is
          // also what correctly handles a `superseded` ReconnectFlowError,
          // since it can only have been thrown because isCurrent() (exactly
          // this check) already returned false.
          this.ensureCurrentAttempt(generation)
          if (error instanceof ReconnectFlowError) {
            if (
              error.reason === 'channelUnavailable' ||
              error.reason === 'internalError'
            ) {
              // §8's per-origin/global reconnect throttle rejects the
              // WebSocket upgrade itself, indistinguishable on the wire from
              // "nothing is listening" — walking the recovery order against a
              // real throttle would make it worse while learning nothing. Fail
              // this whole attempt instead (connect() never auto-retries, so
              // this IS the backoff).
              throw error
            }
            log.info(
              `[connect#${seq}] MBP1 reconnect candidate failed ` +
                `(${error.reason}); trying next stored credential`
            )
            continue
          }
          throw error
        }
        // `flow.run()` just succeeded, so nothing has closed `channel` yet —
        // it only ever does that on its own failure (see
        // `WebSocketFrameChannel`'s own doc). A throw from here on (a
        // superseded generation, or `release()` itself rejecting a queued
        // text frame) would otherwise leave a live, unowned `WebSocket` open
        // with nothing to close it until the MV3 worker tears down.
        // `channel.close()` is always safe to call: it no-ops once
        // `release()` has already handed the socket to the envelope layer.
        try {
          this.ensureCurrentAttempt(generation)
          await this.finishMbp1Connection(
            channel,
            result.envelope,
            scope,
            seq,
            false,
            instanceId
          )
        } catch (error) {
          this.closePreAuthChannel(channel)
          throw error
        }
        return
      }

      // A concrete download or an explicit connection may wake a paired App.
      // Complete ordinary recovery first; never launch after an auth failure.
      if (
        pass !== 0 ||
        foundEndpoint ||
        order.length === 0 ||
        !userInitiated ||
        !allowLaunch
      )
        break
      this.connectionPhase = 'waking'
      awakened = await this.discoveryService.wakeForReconnect(
        order.map((c) => c.credentialId)
      )
      this.ensureCurrentAttempt(generation)
      if (awakened.size === 0) break
    }
    if (order.length > 0 && userInitiated) {
      throw new StoredPairingUnavailableError()
    }

    // §6.7/§12: exhausting the recovery order is not, by itself, a licence
    // for fresh code-entry pairing — that requires the user to have asked
    // (or an explicit revocation, which is a separate, `unpair`-driven
    // path). An unattended wake (autostart, the post-close probe-reconnect)
    // whose every stored credential failed leaves the retained set in
    // place and surfaces `RecoveryExhaustedUnattendedError` instead, so a
    // human never sees an approval dialog they never asked for and the
    // server's §7.3 lockout is never charged for a session nobody typed a
    // code into.
    if (!userInitiated) {
      throw new RecoveryExhaustedUnattendedError()
    }
    if (!allowFirstPair)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.pairingRequired)
    await this.connectFirstPairMbp1(
      seq,
      allowLaunch,
      scope,
      principal,
      preferredCandidatePort
    )
  }

  /**
   * §6: fresh code-entry pairing. Reached only when `connectLocalMbp1`'s
   * caller was `userInitiated` AND `recoverOrder` has no retained credentials
   * (including after an explicit Forget) — never on a reconnect failure, and
   * never for an unattended attempt (see `RecoveryExhaustedUnattendedError`).
   */
  private async connectFirstPairMbp1(
    seq: number,
    allowLaunch: boolean,
    scope: EndpointAttemptScope,
    principal: Principal,
    preferredCandidatePort: number | null
  ): Promise<void> {
    const { generation } = scope
    if (this.opts.pairingCodeSource === undefined) {
      throw new Error(
        'first-pair requires a pairing code source; none configured'
      )
    }
    const codeSource = this.wrapPairingCodeSource(
      this.opts.pairingCodeSource,
      scope
    )

    // One ephemeral keypair per real first-pair attempt. The public half goes
    // to the Native Host; the private half never leaves this call and is
    // forwarded to PairingFlow only if the host actually returned a ticket.
    const bindingKeypair: BindingKeypair = generateBindingKeypair()

    const candidates = await this.discoveryService.discoverForFirstPair({
      allowLaunch,
      bindingPub: bindingKeypair.pub,
    })
    this.ensureCurrentAttempt(generation)
    const candidate =
      preferredCandidatePort === null
        ? candidates[0]
        : (candidates.find((c) => c.wsPort === preferredCandidatePort) ??
          candidates[0])
    if (candidate === undefined) {
      throw new Error('no Motrix instance found to pair with')
    }
    const preflighted =
      await this.discoveryService.preflightCompatibility(candidate)
    this.ensureCurrentAttempt(generation)
    this.assertBackendCompatibility(preflighted)

    const withNonce = await this.discoveryService.ensureNonce(preflighted)
    this.ensureCurrentAttempt(generation)
    if (withNonce === null || withNonce.nonce === undefined) {
      throw new Error('could not obtain a §4.2 pairing nonce')
    }
    // This is the decision point the `degraded` field doc refers to:
    // `withNonce` is exactly what gets passed as `discovery` below, and
    // `PairingFlow.run` defaults `nmTicket` from `discovery.nmTicket` when
    // no explicit override is given (none is, here).
    this.degraded = withNonce.nmTicket === undefined

    const url = pairUrl(withNonce.wsPort, withNonce.nonce)
    this.lastConnectUrl = url
    log.info(
      `[connect#${seq}] MBP1 first-pair attempt port=${withNonce.wsPort}`
    )

    const channel = this.createFrameChannel()
    this.ownPreAuthChannel(channel, generation)
    try {
      const flow = this.createPairingFlow({
        channel,
        creds: scope.credentials,
        pins: this.pinStore,
        backoff: this.firstPairBackoff,
        isCurrent: () => this.isCurrentAttempt(generation),
      })

      const result: PairingFlowResult = await flow.run({
        code: codeSource,
        discovery: withNonce,
        principal,
        claimedExtensionId: this.opts.clientInfo.extensionId,
        // A ticketless Native Host reply and every HTTP-probe fallback must
        // omit the binding key entirely. Otherwise PairingFlow would bind
        // bytes into AAD that never appeared in pairHello.
        ...(withNonce.nmTicket === undefined ? {} : { bindingKeypair }),
      })
      this.ensureCurrentAttempt(generation)
      await this.finishMbp1Connection(
        channel,
        result.envelope,
        scope,
        seq,
        true,
        result.instanceId
      )
    } catch (error) {
      this.closePreAuthChannel(channel)
      throw error
    }
  }

  /**
   * Shared tail for both MBP1 branches: hand the live socket from the
   * pre-auth channel to a fresh envelope-wrapped transport layer, then run
   * the same `doInitialize` the remote path uses. This ordering matters:
   * MBP1 authenticates *below* MDXP, so `motrix/initialize` must be the
   * first application message and it must travel inside the envelope,
   * never before it.
   */
  private async finishMbp1Connection(
    channel: Mbp1FrameChannel,
    envelope: EnvelopeCodec,
    scope: EndpointAttemptScope,
    seq: number,
    isFirstPair: boolean,
    authenticatedInstanceId: string | null
  ): Promise<void> {
    const { generation } = scope
    const { socket, queuedFrames } = this.releasePreAuthChannel(
      channel,
      generation
    )
    let conn: MdxpConnection
    try {
      conn = this.createEnvelopeConnection(socket, envelope, queuedFrames)
    } catch (error) {
      try {
        socket.close()
      } catch {
        // best-effort
      }
      throw error
    }
    // Mirrors the remote path's own ordering exactly: check staleness
    // *before* publishing to `this.currentConn`/`this.currentMbp1Socket`,
    // never after. A superseded attempt that assigned first and checked
    // second could clobber a newer, already-live connection those fields
    // point to, and nothing would notice — `ensureCurrentConnection` below
    // would then observe its *own* (stale) value and wrongly pass.
    if (!this.isCurrentAttempt(generation)) {
      try {
        conn.dispose()
      } catch {
        // best-effort
      }
      try {
        socket.close()
      } catch {
        // best-effort
      }
      throw new StaleConnectionAttemptError()
    }
    this.currentConn = conn
    this.currentMbp1Socket = socket
    socket.addEventListener('close', () => this.handleClose(generation, conn))

    this.ensureCurrentConnection(generation, conn)
    this.connectionPhase = 'initializing'
    this.setState('handshaking')

    // By this point PairingFlow.run has already completed — the dialog was
    // shown, the code typed, confirmB verified, and the credential committed.
    // This only guards the motrix/initialize window that follows, not the
    // earlier user-dialog one (no committed credential exists during it, so
    // autostart() stays dormant). A reconnect is fast and not user-facing,
    // so it is not gated.
    if (isFirstPair) {
      this.ensureCurrentConnection(generation, conn)
      await this.runEndpointMutation(scope, () => scope.gate.pausePending())
      this.ensureCurrentConnection(generation, conn)
    }

    log.info(
      `[connect#${seq}] MBP1 handshake starting (firstPair=${isFirstPair})`
    )
    await this.doInitialize(conn, scope, generation, authenticatedInstanceId)
    this.ensureCurrentConnection(generation, conn)

    this.ensureCurrentConnection(generation, conn)
    await this.runEndpointMutation(scope, () => scope.gate.clear())
    this.ensureCurrentConnection(generation, conn)
    this.taskEvents.clear()
    this.currentEndpointScope = scope
    this.currentAuthenticatedInstanceId = authenticatedInstanceId
    this.setState('connected')
    this.lastErrorMessage = null
    this.lastErrorReason = null
    this.lastErrorRetryAtMs = null
  }

  private async doInitialize(
    conn: MdxpConnection,
    scope: EndpointAttemptScope,
    generation: number,
    authenticatedInstanceId: string | null
  ): Promise<void> {
    const allowBrowserData = scope.endpointConfig.mode === 'local'
    const remotePolicy =
      scope.authority.kind === 'remote' && authenticatedInstanceId !== null
        ? await this.remotePolicyFor(scope, authenticatedInstanceId).get()
        : null
    this.ensureCurrentConnection(generation, conn)
    const allowRemoteSubmit =
      remotePolicy !== null &&
      remotePolicy.remoteDataBoundaryAcceptedAt !== null
    const adapters = allowBrowserData
      ? (this.opts.adapterRegistry?.list() ?? [])
      : []
    const canResolve =
      allowBrowserData &&
      this.opts.resolutionDispatcher !== undefined &&
      adapters.length > 0

    // Register handlers BEFORE listen() so the first inbound message
    // (which could be a url/probe — Motrix is allowed to dispatch
    // immediately after our motrix/initialize reply) finds a handler.
    if (adapters.length > 0 && this.opts.adapterRegistry) {
      const registry = this.opts.adapterRegistry
      conn.onRequest(Methods.UrlProbe, async (params) => {
        if (!this.isCurrentConnection(generation, conn)) {
          return { handled: false }
        }
        const found = registry.findFor(params.url)
        return found
          ? {
              handled: true,
              adapterId: found.id,
              confidence: 'high' as const,
            }
          : { handled: false }
      })
    }
    if (canResolve && this.opts.resolutionDispatcher) {
      const dispatcher = this.opts.resolutionDispatcher
      conn.onRequest(Methods.UrlResolve, async (params) => {
        this.ensureCurrentConnection(generation, conn)
        return await dispatcher.resolve(params.url, params.preferences)
      })
    }

    const notificationSource: NotificationSource = {
      endpointId: scope.activeEndpointId,
      endpointRevision:
        scope.endpointConfig.mode === 'remote'
          ? scope.endpointConfig.revision
          : 0,
      instanceId: authenticatedInstanceId,
    }
    // Legacy unauthenticated instance identities cannot deduplicate across sessions.
    const notificationSession = authenticatedInstanceId ?? crypto.randomUUID()
    const notificationMetadata = (
      kind: string,
      taskId: string,
      code?: string
    ) => ({
      source: notificationSource,
      deduplicationKey: JSON.stringify([
        notificationSession,
        kind,
        taskId,
        code ?? null,
      ]),
      isCurrent: () => this.isCurrentConnection(generation, conn),
    })

    // Task lifecycle push notifications
    conn.onNotification(Notifications.TaskProgress, (p: TaskProgressParams) => {
      if (!this.isCurrentConnection(generation, conn)) return
      this.taskEvents.recordProgress(p)
      try {
        this.notify.taskProgress?.({
          taskId: p.taskId,
          bytesDone: p.bytesDone,
          phase: p.phase,
          source: notificationSource,
          isCurrent: () => this.isCurrentConnection(generation, conn),
        })
      } catch {
        // Advisory notification bookkeeping cannot interrupt task updates.
      }
    })
    conn.onNotification(
      Notifications.TaskCompleted,
      (p: TaskCompletedParams) => {
        if (!this.isCurrentConnection(generation, conn)) return
        this.taskEvents.take(p.taskId)
        const name = notificationText(
          p.filePath.split(/[\\/]/).pop() ?? '',
          300
        )
        this.notify({
          title: i18n.t('notify.downloadComplete'),
          message: name || i18n.t('notify.taskDetailsBody'),
          severity: 'confirm',
          kind: 'task.completed',
          ...notificationMetadata('completed', p.taskId),
          deduplicationMs: 7 * 24 * 60 * 60 * 1000,
        })
      }
    )
    conn.onNotification(Notifications.TaskError, (p: TaskErrorParams) => {
      if (!this.isCurrentConnection(generation, conn)) return
      const progress = this.taskEvents.take(p.taskId)
      this.notify({
        title: i18n.t('notify.downloadFailed'),
        message: i18n.t('notify.taskDetailsBody'),
        severity: 'error',
        kind: 'task.failed',
        failure: {
          taskId: p.taskId,
          ...(progress
            ? {
                progress: {
                  bytesDone: progress.bytesDone,
                  phase: progress.phase,
                },
              }
            : {}),
        },
        ...notificationMetadata('error', p.taskId, p.code),
        deduplicationMs: 10 * 60 * 1000,
      })
    })

    // Motrix tells us when the user revokes pairing from its UI. We must drop
    // the MBP1 credential and stop reconnecting; otherwise the ws-close that
    // follows triggers handleClose → reconnect and makes Disconnect appear
    // to do nothing.
    conn.onNotification(Notifications.PairRevoked, (params) => {
      if (!this.isCurrentConnection(generation, conn)) return
      void this.handlePairRevoked(params.reason, scope, generation, conn)
    })

    this.ensureCurrentConnection(generation, conn)
    conn.listen()
    const initializeParams: InitializeParams = {
      protocolVersion: '1.0',
      client: {
        ...this.opts.clientInfo,
        browser: requireProtocolBrowser(this.opts.clientInfo.browser),
      },
      capabilities: {
        submitDownload: allowBrowserData || allowRemoteSubmit,
        resolveUrl: canResolve,
        probeUrl: adapters.length > 0,
        cancellation: true,
        progress: true,
      },
      adapters,
    }
    const rawResult: unknown = await this.withTimeout(
      conn.sendRequest(Methods.MotrixInitialize, initializeParams),
      this.initializeTimeoutMs,
      Methods.MotrixInitialize
    )
    this.ensureCurrentConnection(generation, conn)
    const parsedResult = InitializeResultSchema.safeParse(rawResult)
    if (!parsedResult.success) {
      const reason = initializeCompatibilityFailureReason(rawResult)
      throw new BackendCompatibilityError(
        reason,
        reason === 'extensionUpgradeRequired'
          ? 'the authenticated Motrix backend requires a newer extension protocol version'
          : reason === 'unsupportedRemote'
            ? 'the authenticated Motrix runtime does not support browser-extension pairing'
            : 'the authenticated Motrix backend returned an incompatible motrix/initialize result; update Motrix'
      )
    }
    const result = parsedResult.data
    const expectedRuntime =
      scope.endpointConfig.mode === 'local' ? 'electron' : 'server'
    if (result.server.runtime !== expectedRuntime) {
      throw new BackendCompatibilityError(
        'unsupportedRemote',
        `the authenticated Motrix runtime is not the configured ${expectedRuntime} backend`
      )
    }
    this.ensureCurrentConnection(generation, conn)
    this.serverIdentity = {
      ...result.server,
      ...(authenticatedInstanceId === null
        ? {}
        : { instanceId: authenticatedInstanceId }),
    }
    this.captureCapabilities(result.capabilities)
    this.initializeRequest = { conn, params: initializeParams }
    conn.sendNotification(Notifications.MotrixInitialized, undefined)
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      })
      return await Promise.race([operation, timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  private handleClose(generation: number, conn: MdxpConnection): void {
    // onClose registrations can outlive their socket. Only the callback bound
    // to the currently owned protocol connection may tear down/reconnect.
    if (!this.isCurrentConnection(generation, conn)) return
    // 'denied' is terminal (pair denied or revoked) — never reconnect
    // automatically; wait for explicit user action.
    if (this.state === 'disconnected' || this.state === 'denied') return
    if (this.rpcRecovery.onSocketClosed({ conn, generation })) return
    if (
      this.rpcRecovery.isRecovering() ||
      this.getRpcStatus().health === 'unresponsive'
    ) {
      this.stopCurrentAttempt()
      return
    }
    log.info('WS closed; one probe-reconnect (allowLaunch:false)')
    this.stop() // releases the closed socket and invalidates duplicate callbacks
    // A Server restart closes the old socket before its replacement listener
    // is necessarily bound. Wait a short, bounded interval, then make exactly
    // one probe. A later stop/endpoint switch invalidates this generation, so
    // the timer can never reconnect a retired endpoint.
    const reconnectGeneration = this.generation
    setTimeout(() => {
      if (
        !this.isCurrentAttempt(reconnectGeneration) ||
        this.state !== 'disconnected'
      ) {
        return
      }
      void this.connect({ allowLaunch: false, userInitiated: false })
    }, this.closeReconnectDelayMs)
  }

  /**
   * Handle the server's `$/pair/revoked` notification. Clears credentials,
   * pauses the gate (so SW restart doesn't re-pair) and enters 'denied'.
   * Reuses enterDenied so the ws-close that Motrix sends ~50ms
   * later is a no-op (handleClose bails on 'denied').
   */
  private async handlePairRevoked(
    reason: string,
    scope: EndpointAttemptScope,
    generation: number,
    conn: MdxpConnection
  ): Promise<void> {
    if (!this.isCurrentConnection(generation, conn)) return
    log.info(`pairing revoked by Motrix (${reason})`)
    // Set lastErrorMessage BEFORE enterDenied — enterDenied calls
    // setState('denied') which synchronously fires stateListeners; any
    // listener that calls getLastError() during the 'denied' transition
    // must see the revoke reason, not the stale value from before.
    // (The catch path in connect() follows this same order.)
    this.lastErrorMessage = `Pairing revoked by Motrix: ${reason}`
    this.lastErrorReason = null
    this.lastErrorRetryAtMs = null
    this.notify({
      title: i18n.t('notify.pairRevokedTitle'),
      message: i18n.t('notify.pairRevokedBody'),
      severity: 'reminder',
      kind: 'pairing.revoked',
    })
    await this.enterDenied(
      {
        code: ErrorCodes.PairRevoked,
        message: `Pairing revoked by Motrix: ${reason}`,
      },
      scope,
      generation,
      conn
    )
  }

  /**
   * Explicit pair-denial errors (user clicked Deny, or a credential was
   * revoked) MUST NOT trigger automatic reconnect — otherwise the ext loops
   * the NM bootstrap which keeps re-focusing Motrix's window and piling up
   * stale pair toasts. Session abort/expiry is intentionally not terminal:
   * neither proves an operator refusal. Terminate only the explicit cases and
   * surface lastError so the popup can offer an explicit retry.
   */
  private shouldEnterDenied(e: unknown): boolean {
    const detail = e as { code?: number; pairErrorCode?: unknown } | undefined
    if (detail?.pairErrorCode === 'denied') return true
    const code = detail?.code
    return (
      code === ErrorCodes.PermissionDenied || code === ErrorCodes.PairRevoked
    )
  }

  private async enterDenied(
    e: unknown,
    sourceScope: EndpointAttemptScope | null,
    generation: number,
    conn?: MdxpConnection
  ): Promise<void> {
    if (!this.isCurrentAttempt(generation)) return
    if (conn !== undefined && this.currentConn !== conn) return

    // This terminal transition now owns the manager and invalidates the
    // initialize continuation / close callback belonging to its source
    // attempt before closing the transport.
    const deniedGeneration = ++this.generation
    const terminalScope =
      sourceScope === null
        ? null
        : this.bindAttemptScope(
            sourceScope,
            deniedGeneration,
            sourceScope.lease,
            this.endpointLifecycleService.bindBackendAttemptLease(
              sourceScope.lease,
              (attempt) => {
                this.ensureCurrentAttempt(deniedGeneration)
                const current = this.endpointIncarnationFromAttempt(attempt)
                if (!isSameEndpointIncarnation(current, sourceScope)) {
                  throw new StaleConnectionAttemptError()
                }
              }
            )
          )
    this.closePreAuthChannel()
    const code = (e as { code?: number } | undefined)?.code
    const revocationCleanup =
      code === ErrorCodes.PairRevoked
        ? Promise.resolve().then(async () => {
            await this.clearRevokedState(terminalScope)
            if (!this.isCurrentAttempt(deniedGeneration)) return
            if (terminalScope === null) return
            try {
              await this.runEndpointMutation(terminalScope, () =>
                terminalScope.gate.pauseDenied(
                  (e as Error).message ?? 'pair denied'
                )
              )
            } catch {
              // best-effort; the authoritative server-side revocation still
              // prevents reconnect if gate persistence is unavailable.
            }
          })
        : null
    // Publish the barrier before the synchronous state transition. A state
    // listener may immediately trigger a UI render; even an immediate retry
    // must observe and await the cleanup rather than race stale credentials.
    if (revocationCleanup !== null) {
      this.pendingRevocationCleanup = revocationCleanup
    }
    this.currentConn = null
    this.currentEndpointScope = null
    this.currentAuthenticatedInstanceId = null
    this.serverCapabilities = null
    this.initializeRequest = null
    this.capabilitiesRefreshFlight = null
    this.serverIdentity = null
    this.degraded = null
    this.taskEvents.clear()
    this.rpcRecovery.reset()
    this.setState('denied')
    try {
      this.client.close()
    } catch {
      // best-effort
    }
    if (this.currentMbp1Socket !== null) {
      try {
        this.currentMbp1Socket.close()
      } catch {
        // best-effort
      }
      this.currentMbp1Socket = null
    }

    if (revocationCleanup !== null) {
      try {
        await revocationCleanup
      } finally {
        if (this.pendingRevocationCleanup === revocationCleanup) {
          this.pendingRevocationCleanup = null
        }
      }
      return
    }
    if (!this.isCurrentAttempt(deniedGeneration)) return
    if (terminalScope === null) return
    // Persist the denial so the next SW restart does not auto-bootstrap.
    try {
      await this.runEndpointMutation(terminalScope, () =>
        terminalScope.gate.pauseDenied((e as Error).message ?? 'pair denied')
      )
    } catch {
      // best-effort; SW restart will revert to gate-open behaviour if
      // persistence fails — that's a graceful degradation.
    }
    if (!this.isCurrentAttempt(deniedGeneration)) return
  }

  /**
   * Authenticated revocation invalidates every credential for the current
   * local principal. Pins are cleared first through CredentialStore's
   * transaction callback; an individual pin failure is non-authoritative and
   * must never preserve a credential key.
   */
  private async clearRevokedState(
    scope: EndpointAttemptScope | null
  ): Promise<void> {
    if (scope === null) return
    try {
      const principal: Principal = {
        browser: requireProtocolBrowser(this.opts.clientInfo.browser),
        verifiedOrigin: computeVerifiedOrigin(),
        clientInstallationId: await getClientInstallationId(),
      }
      await scope.credentials.revokeAll(
        principal,
        scope.endpointConfig.mode === 'local'
          ? async (revokedIds) => {
              for (const credentialId of revokedIds) {
                try {
                  await this.pinStore.clear(credentialId)
                } catch {
                  // A local pin is a routing hint, not authority.
                }
              }
            }
          : undefined
      )
    } catch {
      // Best effort when extension storage is unavailable. The Motrix side
      // still revokes the authoritative credential.
    }
  }

  private isCurrentAttempt(generation: number): boolean {
    return this.generation === generation
  }

  private ensureCurrentAttempt(generation: number): void {
    if (!this.isCurrentAttempt(generation)) {
      throw new StaleConnectionAttemptError()
    }
  }

  private isCurrentConnection(
    generation: number,
    conn: MdxpConnection
  ): boolean {
    return this.isCurrentAttempt(generation) && this.currentConn === conn
  }

  private ensureCurrentConnection(
    generation: number,
    conn: MdxpConnection
  ): void {
    if (!this.isCurrentConnection(generation, conn)) {
      throw new StaleConnectionAttemptError()
    }
  }

  private assertBackendCompatibility(result: DiscoveryResult): void {
    switch (result.compatibility) {
      case 'compatible':
        return
      case undefined:
      case 'backendUpgradeRequired':
        throw new BackendCompatibilityError(
          'backendUpgradeRequired',
          'this Motrix backend does not advertise compatible MBP1/MDXP capabilities; update Motrix'
        )
      case 'extensionUpgradeRequired':
        throw new BackendCompatibilityError(
          result.compatibility,
          'this Motrix backend requires a newer extension protocol version'
        )
      case 'unsupportedRemote':
        throw new BackendCompatibilityError(
          result.compatibility,
          'this Motrix runtime does not support browser-extension pairing'
        )
    }
  }

  private captureCapabilities(caps: {
    ffmpegAvailable: boolean
    selectionKinds: string[]
    taskReveal?: boolean
    downloadDirectories?: boolean | undefined
  }): void {
    this.serverCapabilities = {
      ffmpegAvailable: caps.ffmpegAvailable,
      selectionKinds: [...caps.selectionKinds],
      // Optional on the 1.0 wire so an older backend remains compatible,
      // but absent must never accidentally enable a desktop-shell action.
      taskReveal: caps.taskReveal === true,
      downloadDirectories: caps.downloadDirectories === true,
    }
  }
}

/**
 * Classify a failed connect attempt into a log level so benign, expected
 * states don't masquerade as errors:
 *  - info : Motrix simply isn't running, or its native host isn't installed
 *           yet (the normal state on SW wake before the user opens Motrix).
 *  - warn : pairing not authorized, slow/aborted handshake — actionable but
 *           not a crash.
 *  - error: malformed protocol response or any unexpected fault — a real bug.
 */
export function classifyConnectError(e: unknown): {
  level: 'info' | 'warn' | 'error'
  reason: string
} {
  const mdxpCode = (e as { code?: number } | undefined)?.code
  if (
    mdxpCode === ErrorCodes.PairRevoked ||
    mdxpCode === ErrorCodes.PermissionDenied
  ) {
    return {
      level: 'warn',
      reason: 'pairing not authorized (denied or revoked)',
    }
  }
  if (e instanceof StoredPairingUnavailableError)
    return { level: 'warn', reason: e.message }
  if (e instanceof RecoveryExhaustedUnattendedError) {
    // Expected disposition, not a fault — every stored credential simply
    // failed during an attempt nobody asked for. See the class doc.
    return { level: 'info', reason: e.message }
  }
  if (e instanceof NativeBootstrapError) {
    // Firefox for Android deliberately omits Native Messaging. This is an
    // expected platform capability boundary; remote Server backends continue
    // to work and the UI guides the user to configure one.
    if (e.code === 'unsupported') {
      return { level: 'info', reason: e.message }
    }
    // NM host answered, but reports the desktop app is down — the single most
    // common state when the extension wakes and Motrix simply isn't open.
    if (e.code === 'host-error:motrix-not-running') {
      return { level: 'info', reason: 'Motrix is not running' }
    }
    // NM host missing/unregistered (Motrix not installed, or its NM manifest
    // hasn't been written yet) — expected before first setup.
    if (
      e.code === 'disconnect' &&
      /not found|no such|forbidden|not installed/i.test(e.message)
    ) {
      return { level: 'info', reason: 'Motrix native host not installed' }
    }
    // Slow handshake, or the host vanished mid-bootstrap — transient.
    if (e.code === 'timeout' || e.code === 'disconnect') {
      return { level: 'warn', reason: e.message }
    }
    // malformed response / unexpected host-error — a genuine protocol fault.
    return { level: 'error', reason: e.message }
  }
  return { level: 'error', reason: (e as Error)?.message ?? String(e) }
}
