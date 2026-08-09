import WebSocket from 'ws'

type MessageHandler = (data: string) => void
type CloseHandler = (code: number, reason: string) => void
type ErrorHandler = (err: Error) => void

export class WebSocketTransport {
  private ws: WebSocket | null = null
  private connected = false

  private messageHandler: MessageHandler | null = null
  private closeHandler: CloseHandler | null = null
  private errorHandler: ErrorHandler | null = null

  connect(url: string): Promise<void> {
    if (this.connected) {
      return Promise.reject(new Error('WebSocket is already connected'))
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)

      ws.on('open', () => {
        this.ws = ws
        this.connected = true
        resolve()
      })

      ws.on('error', (err: Error) => {
        if (!this.connected) {
          reject(err)
        } else {
          this.errorHandler?.(err)
        }
      })

      ws.on('message', (data: unknown) => {
        this.messageHandler?.(String(data))
      })

      ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false
        this.closeHandler?.(code, reason.toString())
      })
    })
  }

  disconnect(): void {
    if (!this.ws) return
    this.connected = false
    this.ws.removeAllListeners()
    this.ws.close()
    this.ws = null
  }

  isConnected(): boolean {
    return this.connected
  }

  send(data: string): void {
    if (!this.ws || !this.connected) {
      throw new Error('WebSocket is not connected')
    }
    this.ws.send(data)
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onClose(handler: CloseHandler): void {
    this.closeHandler = handler
  }

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler
  }
}
