import { createMdxpConnection, type MdxpConnection } from '@motrix/mdxp'
import {
  BrowserWebSocketMessageReader,
  BrowserWebSocketMessageWriter,
} from '@/background/BrowserWebSocketStream'

export interface WebSocketClientOptions {
  /** Inject a WebSocket constructor for testing. Defaults to globalThis.WebSocket. */
  WebSocketCtor?: typeof WebSocket
  /** Max time to wait for the browser to emit `open`. */
  openTimeoutMs?: number
}

type CloseCallback = () => void
const WS_CLOSED = 3
const DEFAULT_OPEN_TIMEOUT_MS = 8_000

interface SocketSession {
  ws: WebSocket
  conn: MdxpConnection | null
  closeCallbacks: CloseCallback[]
  closeHandled: boolean
}

/**
 * Owns one WebSocket lifecycle. connect() opens the socket and wraps it
 * in an MdxpConnection (handlers must be attached + listen() called by
 * the caller — we hand off the unlistened connection so ConnectionManager
 * can install onRequest/onNotification before incoming traffic flows).
 */
export class WebSocketClient {
  /** The sole live/pending socket. Callback ownership lives on the session,
   *  never on the client, so a late close from an older socket cannot observe
   *  callbacks registered for its replacement. */
  private session: SocketSession | null = null
  private readonly Ctor: typeof WebSocket
  private readonly openTimeoutMs: number

  constructor(opts: WebSocketClientOptions = {}) {
    this.Ctor = opts.WebSocketCtor ?? globalThis.WebSocket
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  }

  async connect(url: string, subprotocol: string): Promise<MdxpConnection> {
    if (this.session) throw new Error('WebSocketClient already connected')
    const ws = new this.Ctor(url, subprotocol)
    const session: SocketSession = {
      ws,
      conn: null,
      closeCallbacks: [],
      closeHandled: false,
    }
    this.session = session

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onCloseBeforeOpen)
      }
      const onOpen = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        // A connect that never opened must not poison the client: drop the
        // socket reference so a later connect() is not rejected by the
        // "already connected" guard above. Without this, a failed open left
        // the session occupied and only a service-worker teardown (browser
        // restart) could recover.
        if (this.session === session) this.session = null
        if (ws.readyState !== WS_CLOSED) ws.close()
        reject(new Error('WebSocket failed to open'))
      }
      const onCloseBeforeOpen = (): void => {
        cleanup()
        if (this.session === session) this.session = null
        reject(new Error('WebSocket closed before opening'))
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onCloseBeforeOpen)
      timer = setTimeout(() => {
        cleanup()
        if (this.session === session) this.session = null
        if (ws.readyState !== WS_CLOSED) ws.close()
        reject(
          new Error(`WebSocket open timed out after ${this.openTimeoutMs}ms`)
        )
      }, this.openTimeoutMs)
    })

    // stop()/a newer connect may have superseded this socket while its open
    // event was queued. Never let a late A open overwrite B's connection.
    if (this.session !== session) {
      if (ws.readyState !== WS_CLOSED) ws.close()
      throw new Error('WebSocket connection superseded')
    }

    ws.addEventListener('close', () => this.handleSocketClose(session))

    const reader = new BrowserWebSocketMessageReader(ws)
    const writer = new BrowserWebSocketMessageWriter(ws)
    const conn = createMdxpConnection(reader, writer)
    session.conn = conn
    return conn
  }

  onClose(cb: CloseCallback): void {
    this.session?.closeCallbacks.push(cb)
  }

  close(): void {
    const session = this.session
    if (session === null) return

    // Release the client slot before requesting close. A synchronous close
    // event still sees this session's callbacks; a delayed one sees the same
    // (now-drained) session array, never a future socket's callbacks.
    this.session = null
    if (session.ws.readyState !== WS_CLOSED) session.ws.close()
    session.conn?.dispose()
    session.conn = null
    session.closeCallbacks.length = 0
  }

  getConnection(): MdxpConnection | null {
    return this.session?.conn ?? null
  }

  private handleSocketClose(session: SocketSession): void {
    if (session.closeHandled) return
    session.closeHandled = true

    const callbacks = session.closeCallbacks.splice(0)
    if (this.session === session) this.session = null
    session.conn?.dispose()
    session.conn = null

    for (const cb of callbacks) cb()
  }
}
