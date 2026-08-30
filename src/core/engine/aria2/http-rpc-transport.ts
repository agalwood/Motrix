import net from 'node:net'
import { Agent, request } from 'undici'
import type {
  RpcCloseHandler,
  RpcErrorHandler,
  RpcMessageHandler,
  RpcTransport,
} from './rpc-transport'

const CONNECT_TIMEOUT_MS = 800

/**
 * JSON-RPC over HTTP POST.
 *
 * Some bundled aria2 Windows builds accept a WebSocket upgrade and execute
 * the RPC method, but never write a response frame. HTTP on the same process
 * answers immediately. Persistent keep-alive sockets against those builds
 * also stall, so each call uses `Connection: close`.
 */
export class HttpRpcTransport implements RpcTransport {
  private connected = false
  private url: string | null = null
  private dispatcher: Agent | null = null

  private messageHandler: RpcMessageHandler | null = null
  private errorHandler: RpcErrorHandler | null = null

  connect(url: string): Promise<void> {
    if (this.connected) {
      return Promise.reject(new Error('HTTP RPC is already connected'))
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Promise.reject(
        new Error('HttpRpcTransport requires an http(s) JSON-RPC URL')
      )
    }

    const port =
      Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    const hostname = parsed.hostname

    return new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, hostname, () => {
        socket.setTimeout(0)
        socket.end()
        this.url = url
        this.dispatcher = new Agent({
          keepAliveTimeout: 1,
          keepAliveMaxTimeout: 1,
          pipelining: 0,
        })
        this.connected = true
        resolve()
      })

      socket.on('error', (err: Error) => {
        if (!this.connected) {
          reject(err)
        }
      })

      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (!this.connected) {
          socket.destroy()
          reject(new Error('connect timeout'))
        }
      })
    })
  }

  disconnect(): void {
    this.connected = false
    this.url = null
    const dispatcher = this.dispatcher
    this.dispatcher = null
    if (dispatcher) {
      void dispatcher.close()
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  send(data: string): void {
    if (!this.connected || !this.url) {
      throw new Error('HTTP RPC is not connected')
    }
    const url = this.url
    const dispatcher = this.dispatcher
    void this.post(url, data, dispatcher)
  }

  onMessage(handler: RpcMessageHandler): void {
    this.messageHandler = handler
  }

  onClose(_handler: RpcCloseHandler): void {
    // HTTP RPC has no persistent socket whose peer-close we can observe.
  }

  onError(handler: RpcErrorHandler): void {
    this.errorHandler = handler
  }

  private async post(
    url: string,
    data: string,
    dispatcher: Agent | null
  ): Promise<void> {
    try {
      const { body } = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
        },
        body: data,
        dispatcher: dispatcher ?? undefined,
      })
      const text = await body.text()
      this.messageHandler?.(text)
    } catch (err) {
      this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
