import type {
  AuthenticatedBridgeClient,
  BridgeClientAuthorization,
} from './client-authorization'
import type { EnvelopeStream } from './mbp1/envelope-message-stream'

const MAX_PENDING_FRAMES = 32
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const LOOKUP_TIMEOUT_MS = 5000
const RECHECK_INTERVAL_MS = 10_000
const unavailable = () =>
  new Error('Extension account authorization unavailable')
type MessageListener = (data: Buffer | string, isBinary?: boolean) => void

/** Account admission above the authenticated envelope and below JSON-RPC.
 * Both directions stay ordered; even JSON-RPC responses and cancellations pass
 * the gate. Shell authorization also owns the handler's async identity context.
 * No frame, credential, account response or error detail is logged here. */
export class AuthorizedEnvelopeStream implements EnvelopeStream {
  private readonly listeners = new Set<MessageListener>()
  private readonly cancellations = new Set<() => void>()
  private incoming = Promise.resolve()
  private outgoing = Promise.resolve()
  private pendingFrames = 0
  private pendingBytes = 0
  private closed = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private checking = false

  constructor(
    private readonly stream: EnvelopeStream,
    private readonly client: AuthenticatedBridgeClient,
    private readonly authorization: BridgeClientAuthorization,
    private readonly current: () => boolean,
    private readonly onDenied: () => void
  ) {
    stream.on('message', this.receive)
    stream.on('close', this.dispose)
  }

  get readyState(): number {
    return this.closed ? 3 : this.stream.readyState
  }

  get usage() {
    return this.stream.usage
  }

  /** Called only after synchronous MBP1 session adoption is complete. */
  start(): void {
    if (this.closed || this.heartbeat) return
    const recheck = () => {
      if (this.closed || this.checking) return
      this.checking = true
      void this.run(async () => undefined)
        .catch(() => {})
        .finally(() => {
          this.checking = false
        })
    }
    this.heartbeat = setInterval(recheck, RECHECK_INTERVAL_MS)
    this.heartbeat.unref()
    recheck()
  }

  /** The lookup deadline ends when the operation starts. Legitimate handlers
   * may run longer; their eventual response must pass outbound admission again. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    let entered = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: (() => void) | undefined
    try {
      this.assertCurrent()
      const deadline = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(unavailable())
        this.cancellations.add(cancel)
        timer = setTimeout(cancel, LOOKUP_TIMEOUT_MS)
      })
      return await Promise.race([
        Promise.resolve().then(() =>
          this.authorization.run(this.client, async () => {
            this.assertCurrent()
            clearTimeout(timer)
            if (cancel) this.cancellations.delete(cancel)
            entered = true
            return operation()
          })
        ),
        deadline,
      ])
    } catch (error) {
      // A business error (for example a denied save directory) is an RPC
      // result, not evidence that the account itself has lost authorization.
      if (!entered) this.deny()
      throw error
    } finally {
      clearTimeout(timer)
      if (cancel) this.cancellations.delete(cancel)
    }
  }

  on(event: 'message', listener: MessageListener): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(
    event: 'message' | 'close' | 'error',
    listener: MessageListener | (() => void) | ((error: Error) => void)
  ): void {
    if (event === 'message') this.listeners.add(listener as MessageListener)
    else if (event === 'close') this.stream.on(event, listener as () => void)
    else this.stream.on(event, listener as (error: Error) => void)
  }

  off(event: 'message', listener: MessageListener): void
  off(event: 'close', listener: () => void): void
  off(event: 'error', listener: (error: Error) => void): void
  off(
    event: 'message' | 'close' | 'error',
    listener: MessageListener | (() => void) | ((error: Error) => void)
  ): void {
    if (event === 'message') this.listeners.delete(listener as MessageListener)
    else if (event === 'close') this.stream.off(event, listener as () => void)
    else this.stream.off(event, listener as (error: Error) => void)
  }

  send(data: string | Uint8Array): Promise<void> {
    return this.enqueue('outgoing', data, async () => {
      await this.stream.send(data)
    })
  }

  close(code?: number, reason?: string): void {
    this.dispose()
    this.stream.close(code, reason)
  }

  readonly dispose = (): void => {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    this.stream.off('message', this.receive)
    this.stream.off('close', this.dispose)
    this.listeners.clear()
    for (const cancel of this.cancellations) cancel()
    this.cancellations.clear()
  }

  private readonly receive: MessageListener = (data, isBinary) => {
    void this.enqueue('incoming', data, async () => {
      for (const listener of [...this.listeners]) {
        this.assertCurrent()
        listener(data, isBinary)
      }
    }).catch(() => this.deny())
  }

  private enqueue(
    direction: 'incoming' | 'outgoing',
    data: string | Uint8Array,
    operation: () => Promise<void>
  ): Promise<void> {
    const bytes =
      typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (
      this.closed ||
      this.pendingFrames >= MAX_PENDING_FRAMES ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      this.deny()
      return Promise.reject(unavailable())
    }
    this.pendingFrames++
    this.pendingBytes += bytes
    const pending = this[direction]
      .then(() => this.run(operation))
      .finally(() => {
        this.pendingFrames--
        this.pendingBytes -= bytes
      })
    this[direction] = pending.catch(() => {})
    return pending
  }

  private assertCurrent(): void {
    if (this.closed || this.stream.readyState !== 1 || !this.current())
      throw unavailable()
  }

  private deny(): void {
    if (this.closed) return
    this.dispose()
    try {
      this.onDenied()
    } catch {
      // Publication/cleanup failures cannot restore frame admission.
    }
    try {
      if (this.stream.readyState === 1)
        this.stream.close(1008, 'Authorization unavailable')
    } catch {
      // The stream is already disposed and no queued frame can be delivered.
    }
  }
}
