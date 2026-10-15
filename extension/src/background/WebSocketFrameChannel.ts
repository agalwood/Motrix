/**
 * Real `FrameChannel` (bridge-pairing-protocol.md §6.1) over a browser
 * `WebSocket`, driving `PairingFlow`/`ReconnectFlow` on `/pair` and `/v1`.
 *
 * `PairingFlow`/`ReconnectFlow`'s own tests drive a scripted in-memory peer
 * against the `FrameChannel` interface instead of a socket; this is the
 * adapter that makes the interface real for `ConnectionManager`.
 *
 * ## The contract this must honour (see `frames.ts`'s `FrameChannel` doc)
 *
 * - `open` requests the `motrix-bridge.v1` subprotocol; the server 401s the
 *   upgrade without it.
 * - `receiveText`/`receiveBinary` reject — never hang, never resolve — on a
 *   timeout or a socket close with nothing pending. A flow that cannot tell
 *   "closed" from "still waiting" cannot honour its own deadlines.
 * - Exactly one receive is outstanding at a time; the flows never issue a
 *   second one before the first settles. Arriving frames are queued FIFO so a
 *   frame that shows up before it is asked for is not lost.
 * - A frame of the wrong kind for what was asked (text vs binary) is a §6.1
 *   violation, surfaced as a rejection rather than silently coerced.
 * - `close` is idempotent and safe on an already-closed or never-opened
 *   socket.
 *
 * ## What happens after a flow succeeds
 *
 * Neither flow calls `close()` on success — the caller owns the socket from
 * there on, since MDXP `motrix/initialize` runs inside the envelope the flow
 * just derived. `release()` (not part of `FrameChannel`, so callers must hold
 * the concrete class to reach it) detaches this channel's own listeners and
 * hands back the live `WebSocket` **and** any frames still sitting in
 * `this.queue` — every frame that arrived after the flow's last `receive*()`
 * call but before `release()` ran. There is a real window for that: the
 * caller does several `storage.local` writes (credential commit, pin
 * commit, prune) between a flow returning and `release()` actually being
 * called. Dropping a queued frame here would silently desynchronize the
 * envelope's strict per-direction sequence counter the moment the caller
 * starts reading with the fresh transport layer — the next inbound frame
 * would fail `sequenceMismatch` and look like tampering, for a frame the
 * peer sent perfectly correctly. The fresh transport layer (the AEAD
 * envelope's `MessageReader`) is the one that must process any handed-over
 * frames, in order, before it starts listening for new ones.
 */
import { type FrameChannel, MBP1_SUBPROTOCOL } from '@/background/mbp1/frames'

export interface WebSocketFrameChannelOptions {
  /** Inject a WebSocket constructor for testing. Defaults to globalThis.WebSocket. */
  WebSocketCtor?: typeof WebSocket
  /** Max time to wait for the browser to emit `open`. */
  openTimeoutMs?: number
}

const WS_OPEN = 1
const WS_CLOSED = 3
const DEFAULT_OPEN_TIMEOUT_MS = 8_000

type QueuedFrame =
  | { kind: 'text'; data: string }
  | { kind: 'binary'; data: Uint8Array }

interface PendingReceive {
  resolve: (frame: QueuedFrame) => void
  reject: (error: Error) => void
}

export class WebSocketFrameChannel implements FrameChannel {
  private readonly Ctor: typeof WebSocket
  private readonly openTimeoutMs: number
  private ws: WebSocket | null = null
  private released = false
  private closed = false
  private closeError: Error | null = null
  private abortOpening: ((error: Error) => void) | null = null
  private readonly queue: QueuedFrame[] = []
  private pending: PendingReceive | null = null
  /** Last URL passed to `open()` — exposed for callers to record (e.g.
   *  `ConnectionManager.lastConnectUrl`), mirroring `ScriptedChannel.openedUrls`
   *  in the flow test suites. */
  openedUrl: string | null = null

  private readonly onMessage = (ev: MessageEvent): void => {
    const data = ev.data
    if (typeof data === 'string') {
      this.enqueue({ kind: 'text', data })
      return
    }
    if (data instanceof ArrayBuffer) {
      this.enqueue({ kind: 'binary', data: new Uint8Array(data) })
      return
    }
    // `binaryType` is forced to 'arraybuffer' in `open()`, so this should be
    // unreachable in practice; treated as a fatal close rather than silently
    // dropped, since a receive left permanently pending is worse than a
    // diagnosable failure.
    this.forceClose(new Error('unsupported WebSocket frame type'))
  }

  private readonly onSocketClose = (): void => {
    this.forceClose(new Error('WebSocket closed'))
  }

  constructor(options: WebSocketFrameChannelOptions = {}) {
    this.Ctor = options.WebSocketCtor ?? globalThis.WebSocket
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  }

