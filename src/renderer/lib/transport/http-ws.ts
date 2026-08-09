import { ErrorCode } from '@shared/errors'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import {
  ProtocolEnvelopeError,
  parseProtocolEnvelope,
  TransportError,
} from '@shared/protocol/errors'
import type { EventChannel } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
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

  constructor(
    private readonly baseUrl: string,
    opts: HttpWsOptions = {}
  ) {
    this.fetchFn = opts.fetch ?? fetch.bind(globalThis)
    this.WSCtor =
      opts.WebSocketCtor ??
      (typeof WebSocket !== 'undefined' ? WebSocket : undefined)
    this.reconnectDelaysMs =
      opts.reconnectDelaysMs?.length === 0
        ? [0]
        : (opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)
  }

  async invoke(channel: AnyChannel, ...args: unknown[]): Promise<unknown> {
    const kind = rpcKindFor(channel)
    const isInspectorActivity = channel === Queries.GetTaskInspectorActivity
    const res = await this.fetchFn(
      `${this.baseUrl}/rpc/${kind}/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Send the operator session cookie (Spec 9). Same-origin is the fetch
        // default, but set it explicitly so the control-plane auth is obvious.
        credentials: 'same-origin',
        body: JSON.stringify({ args }),
      }
    )
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
      this.socket ||
      this.reconnectTimer !== null ||
      !this.WSCtor ||
      !this.hasEventListeners()
    ) {
      return
    }

    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/rpc/events`
    const socket = new this.WSCtor(wsUrl)
    const epoch = ++this.socketEpoch
    this.socket = socket
    this.publishConnectionState('connecting')

    socket.addEventListener('open', () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.reconnectAttempt = 0
      this.publishConnectionState('connected')
    })
    socket.addEventListener('message', (ev) => {
      if (!this.isCurrentSocket(socket, epoch)) return
      try {
        const frame = JSON.parse(String(ev.data)) as {
          channel: string
          args: unknown[]
        }
        const set = this.listeners.get(frame.channel)
        if (!set) return
        for (const cb of set) cb(...frame.args)
      } catch {
        // ignore malformed frames
      }
    })
    socket.addEventListener('close', () => {
      if (!this.isCurrentSocket(socket, epoch)) return
      this.socket = null
      this.publishConnectionState('disconnected')
      this.scheduleReconnect()
    })
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
