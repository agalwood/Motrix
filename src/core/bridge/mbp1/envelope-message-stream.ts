// MBP1 AEAD envelope as a WebSocket adapter
// (docs/bridge-pairing-protocol.md §10).
//
// `envelope.ts` owns the frame format; this module is the seam that puts it
// underneath MDXP. It wraps a live socket so that everything above it — the
// `WebSocketMessageReader`/`WebSocketMessageWriter` pair and therefore the
// whole `MdxpConnection` — keeps speaking plain JSON while every byte on the
// wire is a sealed binary frame.
//
// Three properties are load-bearing and each is easy to lose by accident:
//
//   1. **A frame is opened exactly once, then fanned out.** Two adapters share
//      one wrapper (the reader registers `'message'`, and both the reader and
//      the writer register `'close'`), and `EnvelopeOpener` advances its strict
//      sequence counter on every successful open. Opening per listener would
//      make the second listener see a sequence mismatch on every frame.
//
//   2. **Only binary frames are envelopes.** `ws` in its default
//      `binaryType: 'nodebuffer'` mode delivers a TEXT frame as a `Buffer`
//      too, so `typeof data === 'string'` is not a discriminator; the
//      `isBinary` flag is. §10 makes a post-activation text frame a protocol
//      violation, and a wrapper that accepted one would hand injected
//      plaintext to MDXP as if it had been authenticated.
//
//   3. **A peer violation, a usage-bound closure, and an internal fault are
//      three different events, not two.** `EnvelopeViolationError`/
//      `ProtocolViolationError` mean the peer sent something §10 forbids;
//      `EnvelopeLimitError` means a direction reached its §10 frame/block
//      usage bound and MUST reconnect — expected, spec-mandated, and nobody's
//      fault; anything else means this process is broken. Collapsing the
//      first and third reports our own `TypeError` as "GCM authentication
//      failed", which reads as a wire attack during debugging. Collapsing the
//      second into either one instead reports a routine reconnect boundary as
//      an attack or a crash, which is exactly the same class of misattribution
//      one level up.
//
// This module handles traffic keys and plaintext MDXP payloads, so it logs
// nothing at any level (§11).

import { Buffer } from 'node:buffer'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { WebSocketLike } from '../web-socket-message-stream'
import { ProtocolViolationError } from './canonical'
import {
  EnvelopeLimitError,
  type EnvelopeOpener,
  type EnvelopeSealer,
  EnvelopeViolationError,
} from './envelope'

/** The live AEAD endpoints a completed MBP1 handshake hands over (§6.6, §8). */
export interface EnvelopeChannel {
  sealer: EnvelopeSealer
  opener: EnvelopeOpener
}

/**
 * Why the stream refused an inbound frame or failed to seal an outbound one.
 *
 * - `'peer-violation'` — the peer sent something §10 forbids (bad frame,
 *   tampering, replay, a post-activation text frame). The wiring MUST close;
 *   it is the peer's fault.
 * - `'usage-limit'` — a direction's §10 frame- or block-count usage bound was
 *   reached (`EnvelopeLimitError`). The wiring MUST close, but this is
 *   neither side's fault: §10 requires it before either bound is exceeded,
 *   and the remedy — reconnect and derive fresh keys (§8) — is the same
 *   whichever direction tripped it.
 * - `'internal'` — this process is broken (a bug, not a protocol event).
 *
 * A two-state `fromPeer` boolean cannot represent this: a usage-limit closure
 * is neither an accusation nor a confession, and forcing it into either
 * bucket reports a routine, spec-mandated reconnect boundary as either an
 * attack or a crash — the same misattribution the `EnvelopeViolationError`
 * vs. internal-fault split above already exists to avoid one level down.
 */
export type EnvelopeStreamFaultKind =
  | 'peer-violation'
  | 'usage-limit'
  | 'internal'

export interface EnvelopeStreamFault {
  readonly kind: EnvelopeStreamFaultKind
  /** The violation/limit error itself, or — for an internal fault — a
   *  wrapper whose `cause` is the original error. */
  readonly cause: Error
}

/** §10 usage counters for the outbound direction. Exposed so a caller could
 *  re-establish the connection with fresh keys before either bound is reached
 *  — but **no production code reads this yet**, so `EnvelopeLimitError` at the
 *  boundary is currently the operative path rather than a backstop behind a
 *  proactive one. */
export interface EnvelopeUsage {
  readonly frames: number
  readonly blocks: number
}

export interface EnvelopeStream extends WebSocketLike {
  readonly usage: EnvelopeUsage
}

type MessageListener = (data: Buffer | string, isBinary?: boolean) => void
type CloseListener = () => void
type ErrorListener = (err: Error) => void

/**
 * Wraps `ws` so inbound binary envelopes surface as plaintext `'message'`
 * events and outbound writes leave sealed.
 *
 * `channel` MUST be the pair of endpoints the handshake produced, never
 * freshly constructed ones: their sequence counters continue from the
 * credential exchange (`/pair` already sealed `credentialCommitted`), and a
 * fresh `EnvelopeSealer` would silently restart at seq 0 and desynchronize the
 * peer's opener.
 */
export function wrapWithEnvelope(
  ws: WebSocketLike,
  channel: EnvelopeChannel,
  onViolation: (fault: EnvelopeStreamFault) => void
): EnvelopeStream {
  return new EnvelopeMessageStream(ws, channel, onViolation)
}

class EnvelopeMessageStream implements EnvelopeStream {
  private readonly listeners = new Set<MessageListener>()
  private attached = false

