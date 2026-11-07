import {
  refreshOperatorSession,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import { fnosFileAction, isFnos } from '@renderer/platform/fnos'
import { isSynology, synologyFileAction } from '@renderer/platform/nas'
import { ErrorCode } from '@shared/errors'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import { Commands } from '@shared/protocol/commands'
import {
  ProtocolEnvelopeError,
  parseProtocolEnvelope,
  TransportError,
} from '@shared/protocol/errors'
import type { EventChannel } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { openTaskFilePayloadSchema } from '@shared/schemas/open-task-file'
import {
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  fnosEventTicketSchema,
  isNasAuthMode,
} from '@shared/schemas/operator-auth'
import {
  WEB_EVENT_CONNECT_TIMEOUT_MS,
  WEB_EVENT_STALE_MS,
  type WebEventRenewal,
  webEventFrameSchema,
  webEventHeartbeatSchema,
  webEventRenewalSchema,
} from '@shared/schemas/web-event-stream'
import { webOriginHeaders } from '../web-base-url'
import type {
  AnyChannel,
  EventListener,
  Transport,
  TransportConnectionEvent,
  TransportConnectionListener,
  TransportConnectionState,
} from './types'

// `bridge:*` channels share one prefix for both commands and queries, so they
// cannot be distinguished by prefix alone. Resolve them by explicit membership.
const BRIDGE_COMMANDS = new Set<string>(Object.values(BridgeCommands))
const BRIDGE_QUERIES = new Set<string>(Object.values(BridgeQueries))

function rpcKindFor(channel: string): 'command' | 'query' {
  if (channel.startsWith('command:')) return 'command'
  if (channel.startsWith('query:')) return 'query'
  if (BRIDGE_COMMANDS.has(channel)) return 'command'
  if (BRIDGE_QUERIES.has(channel)) return 'query'
  return 'query'
}

export interface HttpWsOptions {
  fetch?: typeof fetch
  WebSocketCtor?: typeof WebSocket
  reconnectDelaysMs?: readonly number[]
}

const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000]

export class HttpWsTransport implements Transport {
  readonly platform = 'web' as const
  private readonly fetchFn: typeof fetch
  private readonly WSCtor: typeof WebSocket | undefined
  private readonly reconnectDelaysMs: readonly number[]
  private socket: WebSocket | null = null
  private readonly listeners = new Map<string, Set<EventListener>>()
  private readonly connectionListeners = new Set<TransportConnectionListener>()
  private connectionState: TransportConnectionState = 'disconnected'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private socketEpoch = 0
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null
  private lastMessageAt = 0
  private supportsHeartbeat = false
  private watchingForeground = false
  private fnosTicketRequest: AbortController | null = null

  private readonly onForeground = () => {
    if (document.visibilityState === 'hidden') return
    if (
      this.socket &&
      this.supportsHeartbeat &&
      Date.now() - this.lastMessageAt >= WEB_EVENT_STALE_MS
    ) {
      this.retireSocket(this.socket, this.socketEpoch)
    }
    if (!this.socket) {
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.ensureSocket()
    }
  }

