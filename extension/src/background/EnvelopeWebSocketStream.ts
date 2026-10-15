/**
 * Post-authentication MDXP transport (bridge-pairing-protocol.md §10): seals
 * and opens every JSON-RPC message through the §6.6/§8 AEAD envelope before
 * it ever touches the wire. Mirrors `BrowserWebSocketMessageReader`/`Writer`'s
 * shape exactly — `createMdxpConnection` cannot tell the difference, since
 * the only change is what sits between the socket and JSON.
 *
 * MBP1 authenticates *below* MDXP: `motrix/initialize` is the first
 * application message, and it goes inside this envelope, never before it —
 * the caller is expected to hand this reader/writer a socket only after a
 * `PairingFlow`/`ReconnectFlow` run has already verified the peer and
 * returned the `EnvelopeCodec` to wrap it with.
 *
 * ## Why seal/open calls must be serialized, not merely awaited
 *
 * `EnvelopeCodec.seal`/`open` read a per-direction sequence counter, await a
 * WebCrypto operation, and only *then* increment it. Two overlapping calls
 * would both read the same counter value before either increments it —
 * producing two outbound frames claiming the same seq (a corrupt stream), or
 * rejecting the second inbound frame as a `sequenceMismatch` even though it
 * arrived in the right order. `createOperationQueue()` — already used for
 * exactly this shape elsewhere in `background/mbp1/` — makes every seal and
 * every open run to completion before the next one starts.
 *
 * ## Envelope violations close the connection, always
 *
 * §10: every `EnvelopeViolation`, from either `seal` or `open`, MUST close
 * the connection — none is recoverable in place. Both classes here close the
 * underlying `WebSocket` unconditionally on one. §11 labels these closures
 * `1002`/`4001`/`1011`, but a browser can only send `4001` of those — the
 * WebSocket API throws `InvalidAccessError` for any close code outside
 * 1000/3000–4999 — so this side sends `4001` when a §10 usage bound trips
 * (either direction: nobody misbehaved, and the remedy — reconnect via §8
 * with fresh keys — is the same whichever key was exhausted) and a bare
 * `close()` for every other fault. §11 permits exactly that: clients MUST
 * NOT branch on close codes; they exist to make logs legible, not to carry
 * protocol state. `ConnectionManager`'s existing close-driven reconnect —
 * the same mechanism the remote path already relies on — is what
 * re-establishes the session; nothing in this module talks to
 * `ConnectionManager` directly.
 */
import type {
  DataCallback,
  Disposable,
  Message,
  MessageReader,
  MessageWriter,
  PartialMessageInfo,
} from 'vscode-jsonrpc'
import { Emitter } from 'vscode-jsonrpc'
import type { EnvelopeCodec } from '@/background/mbp1/envelope'
import { EnvelopeViolation } from '@/background/mbp1/envelope'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

const OPEN_STATE = 1
const CLOSED_STATE = 3
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * §11's usage-bound close code — the one §11 code inside the 1000/3000–4999
 * range the WebSocket API lets a browser send (see the module doc).
 */
const WS_CLOSE_ENVELOPE_USAGE_LIMIT = 4001

function closeIfOpen(ws: WebSocket, code?: number): void {
  if (ws.readyState === CLOSED_STATE) return
  if (code === undefined) {
    ws.close()
    return
  }
  ws.close(code)
}

/**
 * The close code for an `EnvelopeViolation`, from either direction:
 * `usageBoundExceeded` is §11's `4001`; everything else closes bare because
 * the code §11 would assign (`1002` for a peer violation, `1011` for our own
 * fault) is unsendable from a browser.
 */
function closeCodeFor(violation: EnvelopeViolation): number | undefined {
  return violation.reason === 'usageBoundExceeded'
    ? WS_CLOSE_ENVELOPE_USAGE_LIMIT
    : undefined
}

export class EnvelopeMessageReader implements MessageReader {
  private readonly errorEmitter = new Emitter<Error>()
  private readonly closeEmitter = new Emitter<void>()
  private readonly partialMessageEmitter = new Emitter<PartialMessageInfo>()
  /** Serializes `envelope.open` calls — see the module doc. */
  private readonly enqueue = createOperationQueue()
  private dataCallback: DataCallback | null = null
  private listening = false
  private disposed = false
  /**
   * Messages already opened and parsed before `listen()` supplied a
   * callback to deliver them to. Decrypting cannot wait for `listen()` —
   * see the constructor's own doc — so a message that arrives in that
   * window is held here, in arrival order, until `listen()` flushes it.
   */
  private readonly pendingMessages: Message[] = []

  private readonly messageListener = (ev: Event): void => {
    const data = (ev as MessageEvent).data
    if (!(data instanceof ArrayBuffer)) {
      this.errorEmitter.fire(
        new Error('unsupported WS frame type (expected binary)')
      )
      // §10: a text frame after channel activation is a protocol violation
      // and MUST close the connection (bare — 1002 is unsendable here).
      closeIfOpen(this.ws)
      return
    }
    const frame = new Uint8Array(data)
    void this.enqueue(() => this.handleFrame(frame))
  }

