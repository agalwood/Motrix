import type {
  DataCallback,
  Disposable,
  Message,
  MessageReader,
  MessageWriter,
  PartialMessageInfo,
} from 'vscode-jsonrpc'
import { Emitter } from 'vscode-jsonrpc'

/**
 * Browser-side WebSocket → vscode-jsonrpc MessageReader/Writer adapter.
 * Mirrors Motrix's WebSocketMessageStream but uses the browser
 * WebSocket event model (addEventListener + MessageEvent.data) instead
 * of Node's ws.WebSocket (EventEmitter + Buffer).
 */

const OPEN_STATE = 1
const CLOSED_STATE = 3

export class BrowserWebSocketMessageReader implements MessageReader {
  private readonly errorEmitter = new Emitter<Error>()
  private readonly closeEmitter = new Emitter<void>()
  private readonly partialMessageEmitter = new Emitter<PartialMessageInfo>()
  private dataCallback: DataCallback | null = null
  private attached = false

  private readonly messageListener = (ev: Event): void => {
    if (!this.dataCallback) return
    const data = (ev as MessageEvent).data
    let text: string
    if (typeof data === 'string') {
      text = data
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data)
    } else {
      this.errorEmitter.fire(new Error('unsupported WS frame type'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      this.errorEmitter.fire(
        new Error(`failed to parse WS frame: ${(e as Error).message}`)
      )
      return
    }
    this.dataCallback(parsed as Message)
  }

  private readonly closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }

  private readonly errorListener = (): void => {
    this.errorEmitter.fire(new Error('WebSocket error event'))
  }

  constructor(private readonly ws: WebSocket) {}

  get onError() {
    return this.errorEmitter.event
  }
  get onClose() {
    return this.closeEmitter.event
  }
  get onPartialMessage() {
    return this.partialMessageEmitter.event
  }

  listen(callback: DataCallback): Disposable {
    if (this.attached) {
      throw new Error('BrowserWebSocketMessageReader already listening')
    }
    this.dataCallback = callback
    this.ws.addEventListener('message', this.messageListener)
    this.ws.addEventListener('close', this.closeListener)
    this.ws.addEventListener('error', this.errorListener)
    this.attached = true
    return { dispose: () => this.dispose() }
  }

  dispose(): void {
    if (!this.attached) return
    this.ws.removeEventListener('message', this.messageListener)
    this.ws.removeEventListener('close', this.closeListener)
    this.ws.removeEventListener('error', this.errorListener)
    this.attached = false
    this.dataCallback = null
    this.errorEmitter.dispose()
    this.closeEmitter.dispose()
    this.partialMessageEmitter.dispose()
  }
}

export class BrowserWebSocketMessageWriter implements MessageWriter {
  private readonly errorEmitter = new Emitter<
    [Error, Message | undefined, number | undefined]
  >()
  private readonly closeEmitter = new Emitter<void>()
  private readonly closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }
  private attached = false

  constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener('close', this.closeListener)
    this.attached = true
  }

  get onError() {
    return this.errorEmitter.event
  }
  get onClose() {
    return this.closeEmitter.event
  }

  async write(msg: Message): Promise<void> {
    if (this.ws.readyState !== OPEN_STATE) {
      throw new Error(`WebSocket is closed (readyState=${this.ws.readyState})`)
    }
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (e) {
      this.errorEmitter.fire([e as Error, msg, undefined])
      throw e
    }
  }

  end(): void {
    if (this.ws.readyState === OPEN_STATE) this.ws.close()
  }

  dispose(): void {
    if (!this.attached) return
    this.ws.removeEventListener('close', this.closeListener)
    this.attached = false
    this.errorEmitter.dispose()
    this.closeEmitter.dispose()
  }
}

// Kept for forward-compatibility — referenced by Plan 03a docs.
export const WEBSOCKET_OPEN_STATE = OPEN_STATE
export const WEBSOCKET_CLOSED_STATE = CLOSED_STATE
