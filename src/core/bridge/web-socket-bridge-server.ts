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
import { type WebSocket, WebSocketServer } from 'ws'
import { BridgeConnection } from './bridge-connection'
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
import { MdxpDispatcher } from './mdxp-dispatcher'
import {
  contextFromConnection,
  type MdxpSessionContext,
} from './mdxp-session-context'
import type { PairingService } from './pairing-service'
import type { TrustedExtensionRegistry } from './trusted-extension-registry'

export interface PairDecision {
  decision: 'allow' | 'deny'
  /** Whether the user chose to remember this extension. Owned by dialog
   * controller — controller calls `registry.add(...)` before resolving. */
  addToRegistry: boolean
}

export interface PairRequestArgs {
  extensionId: string
  browser: Browser
  extensionName: string
  extensionVersion: string
}

export interface BridgeServerOptions {
  pairing: PairingService
  registry: TrustedExtensionRegistry
  onPairRequest: (args: PairRequestArgs) => Promise<PairDecision>
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
   * server itself stays bus-agnostic, mirroring the `onPairRequest` pattern.
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
}

export interface BridgeSession {
  conn: BridgeConnection
  extensionId: string
  browser: Browser
  startedAt: number
}

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
  Methods.StatsGet,
  Methods.EngineStatus,
] as const