  private readonly closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }

  private readonly errorListener = (): void => {
    this.errorEmitter.fire(new Error('WebSocket error event'))
  }

  /**
   * Listeners attach here, in the constructor, not in `listen()`. The
   * caller (`ConnectionManager.finishMbp1Connection`) awaits at least one
   * real `storage.local` write — `gate.pausePending()`, on the first-pair
   * path — between constructing this reader and calling `listen()` from
   * `doInitialize`. A proactive envelope-sealed frame from a peer that
   * behaved perfectly must not find the socket with no listener at all in
   * that gap; attaching here instead of in `listen()` closes it. Opening
   * cannot wait for `listen()` either, or the §10 sequence counter would
   * desync the moment a live frame is finally allowed to run ahead of one
   * still sitting on the wire — so a frame that arrives before `listen()`
   * is opened and parsed immediately, through the same `enqueue`d,
   * in-order path as always, and only its *delivery* waits, in
   * `pendingMessages`.
   *
   * `preQueuedFrames` are handed over from a pre-auth
   * `WebSocketFrameChannel.release()` — anything that arrived after the
   * flow's last `receive*()` call but before the socket was handed to this
   * reader. Enqueued here too, before the listener above can observe
   * anything new (event dispatch happens on a later turn of the event
   * loop), so they open strictly before whatever the listener picks up.
   */
  constructor(
    private readonly ws: WebSocket,
    private readonly envelope: EnvelopeCodec,
    private readonly preQueuedFrames: Uint8Array[] = []
  ) {
    this.ws.addEventListener('message', this.messageListener)
    this.ws.addEventListener('close', this.closeListener)
    this.ws.addEventListener('error', this.errorListener)
    for (const frame of this.preQueuedFrames) {
      void this.enqueue(() => this.handleFrame(frame))
    }
  }

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
    if (this.listening) {
      throw new Error('EnvelopeMessageReader already listening')
    }
    this.listening = true
    this.dataCallback = callback
    // Flushed in the order each was opened, i.e. true wire order — some of
    // these may be `preQueuedFrames`, some may have arrived live before
    // this call, and both interleave correctly because both went through
    // the same `enqueue`d path above.
    for (const message of this.pendingMessages.splice(0)) {
      callback(message)
    }
    return { dispose: () => this.dispose() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ws.removeEventListener('message', this.messageListener)
    this.ws.removeEventListener('close', this.closeListener)
    this.ws.removeEventListener('error', this.errorListener)
    this.dataCallback = null
    this.errorEmitter.dispose()
    this.closeEmitter.dispose()
    this.partialMessageEmitter.dispose()
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    let plaintext: Uint8Array
    try {
      plaintext = await this.envelope.open(frame)
    } catch (error) {
      if (error instanceof EnvelopeViolation) {
        // Attribution follows the method that threw (`envelope.ts`'s own
        // rule): every reason `open` can throw is the peer's, except
        // `usageBoundExceeded`, which is nobody's fault and closes with
        // §11's 4001 — either way §10 requires closing.
        this.errorEmitter.fire(
          new Error(`envelope open failed: ${error.reason}`)
        )
        closeIfOpen(this.ws, closeCodeFor(error))
        return
      }
      this.errorEmitter.fire(error as Error)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(textDecoder.decode(plaintext))
    } catch (error) {
      this.errorEmitter.fire(
        new Error(
          `failed to parse envelope plaintext: ${(error as Error).message}`
        )
      )
      return
    }
    if (this.dataCallback === null) {
      this.pendingMessages.push(parsed as Message)
      return
    }
    this.dataCallback(parsed as Message)
  }
}

export class EnvelopeMessageWriter implements MessageWriter {
  private readonly errorEmitter = new Emitter<
    [Error, Message | undefined, number | undefined]
  >()
  private readonly closeEmitter = new Emitter<void>()
  /** Serializes `envelope.seal` calls — see the module doc. */
  private readonly enqueue = createOperationQueue()
  private readonly closeListener = (): void => {
    this.closeEmitter.fire(undefined)
  }
  private attached = false

  constructor(
    private readonly ws: WebSocket,
    private readonly envelope: EnvelopeCodec
  ) {
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
    return this.enqueue(async () => {
      if (this.ws.readyState !== OPEN_STATE) {
        const error = new Error(
          `WebSocket is closed (readyState=${this.ws.readyState})`
        )
        this.errorEmitter.fire([error, msg, undefined])
        throw error
      }
      let sealed: Uint8Array
      try {
        sealed = await this.envelope.seal(
          textEncoder.encode(JSON.stringify(msg))
        )
      } catch (error) {
        if (error instanceof EnvelopeViolation) {
          // From `seal`, every reason is this side's own fault except
          // `usageBoundExceeded` — exhausting our own outbound key is a
          // routine §10 transition and closes with §11's 4001, like the
          // inbound bound — but §10 requires closing either way.
          this.errorEmitter.fire([error, msg, undefined])
          closeIfOpen(this.ws, closeCodeFor(error))
          throw error
        }
        this.errorEmitter.fire([error as Error, msg, undefined])
        throw error
      }
      try {
        // Narrows `Uint8Array<ArrayBufferLike>` to the concrete `ArrayBuffer`
        // backing `WebSocket.send`'s `BufferSource` overload requires; every
        // byte value `EnvelopeCodec` produces is a plain heap-allocated
        // `Uint8Array`, never a `SharedArrayBuffer` view (same rationale as
        // `envelope.ts`'s own `asBufferSource`).
        this.ws.send(sealed as Uint8Array<ArrayBuffer>)
      } catch (error) {
        this.errorEmitter.fire([error as Error, msg, undefined])
        throw error
      }
    })
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
