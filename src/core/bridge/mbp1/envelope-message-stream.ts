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
//   3. **A peer violation and an internal fault are different events.**
//      `EnvelopeViolationError`/`ProtocolViolationError` mean the peer sent
//      something §10 forbids; anything else means this process is broken.
//      Collapsing the two reports our own `TypeError` as "GCM authentication
//      failed", which reads as a wire attack during debugging.
//
// This module handles traffic keys and plaintext MDXP payloads, so it logs
// nothing at any level (§11).

import { Buffer } from 'node:buffer'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { WebSocketLike } from '../web-socket-message-stream'
import { ProtocolViolationError } from './canonical'
import {
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
 * Why the stream refused an inbound frame. `fromPeer` is the whole point of
 * the type: the wiring must close either way, but it must never attribute its
 * own fault to the peer, and a caller that only had `() => void` to work with
 * has no way to keep them apart.
 */
export interface EnvelopeStreamFault {
  /** `true` for a §10 violation the peer caused; `false` for an internal fault. */
  readonly fromPeer: boolean
  /** The violation itself, or — for an internal fault — a wrapper whose
   *  `cause` is the original error. */
  readonly cause: Error
}

/** §10 usage counters for the outbound direction, read by the wiring so a
 *  connection can be re-established with fresh keys before either bound is
 *  reached; `EnvelopeLimitError` is the backstop, not the intended path. */
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
        fromPeer: true,
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
      this.onViolation(faultFrom(error))
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
   * Seals and sends. A `seal` failure (over 1 MiB, or a §10 usage bound)
   * throws through to `WebSocketMessageWriter.write`, which reports it on its
   * error emitter and rethrows to the caller — the documented backstop.
   */
  send(data: string | Uint8Array): void {
    const plaintext = typeof data === 'string' ? utf8ToBytes(data) : data
    this.ws.send(this.channel.sealer.seal(plaintext))
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

function faultFrom(error: unknown): EnvelopeStreamFault {
  if (
    error instanceof EnvelopeViolationError ||
    error instanceof ProtocolViolationError
  ) {
    return { fromPeer: true, cause: error }
  }
  return {
    fromPeer: false,
    cause: new Error('envelope stream failed to open an inbound frame', {
      cause: error,
    }),
  }
}
