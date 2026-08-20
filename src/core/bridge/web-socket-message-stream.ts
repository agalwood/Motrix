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
 * Adapts a `ws.WebSocket` instance (server- or client-side) to
 * vscode-jsonrpc's `MessageReader`/`MessageWriter` interface so a
 * `MessageConnection` can run over a WebSocket.
 *
 * Each WebSocket frame is one complete JSON-RPC 2.0 message. There is
 * no Content-Length framing — the WebSocket protocol already handles
 * message boundaries.
 */

// Minimal subset of ws.WebSocket we depend on. Avoids a hard dep on
// `ws` types in @core, which would be an architectural smell (core is
// engine-agnostic). Caller passes any object matching this shape.
//
// `isBinary` is NOT optional in spirit, only in the type: `ws` runs in its
// default `binaryType: 'nodebuffer'` mode, where a text frame and a binary
// frame BOTH arrive as a `Buffer`, so `typeof data === 'string'` cannot tell
// them apart. Anything that must distinguish the two — the MBP1 envelope
// stream, the pre-authentication demux — has to read this flag. It is declared
// optional so a socket double that omits it still satisfies the interface; the
// consumers treat "absent" as "not binary", which is the fail-closed reading.
//
// `send` accepts bytes as well as text because the envelope stream sends
// sealed binary frames through the same seam the JSON writer uses.
export interface WebSocketLike {
  readyState: number
  on(
    event: 'message',
    listener: (data: Buffer | string, isBinary?: boolean) => void
  ): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  off(
    event: 'message',
    listener: (data: Buffer | string, isBinary?: boolean) => void
  ): void
  off(event: 'close', listener: () => void): void
  off(event: 'error', listener: (err: Error) => void): void
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

const OPEN_STATE = 1

export class WebSocketMessageReader implements MessageReader {
  private readonly errorEmitter = new Emitter<Error>()
  private readonly closeEmitter = new Emitter<void>()
  private readonly partialMessageEmitter = new Emitter<PartialMessageInfo>()
  private dataCallback: DataCallback | null = null
  private messageListener = (data: Buffer | string): void => {
    if (!this.dataCallback) return
    let text: string
    try {
      text = typeof data === 'string' ? data : data.toString('utf8')
    } catch (e) {
      this.errorEmitter.fire(
        new Error(`failed to decode WS data: ${(e as Error).message}`)
      )
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      this.errorEmitter.fire(
        new Error(`failed to parse WS frame as JSON: ${(e as Error).message}`)
      )
      return
    }
    this.dataCallback(parsed as Message)
  }
  private closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }
  private errorListener = (err: Error): void => {
    this.errorEmitter.fire(err)
  }
  private attached = false

  constructor(private readonly ws: WebSocketLike) {}

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
      throw new Error('WebSocketMessageReader already listening')
    }
    this.dataCallback = callback
    this.ws.on('message', this.messageListener)
    this.ws.on('close', this.closeListener)
    this.ws.on('error', this.errorListener)
    this.attached = true
    return { dispose: () => this.dispose() }
  }

  dispose(): void {
    if (!this.attached) return
    this.ws.off('message', this.messageListener)
    this.ws.off('close', this.closeListener)
    this.ws.off('error', this.errorListener)
    this.attached = false
    this.dataCallback = null
    this.errorEmitter.dispose()
    this.closeEmitter.dispose()
    this.partialMessageEmitter.dispose()
  }
}

export class WebSocketMessageWriter implements MessageWriter {
  private readonly errorEmitter = new Emitter<
    [Error, Message | undefined, number | undefined]
  >()
  private readonly closeEmitter = new Emitter<void>()
  private closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }
  private attached = false

  constructor(private readonly ws: WebSocketLike) {
    this.ws.on('close', this.closeListener)
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
    if (this.ws.readyState === OPEN_STATE) {
      this.ws.close()
    }
  }

  dispose(): void {
    if (!this.attached) return
    this.ws.off('close', this.closeListener)
    this.attached = false
    this.errorEmitter.dispose()
    this.closeEmitter.dispose()
  }
}