const PAIR_NONCE_TTL_MS = 60_000
const SSE_HEARTBEAT_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export class WebSocketBridgeServer {
  private http: HttpServer
  private wss: WebSocketServer
  private pairNonces = new Map<string, number>()
  private sessions = new Map<string, BridgeSession>()
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
    // `motrix/initialize` is always available; the shell registers domain
    // methods (download/*) later via setHandlers().
    this.dispatcher.register(
      'motrix/initialize',
      InitializeParamsSchema,
      createInitializeHandler({
        motrixVersion: opts.motrixVersion,
        runtime: opts.runtime,
        ffmpegAvailable: opts.ffmpegAvailable,
        pairing: opts.pairing,
        registry: opts.registry,
        onPairRequest: opts.onPairRequest,
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
    this.wss = new WebSocketServer({ noServer: true })

    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const origin = req.headers.origin ?? ''
      const protoHeader = req.headers['sec-websocket-protocol'] ?? ''
      // DEBUG(connect-storm): every WS upgrade attempt Motrix sees.
      // TODO(remove-after-rootcause).
      console.log(
        `[bridge-debug] upgrade path=${url.pathname} origin=${origin || 'none'}`
      )

      if (!/^chrome-extension:\/\/|^moz-extension:\/\//.test(origin)) {
        console.log('[bridge-debug] reject 401: bad origin')
        return this.reject(socket, 401)
      }
      if (
        !String(protoHeader)
          .split(',')
          .map((s) => s.trim())
          .includes('motrix-bridge.v1')
      ) {
        console.log('[bridge-debug] reject 401: missing subprotocol')
        return this.reject(socket, 401)
      }

      if (url.pathname === '/pair') {
        return this.handlePairUpgrade(req, socket, head, url)
      }
      if (url.pathname === '/v1') {
        return this.handleV1Upgrade(req, socket, head, url)
      }
      console.log('[bridge-debug] reject 404: unknown path')
      this.reject(socket, 404)
    })

    this.http.on('request', (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      // GET /nonce — one-shot pairing nonce for the native-messaging host.
      if (req.method === 'GET' && pathname === '/nonce') {
        const nonce = this.issuePairNonce()
        // DEBUG(connect-storm). TODO(remove-after-rootcause).
        console.log('[bridge-debug] GET /nonce → issued')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ nonce }))
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
    if (!isLoopbackHost(host) && !this.opts.localToken) {
      throw new Error(
        `refusing to bind the MDXP bridge to non-loopback host "${host}" without a token`
      )
    }
    return new Promise((resolve, reject) => {
      this.http.listen(port, host, () => {
        const addr = this.http.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('failed to bind'))
      })
      this.http.once('error', reject)
    })
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

  issuePairNonce(): string {
    // Sweep expired nonces before inserting. Denied/abandoned/retried pair
    // attempts issue nonces that are never consumed by /pair, so without this
    // the Map grows unbounded over the lifetime of the desktop process.
    const now = Date.now()
    for (const [key, expires] of this.pairNonces) {
      if (expires <= now) this.pairNonces.delete(key)
    }
    const nonce = randomBytes(16).toString('base64url')
    this.pairNonces.set(nonce, now + PAIR_NONCE_TTL_MS)
    return nonce
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
   * `download/add`) on the dispatcher. Call BEFORE start(). The write methods
   * in `EXTENSION_WS_CONTROL_PLANE` (`task/pause`, `task/resume`,
   * `task/remove`) are reachable both via the unary `POST /mdxp` transport and
   * over the extension WebSocket for a paired session. `download/add` is
   * excluded from the WebSocket surface — extensions add via `download/submit`.
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

  private reject(socket: Duplex, code: 401 | 404): void {
    const reason = code === 401 ? 'Unauthorized' : 'Not Found'
    socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`)
    socket.destroy()
  }

  private consumeNonce(nonce: string): boolean {
    const expires = this.pairNonces.get(nonce)
    if (!expires) return false
    this.pairNonces.delete(nonce)
    return expires > Date.now()
  }

  private handlePairUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL
  ): void {
    const nonce = url.searchParams.get('nonce') ?? ''
    const extensionId = url.searchParams.get('extensionId') ?? ''
    const browser = (url.searchParams.get('browser') ?? '') as Browser
    const extensionName = url.searchParams.get('extensionName') ?? ''
    const extensionVersion = url.searchParams.get('extensionVersion') ?? ''

    if (
      !this.consumeNonce(nonce) ||
      !extensionId ||
      (browser !== 'chromium' && browser !== 'firefox')
    ) {
      // DEBUG(connect-storm): nonce already consumed above, so we log
      // raw inputs rather than re-validating. TODO(remove-after-rootcause).
      console.log(
        `[bridge-debug] /pair reject 401: noncePresent=${nonce !== ''} ` +
          `extId=${extensionId || 'none'} browser=${browser || 'none'}`
      )
      this.reject(socket, 401)
      return
    }
    console.log(`[bridge-debug] /pair accepted extId=${extensionId}`)
    // For first-time pair: registry check is deferred to the
    // initialize handler (which may call onPairRequest dialog).

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const pairArgs: PairRequestArgs = {
        extensionId,
        browser,
        extensionName,
        extensionVersion,
      }
      this.attachConnection(ws, extensionId, browser, pairArgs, false)
    })
  }

  private handleV1Upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL
  ): void {
    const token = url.searchParams.get('token') ?? ''
    const paired = this.opts.pairing.findByToken(token)
    // /v1 is the EXTENSION WebSocket reconnect path; a cli/agent uses the
    // unary HTTP transport, never this socket. Admit only extension identities.
    if (paired?.identity.kind !== 'extension') {
      // DEBUG(connect-storm): stale/invalid token → 401. The browser WS
      // API only surfaces this as a generic close 1006 to the ext.
      // TODO(remove-after-rootcause).
      console.log(
        `[bridge-debug] /v1 reject 401: token ${token ? 'present-but-unknown' : 'missing'}`
      )
      this.reject(socket, 401)
      return
    }
    const { browser, extensionId } = paired.identity
    console.log(
      `[bridge-debug] /v1 accepted extId=${extensionId} browser=${browser}`
    )
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attachConnection(ws, extensionId, browser, null, true)
      this.opts.pairing.markActive(paired.identity)
    })
  }

  private attachConnection(
    ws: WebSocket,
    extensionId: string,
    browser: Browser,
    pairArgs: PairRequestArgs | null,
    authorized: boolean
  ): void {
    const sessionKey = makeSessionKey(browser, extensionId)
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      existing.conn.dispose()
    }
    const startedAt = Date.now()
    const conn = new BridgeConnection(ws, {
      sessionKey,
      extensionId,
      browser,
      startedAt,
    })
    // `/v1` reconnects arrive with a pair token already verified at upgrade,
    // so they are authorized immediately. `/pair` first-connects are NOT:
    // control-plane / download methods stay closed until the initialize
    // handler records a pairing approval.
    if (authorized) conn.markAuthorized()

    this.applyHandlers(conn, pairArgs)

    const session: BridgeSession = { conn, extensionId, browser, startedAt }
    this.sessions.set(sessionKey, session)
    ws.on('close', () => {
      if (this.sessions.get(sessionKey) === session) {
        this.sessions.delete(sessionKey)
      }
      conn.dispose()
    })

    conn.listen()
  }

  private applyHandlers(
    conn: BridgeConnection,
    pairArgs: PairRequestArgs | null
  ): void {
    const ctx = contextFromConnection(conn, pairArgs)
    // Every method EXCEPT the handshake pair (motrix/initialize, system/ping)
    // requires an authorized session. A `/pair` first-connect is unauthorized
    // until its initialize handler records a pairing approval, so without this
    // a caller that merely consumed a one-shot nonce could drive download +
    // control-plane methods before (or entirely without) user approval. The
    // dispatcher itself has no authz notion, so the gate lives at the wiring.
    const authorizedDispatch = (
      method: string,
      params: unknown
    ): Promise<unknown> => {
      if (!ctx.isAuthorized()) {
        // Reject (not sync-throw) so the MdxpError travels the same path as a
        // dispatcher rejection and keeps its code on the wire.
        return Promise.reject(
          makeMdxpError(
            ErrorCodes.PermissionDenied,
            'session is not authorized; complete pairing first',
            { appCode: 'pair.required' }
          )
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