  async open(url: string): Promise<void> {
    if (this.ws !== null) {
      throw new Error('WebSocketFrameChannel already opened')
    }
    this.openedUrl = url
    const ws = new this.Ctor(url, MBP1_SUBPROTOCOL)
    // Own the physical socket before awaiting `open`. ConnectionManager may
    // stop this channel while the browser is still connecting; keeping the
    // socket only in this call frame would make close() unable to reach it.
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onCloseBeforeOpen)
        if (this.abortOpening === fail) this.abortOpening = null
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        this.forceClose(error)
        if (ws.readyState !== WS_CLOSED) ws.close()
        reject(error)
      }
      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onError = (): void => {
        fail(new Error('WebSocket failed to open'))
      }
      const onCloseBeforeOpen = (): void => {
        fail(new Error('WebSocket closed before opening'))
      }
      this.abortOpening = fail
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onCloseBeforeOpen)
      timer = setTimeout(() => {
        fail(
          new Error(`WebSocket open timed out after ${this.openTimeoutMs}ms`)
        )
      }, this.openTimeoutMs)
    })

    // `open` and an owner-driven close can cross in the microtask between
    // the event and this continuation. Never attach steady-state listeners
    // or report success after ownership was cancelled.
    if (this.closed) {
      throw this.closeError ?? new Error('WebSocketFrameChannel closed')
    }
    ws.addEventListener('message', this.onMessage)
    ws.addEventListener('close', this.onSocketClose)
  }

  async sendText(frame: object): Promise<void> {
    this.send(JSON.stringify(frame))
  }

  async sendBinary(frame: Uint8Array): Promise<void> {
    this.send(frame)
  }

  async receiveText(timeoutMs: number): Promise<string> {
    const frame = await this.receiveFrame(timeoutMs)
    if (frame.kind !== 'text') {
      throw new Error(
        '§6.1 violation: expected a text frame, received a binary one'
      )
    }
    return frame.data
  }

  async receiveBinary(timeoutMs: number): Promise<Uint8Array> {
    const frame = await this.receiveFrame(timeoutMs)
    if (frame.kind !== 'binary') {
      throw new Error(
        '§6.1 violation: expected a binary frame, received a text one'
      )
    }
    return frame.data
  }

  close(): void {
    if (this.released) return
    if (this.ws === null) return
    const error = new Error('WebSocketFrameChannel closed')
    this.forceClose(error)
    this.abortOpening?.(error)
    if (this.ws !== null) {
      this.ws.removeEventListener('message', this.onMessage)
      this.ws.removeEventListener('close', this.onSocketClose)
      if (this.ws.readyState !== WS_CLOSED) this.ws.close()
    }
  }

  /**
   * Detaches this channel's own listeners and hands back the live socket —
   * plus any frames still queued from before `release()` ran, see the
   * module doc — for a fresh transport layer (the envelope reader/writer)
   * to attach its own listeners and drain in order. Never called by
   * `PairingFlow`/`ReconnectFlow` themselves — they only call `close()`, and
   * only on failure — so this is the caller's own seam for the success
   * path. Idempotent-unsafe by design: calling it twice, or calling it on a
   * channel that never opened, is a caller bug, not a recoverable state, so
   * it throws rather than silently returning a stale reference.
   *
   * A queued **text** frame is a §6.1 violation in its own right at this
   * point — every frame after the channel activates must be binary — so
   * this throws rather than silently discarding it or handing it to a
   * binary-only consumer.
   */
  release(): { socket: WebSocket; queuedFrames: Uint8Array[] } {
    if (this.ws === null) {
      throw new Error('WebSocketFrameChannel: release() before open()')
    }
    if (this.released) {
      throw new Error('WebSocketFrameChannel: already released')
    }
    if (this.closed || this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocketFrameChannel: socket is not open')
    }
    const queuedFrames: Uint8Array[] = []
    for (const frame of this.queue) {
      if (frame.kind === 'text') {
        throw new Error(
          '§6.1 violation: a text frame is still queued at release() — every frame past channel activation must be binary'
        )
      }
      queuedFrames.push(frame.data)
    }
    this.released = true
    this.queue.length = 0
    this.ws.removeEventListener('message', this.onMessage)
    this.ws.removeEventListener('close', this.onSocketClose)
    return { socket: this.ws, queuedFrames }
  }

  private send(data: string | Uint8Array): void {
    if (this.ws === null || this.ws.readyState !== WS_OPEN) {
      throw new Error('WebSocketFrameChannel: not open')
    }
    // `Uint8Array<ArrayBufferLike>` (this package's default) isn't
    // assignable to `WebSocket.send`'s `BufferSource` without narrowing to a
    // concrete `ArrayBuffer` backing store; every byte value in this module
    // is a plain heap-allocated `Uint8Array`, never a `SharedArrayBuffer`
    // view, so this narrows the type without copying or changing behavior —
    // same rationale as `envelope.ts`'s `asBufferSource`.
    this.ws.send(
      typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)
    )
  }

  private enqueue(frame: QueuedFrame): void {
    if (this.pending !== null) {
      const { resolve } = this.pending
      this.pending = null
      resolve(frame)
      return
    }
    this.queue.push(frame)
  }

  private forceClose(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    if (this.pending !== null) {
      const { reject } = this.pending
      this.pending = null
      reject(error)
    }
  }

  private receiveFrame(timeoutMs: number): Promise<QueuedFrame> {
    if (this.pending !== null) {
      return Promise.reject(
        new Error('WebSocketFrameChannel: a receive is already pending')
      )
    }
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) {
      return Promise.reject(
        this.closeError ??
          new Error('WebSocketFrameChannel: closed with no frame pending')
      )
    }
    return new Promise<QueuedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`receive timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending = {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }
}