  /** The single raw listener; opens each frame once and fans the plaintext
   *  out to every registered listener. */
  private readonly rawListener: MessageListener = (data, isBinary) => {
    if (isBinary !== true) {
      // §10: text frames after channel activation are a protocol violation.
      this.onViolation({
        kind: 'peer-violation',
        cause: new EnvelopeViolationError(
          'received a text frame after channel activation'
        ),
      })
      return
    }

    let plaintext: Uint8Array
    try {
      plaintext = this.channel.opener.open(toBytes(data))
    } catch (error) {
      this.onViolation(faultFromOpen(error))
      return
    }

    // A `Buffer`, never a bare `Uint8Array`: `WebSocketMessageReader` calls
    // `data.toString('utf8')`, which on a plain `Uint8Array` answers
    // comma-joined digits and then dies at `JSON.parse`.
    const frame = Buffer.from(plaintext)
    // Snapshot: a listener may remove itself (or another) while dispatching.
    for (const listener of [...this.listeners]) {
      listener(frame, true)
    }
  }

  constructor(
    private readonly ws: WebSocketLike,
    private readonly channel: EnvelopeChannel,
    private readonly onViolation: (fault: EnvelopeStreamFault) => void
  ) {}

  /** Live, not copied: `MessageWriter.write`/`end` compare it per call. */
  get readyState(): number {
    return this.ws.readyState
  }

  get usage(): EnvelopeUsage {
    return {
      frames: this.channel.sealer.sealedFrameCount,
      blocks: this.channel.sealer.sealedBlockCount,
    }
  }

  on(event: 'message', listener: MessageListener): void
  on(event: 'close', listener: CloseListener): void
  on(event: 'error', listener: ErrorListener): void
  on(
    event: 'message' | 'close' | 'error',
    listener: MessageListener | CloseListener | ErrorListener
  ): void {
    if (event === 'message') {
      this.listeners.add(listener as MessageListener)
      if (!this.attached) {
        this.attached = true
        this.ws.on('message', this.rawListener)
      }
      return
    }
    if (event === 'close') {
      this.ws.on('close', listener as CloseListener)
      return
    }
    this.ws.on('error', listener as ErrorListener)
  }

  off(event: 'message', listener: MessageListener): void
  off(event: 'close', listener: CloseListener): void
  off(event: 'error', listener: ErrorListener): void
  off(
    event: 'message' | 'close' | 'error',
    listener: MessageListener | CloseListener | ErrorListener
  ): void {
    if (event === 'message') {
      this.listeners.delete(listener as MessageListener)
      if (this.attached && this.listeners.size === 0) {
        this.attached = false
        this.ws.off('message', this.rawListener)
      }
      return
    }
    if (event === 'close') {
      this.ws.off('close', listener as CloseListener)
      return
    }
    this.ws.off('error', listener as ErrorListener)
  }

  /**
   * Seals and sends.
   *
   * A `seal` failure is a connection-level event. `EnvelopeLimitError` means
   * the §10 usage bound requires a reconnect with fresh keys. An outbound
   * `EnvelopeViolationError` means this process attempted to violate §10's
   * 1 MiB plaintext limit; unlike the same class from inbound `open()`, that
   * is an internal error rather than a peer protocol error. Both go to the
   * fault sink before being rethrown so the WebSocket cannot remain live after
   * the transport has refused an application frame. Any unexpected sealer
   * failure is classified as internal for the same fail-closed reason.
   *
   * Either way the error is rethrown to the immediate caller —
   * `WebSocketMessageWriter.write` reports it on its own error emitter and
   * rethrows again — because the specific write that failed still needs to
   * fail for whoever issued it (e.g. a pending `sendRequest`'s promise).
   */
  send(data: string | Uint8Array): void {
    const plaintext = typeof data === 'string' ? utf8ToBytes(data) : data
    let sealed: Uint8Array
    try {
      sealed = this.channel.sealer.seal(plaintext)
    } catch (error) {
      if (error instanceof EnvelopeLimitError) {
        // Not wrapped, for the same reason `faultFromOpen` does not wrap it:
        // the error's own message already reads as a usage-bound close.
        this.onViolation({ kind: 'usage-limit', cause: error })
      } else {
        this.onViolation({
          kind: 'internal',
          cause:
            error instanceof Error
              ? error
              : new Error('envelope stream failed to seal an outbound frame', {
                  cause: error,
                }),
        })
      }
      throw error
    }
    this.ws.send(sealed)
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }
}

/** A zero-copy view of the raw frame; `data` is a `Buffer` on every real socket. */
function toBytes(data: Buffer | string): Uint8Array {
  return typeof data === 'string'
    ? utf8ToBytes(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Classifies an `EnvelopeOpener.open` (inbound) failure. `EnvelopeLimitError`
 * is checked before the peer-violation types: it is thrown from a check on
 * this direction's OWN counter, before the frame is even parsed (see
 * `envelope.ts`), so it is never also an `EnvelopeViolationError` — the order
 * here documents that these are disjoint, not a priority between them.
 */
function faultFromOpen(error: unknown): EnvelopeStreamFault {
  if (error instanceof EnvelopeLimitError) {
    // Not wrapped: `EnvelopeLimitError`'s own message ("usage bound reached
    // ...; reconnect required") already reads as a usage-bound close without
    // needing the reader to know this `kind` exists.
    return { kind: 'usage-limit', cause: error }
  }
  if (
    error instanceof EnvelopeViolationError ||
    error instanceof ProtocolViolationError
  ) {
    return { kind: 'peer-violation', cause: error }
  }
  return {
    kind: 'internal',
    cause: new Error('envelope stream failed to open an inbound frame', {
      cause: error,
    }),
  }
}