  constructor(
    private readonly baseUrl: string,
    opts: HttpWsOptions = {}
  ) {
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis)
    this.WSCtor =
      opts.WebSocketCtor ??
      (typeof WebSocket !== 'undefined' ? WebSocket : undefined)
    useOperatorSession.subscribe((state, previous) => {
      if (state.state === 'locked') this.stopSocket()
      else if (
        state.state === 'authenticated' &&
        previous.state !== 'authenticated'
      )
        this.ensureSocket()
    })
    this.reconnectDelaysMs =
      opts.reconnectDelaysMs?.length === 0
        ? [0]
        : (opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)
  }

  async invoke(channel: AnyChannel, ...args: unknown[]): Promise<unknown> {
    const session = useOperatorSession.getState()
    if (session.state === 'locked' || session.state === 'logging-out')
      throw new Error('Operator session is locked')
    if (
      isSynology() &&
      session.status?.nasCapabilities?.fileActions &&
      (channel === Commands.OpenTaskFile || channel === Commands.RevealInFolder)
    ) {
      const { taskId } = openTaskFilePayloadSchema.parse(args[0])
      return synologyFileAction(
        taskId,
        channel === Commands.OpenTaskFile ? 'open' : 'reveal'
      )
    }
    if (
      isFnos() &&
      (channel === Commands.OpenTaskFile || channel === Commands.RevealInFolder)
    ) {
      const { taskId } = openTaskFilePayloadSchema.parse(args[0])
      return fnosFileAction(
        taskId,
        channel === Commands.OpenTaskFile ? 'open' : 'reveal'
      )
    }
    const kind = rpcKindFor(channel)
    const isInspectorActivity = channel === Queries.GetTaskInspectorActivity
    const res = await this.fetchFn(
      `${this.baseUrl}/rpc/${kind}/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(isNasAuthMode(session.status?.mode) ? webOriginHeaders() : {}),
        },
        // Send the operator session cookie (Spec 9). Same-origin is the fetch
        // default, but set it explicitly so the control-plane auth is obvious.
        credentials: 'same-origin',
        body: JSON.stringify({ args }),
        // Reads may retry; a stalled fetch must release its network resources.
        ...(kind === 'query' ? { signal: AbortSignal.timeout(15_000) } : {}),
      }
    )
    if (res.status === 401) void refreshOperatorSession(session.epoch)
    if (!res.ok) {
      if (isInspectorActivity) {
        throw new TransportError(
          ErrorCode.EngineProtocolError,
          'Request failed'
        )
      }
      const text = await res.text()
      throw new Error(`rpc failed ${res.status}: ${text}`)
    }
    let value: unknown
    try {
      value = await res.json()
    } catch (error) {
      if (isInspectorActivity) throw new ProtocolEnvelopeError()
      throw error
    }
    return isInspectorActivity ? parseProtocolEnvelope(value) : value
  }

  on(channel: EventChannel, cb: EventListener): void {
    const set = this.listeners.get(channel) ?? this.makeSet(channel)
    set.add(cb)
    this.ensureSocket()
  }

  off(channel: EventChannel, cb: EventListener): void {
    const set = this.listeners.get(channel)
    set?.delete(cb)
    if (set?.size === 0) this.listeners.delete(channel)
    if (!this.hasEventListeners()) this.stopSocket()
  }

  getConnectionState(): TransportConnectionState {
    return this.connectionState
  }

  onConnectionChange(cb: TransportConnectionListener): () => void {
    this.connectionListeners.add(cb)
    return () => {
      this.connectionListeners.delete(cb)
    }
  }

  private makeSet(channel: string): Set<EventListener> {
    const s = new Set<EventListener>()
    this.listeners.set(channel, s)
    return s
  }

  private ensureSocket(): void {
    if (
      useOperatorSession.getState().state === 'locked' ||
      useOperatorSession.getState().state === 'logging-out' ||
      this.socket ||
      this.fnosTicketRequest ||
      this.reconnectTimer !== null ||
      !this.WSCtor ||
      !this.hasEventListeners()
    ) {
      return
    }

    if (isNasAuthMode(useOperatorSession.getState().status?.mode)) {
      const pending = new AbortController()
      this.fnosTicketRequest = pending
      const sessionEpoch = useOperatorSession.getState().epoch
      const epoch = ++this.socketEpoch
      this.publishConnectionState('connecting')
      void this.fetchFn(`${this.baseUrl}/rpc/auth/event-ticket`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: webOriginHeaders(),
        signal: AbortSignal.any([pending.signal, AbortSignal.timeout(15_000)]),
      })
        .then(async (response) => {
          if (response.status === 401 || response.status === 403)
            void refreshOperatorSession(sessionEpoch)
          if (!response.ok) throw new Error('fnOS event authorization failed')
          const { ticket } = fnosEventTicketSchema.parse(await response.json())
          if (this.fnosTicketRequest !== pending || this.socketEpoch !== epoch)
            return
          this.fnosTicketRequest = null
          if (
            !this.hasEventListeners() ||
            useOperatorSession.getState().epoch !== sessionEpoch ||
            useOperatorSession.getState().state !== 'authenticated'
          )
            return
          this.connectSocket([
            FNOS_EVENT_PROTOCOL,
            `${FNOS_EVENT_TICKET_PREFIX}${ticket}`,
          ])
        })
        .catch(() => {
          if (this.fnosTicketRequest !== pending) return
          this.fnosTicketRequest = null
          this.publishConnectionState('disconnected')
          this.scheduleReconnect()
        })
      return
    }
    this.connectSocket()
  }

  private connectSocket(protocols?: string[]): void {
    if (!this.WSCtor) return
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/rpc/events`
    let socket: WebSocket
    try {
      socket = protocols
        ? new this.WSCtor(wsUrl, protocols)
        : new this.WSCtor(wsUrl)
    } catch {
      this.publishConnectionState('disconnected')
      this.scheduleReconnect()
      return
    }
    const epoch = ++this.socketEpoch
    this.socket = socket
    this.supportsHeartbeat = false
    this.lastMessageAt = Date.now()
    if (!this.watchingForeground) {
      this.watchingForeground = true
      window.addEventListener('online', this.onForeground)
      window.addEventListener('focus', this.onForeground)
      document.addEventListener('visibilitychange', this.onForeground)
    }
    this.setDeadline(
      () => this.retireSocket(socket, epoch),
      WEB_EVENT_CONNECT_TIMEOUT_MS
    )
    this.publishConnectionState('connecting')

    const lifetime = new AbortController()
    let renewing = false
    const renew = async (frame: WebEventRenewal) => {
      if (renewing) return
      renewing = true
      const session = useOperatorSession.getState()
      try {
        const res = await this.fetchFn(`${this.baseUrl}/rpc/auth/event-renew`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            ...webOriginHeaders(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(frame),
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(12_000),
          ]),
        })
        if (!this.isCurrentSocket(socket, epoch)) return
        if (res.status === 401 || res.status === 403)
          void refreshOperatorSession(session.epoch)
        if (!res.ok) this.retireSocket(socket, epoch)
      } catch {
        this.retireSocket(socket, epoch)
      } finally {
        renewing = false
      }
    }

    socket.addEventListener('open', () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.clearDeadline()
      this.reconnectAttempt = 0
      this.publishConnectionState('connected')
    })
    socket.addEventListener('message', (ev) => {
      if (!this.isCurrentSocket(socket, epoch)) return
      try {
        const data: unknown = JSON.parse(String(ev.data))
        if (webEventHeartbeatSchema.safeParse(data).success) {
          this.supportsHeartbeat = true
          this.receivedMessage(socket, epoch)
          return
        }
        if (useOperatorSession.getState().status?.mode === 'synologyDsm') {
          const renewal = webEventRenewalSchema.safeParse(data)
          if (renewal.success) {
            this.receivedMessage(socket, epoch)
            void renew(renewal.data)
            return
          }
        }
        const parsed = webEventFrameSchema.safeParse(data)
        if (!parsed.success) return
        this.receivedMessage(socket, epoch)
        const frame = parsed.data
        const set = this.listeners.get(frame.channel)
        if (!set) return
        for (const cb of set) {
          try {
            cb(...frame.args)
          } catch {
            /* One consumer must not suppress the others. */
          }
        }
      } catch {
        // ignore malformed frames
      }
    })
    socket.addEventListener('close', () => {
      lifetime.abort()
      if (!this.isCurrentSocket(socket, epoch)) return
      this.clearDeadline()
      this.socket = null
      this.publishConnectionState('disconnected')
      void refreshOperatorSession()
      this.scheduleReconnect()
    })
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
  }

  private setDeadline(callback: () => void, delay: number): void {
    this.clearDeadline()
    this.deadlineTimer = setTimeout(callback, delay)
  }

  private receivedMessage(socket: WebSocket, epoch: number): void {
    this.lastMessageAt = Date.now()
    if (!this.supportsHeartbeat) return
    const check = () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      if (document.visibilityState === 'hidden') {
        this.setDeadline(check, WEB_EVENT_STALE_MS)
        return
      }
      this.retireSocket(socket, epoch)
    }
    this.setDeadline(check, WEB_EVENT_STALE_MS)
  }

  private retireSocket(socket: WebSocket, epoch: number): void {
    if (!this.isCurrentSocket(socket, epoch)) return
    this.clearDeadline()
    this.socket = null
    this.socketEpoch++
    try {
      socket.close()
    } catch {
      /* The connection may still be opening. */
    }
    this.publishConnectionState('disconnected')
    this.scheduleReconnect()
  }

  private hasEventListeners(): boolean {
    for (const set of this.listeners.values()) {
      if (set.size > 0) return true
    }
    return false
  }

  private isCurrentSocket(socket: WebSocket, epoch: number): boolean {
    return this.socket === socket && this.socketEpoch === epoch
  }

  private scheduleReconnect(): void {
    if (
      this.reconnectTimer !== null ||
      !this.WSCtor ||
      !this.hasEventListeners()
    ) {
      return
    }
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1
    )
    const delay = this.reconnectDelaysMs[delayIndex] ?? 0
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ensureSocket()
    }, delay)
  }

  private stopSocket(): void {
    const ticketRequest = this.fnosTicketRequest
    this.fnosTicketRequest = null
    ticketRequest?.abort()
    this.clearDeadline()
    this.watchingForeground = false
    window.removeEventListener('online', this.onForeground)
    window.removeEventListener('focus', this.onForeground)
    document.removeEventListener('visibilitychange', this.onForeground)
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    const socket = this.socket
    this.socket = null
    this.socketEpoch += 1
    if (socket) socket.close()
    this.publishConnectionState('disconnected')
  }

  // A 'connecting' publish always sits between two 'connected' states, so
  // deduplicating on state alone never swallows a reconnect notification.
  private publishConnectionState(state: TransportConnectionState): void {
    if (this.connectionState === state) return
    this.connectionState = state
    const event: TransportConnectionEvent = { state }
    for (const listener of this.connectionListeners) {
      try {
        listener(event)
      } catch {
        // A renderer listener must not break transport recovery.
      }
    }
  }
}
