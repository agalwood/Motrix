// MBP1 AEAD envelope (docs/bridge-pairing-protocol.md §10).
//
// Wraps every post-handshake frame in both directions, sitting below MDXP:
// the MDXP JSON-RPC payload bytes are the plaintext, unchanged. Frames are
// WebSocket binary messages, one frame per message. `seq` is a strict
// monotonic per-direction counter with no receive window — any gap, repeat,
// or GCM authentication failure MUST close the connection immediately. This
// strict sequence check IS the replay protection; there is no separate
// replay cache.
//
// Nonce uniqueness holds per key by construction (`dirTag ‖ seq`, seq never
// repeats within a direction), but usage bounds are a separate concern: a
// connection MUST be re-established via reconnect — deriving fresh keys —
// before either direction exceeds 2^24 frames or 2^30 encrypted AES blocks.
// There is no in-place rekey in v1.
//
// Keys and plaintexts handled here are secret-adjacent; this module logs
// nothing at any level.

import { createCipheriv, createDecipheriv } from 'node:crypto'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { concatBytes, encU32BE, encU64BE, os2ip } from './canonical'

export const DIR_C2S = 1 as const
export const DIR_S2C = 2 as const
export type EnvelopeDirection = typeof DIR_C2S | typeof DIR_S2C

/** Malformed frame, dirTag/key mismatch, GCM auth failure, or out-of-order `seq` (§10, §11 `protocolViolation`). */
export class EnvelopeViolationError extends Error {}

/**
 * A direction has reached its 2^24-frame or 2^30-block usage bound and MUST
 * reconnect (§10). Thrown by both `EnvelopeSealer.seal` (outbound) and
 * `EnvelopeOpener.open` (inbound): the remedy is identical either way — close
 * the connection and re-establish it with fresh keys — so this is kept
 * distinct from `EnvelopeViolationError` even on the inbound side, where the
 * frame that trips it is otherwise entirely well-formed and authentic. A peer
 * that kept sending past the point where §10 required it to reconnect failed
 * a MUST, but it is not the same failure mode as a forged or replayed frame,
 * and the caller's response — reconnect, don't accuse — is the same as when
 * this side is the one approaching the bound.
 */
export class EnvelopeLimitError extends Error {}

const AAD = utf8ToBytes('MBP1/env/v1')
const SEQ_LENGTH = 8
const TAG_LENGTH = 16
const BLOCK_SIZE = 16
/** §10 maximum plaintext carried by one envelope. */
export const MAX_ENVELOPE_PLAINTEXT_BYTES = 1024 * 1024
/** Largest binary WebSocket message a conforming §10 envelope can produce. */
export const MAX_ENVELOPE_FRAME_BYTES =
  MAX_ENVELOPE_PLAINTEXT_BYTES + SEQ_LENGTH + TAG_LENGTH

/** §10 usage bound: a direction MUST reconnect with fresh keys before sealing this many frames. */
export const MAX_ENVELOPE_FRAMES = 2 ** 24

/** §10 usage bound: a direction MUST reconnect with fresh keys before sealing this many encrypted AES blocks (16 GiB of plaintext). */
export const MAX_ENVELOPE_BLOCKS = 2 ** 30

/**
 * The §10 usage-bound checks, shared by both directions.
 *
 * Extracted because the two sites were byte-identical, message included — which
 * made a log unable to say which direction had exhausted, and made a mutation
 * test unable to target one site without hitting the other. `side` fixes both:
 * the logic has one home, and the message names the direction.
 */
function assertFrameBoundNotReached(
  seq: number,
  side: 'outbound' | 'inbound'
): void {
  if (seq >= MAX_ENVELOPE_FRAMES) {
    throw new EnvelopeLimitError(
      `envelope ${side} frame-count usage bound reached (2^24 frames); reconnect required`
    )
  }
}

function assertBlockBoundNotReached(
  blockCount: number,
  blocks: number,
  side: 'outbound' | 'inbound'
): void {
  if (blockCount + blocks > MAX_ENVELOPE_BLOCKS) {
    throw new EnvelopeLimitError(
      `envelope ${side} encrypted-block usage bound reached (2^30 blocks); reconnect required`
    )
  }
}

/** `ceil(plaintextLength / 16)` encrypted AES blocks, for the §10 usage bound. */
function blockCountFor(length: number): number {
  return Math.ceil(length / BLOCK_SIZE)
}

/** `nonce = dirTag(4 bytes BE) ‖ seq64BE` (12 bytes, §10). */
function buildNonce(dir: EnvelopeDirection, seqBytes: Uint8Array): Uint8Array {
  return concatBytes(encU32BE(dir), seqBytes)
}

/**
 * Seals plaintext into successive envelope frames for one direction.
 *
 * `startSeq` and `startBlockCount` (both default 0, the real starting point
 * for a fresh connection — there is no in-place rekey in v1, so production
 * code never passes non-default values) are resume seams: the point at
 * which this sealer's counters begin, expressed as ordinary constructor
 * arguments rather than a production-only setter, so the 2^24-frame and
 * 2^30-block usage bounds are reachable and verifiable from a test.
 *
 * `sealedFrameCount`/`sealedBlockCount` expose this direction's §10 usage so a
 * caller *could* close and reconnect with fresh keys before either bound is
 * reached.
 *
 * **Nothing does that today.** Outside tests, the only reader is
 * `EnvelopeMessageStream`, which forwards them as `EnvelopeUsage`; no
 * production code consults that. So `EnvelopeLimitError` is the operative
 * path, not a backstop behind a proactive one, and §10's MUST is met by the
 * refusal at the boundary rather than by anticipating it. `EnvelopeOpener`
 * exposes no counter getters at all, so a future proactive layer would need
 * inbound ones added before it could act on that direction.
 */
export class EnvelopeSealer {
  private readonly key: Uint8Array
  private readonly dir: EnvelopeDirection
  private seq: number
  private blockCount: number

  constructor(
    key: Uint8Array,
    dir: EnvelopeDirection,
    startSeq = 0,
    startBlockCount = 0
  ) {
    this.key = key
    this.dir = dir
    this.seq = startSeq
    this.blockCount = startBlockCount
  }

  /** Number of frames this instance has sealed so far (§10 proactive-reconnect signal). */
  get sealedFrameCount(): number {
    return this.seq
  }

  /** Cumulative `ceil(plaintextLength / 16)` encrypted AES blocks this instance has sealed so far (§10 proactive-reconnect signal). */
  get sealedBlockCount(): number {
    return this.blockCount
  }

  /** `frame = seq64BE ‖ AES-256-GCM(key, nonce, plaintext, aad)` (§10). */
  seal(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_ENVELOPE_PLAINTEXT_BYTES) {
      throw new EnvelopeViolationError(
        `envelope plaintext of ${plaintext.length} bytes exceeds the 1 MiB frame limit`
      )
    }
    assertFrameBoundNotReached(this.seq, 'outbound')
    const blocks = blockCountFor(plaintext.length)
    assertBlockBoundNotReached(this.blockCount, blocks, 'outbound')

    const seqBytes = encU64BE(this.seq)
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.key,
      buildNonce(this.dir, seqBytes)
    )
    cipher.setAAD(AAD)
    const ciphertext = concatBytes(
      new Uint8Array(cipher.update(plaintext)),
      new Uint8Array(cipher.final())
    )
    const tag = new Uint8Array(cipher.getAuthTag())

    this.seq += 1
    this.blockCount += blocks

    return concatBytes(seqBytes, ciphertext, tag)
  }
}

/**
 * Opens envelope frames for one direction, enforcing the strict monotonic
 * sequence check: `seq` must equal the expected counter exactly, with no
 * window. Any gap, repeat, dirTag/key mismatch, or GCM authentication
 * failure throws `EnvelopeViolationError`, which the caller MUST treat as an
 * immediate connection close (§10, §11).
 *
 * Also enforces the same §10 usage bounds as `EnvelopeSealer`: this
 * direction MUST reconnect with fresh keys before it has opened
 * `MAX_ENVELOPE_FRAMES` frames or `MAX_ENVELOPE_BLOCKS` encrypted blocks,
 * regardless of which side is sending — the advantage bound the limits exist
 * to protect grows with frames processed under a key, not with frames a
 * single side chose to seal. Exceeding either throws `EnvelopeLimitError`.
 *
 * With the strict sequence check above, this direction's counters advance in
 * lockstep with frames the peer actually sent, so a compliant peer's own
 * `seal` would already have refused to transmit whatever frame would push
 * this bound past its limit. This check is therefore a receive-side
 * backstop against a peer that does not enforce that bound on itself — the
 * same defense-in-depth rationale that already justifies enforcing the
 * 1 MiB frame cap on receive rather than trusting the sender alone.
 *
 * `startSeq`/`startBlockCount` (both default 0, the real starting point for
 * a fresh connection — there is no in-place rekey in v1, so production code
 * never passes non-default values) are the same kind of resume seam as
 * `EnvelopeSealer`'s constructor arguments — ordinary constructor arguments,
 * not a production-only setter, so the usage bounds are reachable and
 * verifiable from a test.
 */
export class EnvelopeOpener {
  private readonly key: Uint8Array
  private readonly dir: EnvelopeDirection
  private seq: number
  private blockCount: number

  constructor(
    key: Uint8Array,
    dir: EnvelopeDirection,
    startSeq = 0,
    startBlockCount = 0
  ) {
    this.key = key
    this.dir = dir
    this.seq = startSeq
    this.blockCount = startBlockCount
  }

  open(frame: Uint8Array): Uint8Array {
    if (frame.length < SEQ_LENGTH + TAG_LENGTH) {
      throw new EnvelopeViolationError(
        `envelope frame of ${frame.length} bytes is shorter than the seq+tag minimum`
      )
    }
    // §10 states the 1 MiB cap as a property of a FRAME, not of the sender, so
    // it binds this direction too. Checked here rather than after decryption:
    // GCM ciphertext and plaintext are the same length, so the bound is known
    // up front, and refusing early is what actually protects us — an
    // authenticated peer holding the traffic key could otherwise make us
    // allocate and decrypt an arbitrarily large frame before anyone objects.
    if (frame.length - SEQ_LENGTH - TAG_LENGTH > MAX_ENVELOPE_PLAINTEXT_BYTES) {
      throw new EnvelopeViolationError(
        'envelope frame carries more than the 1 MiB plaintext limit'
      )
    }
    // §10 frame-count usage bound. Unlike the block bound below, this reads
    // only our own counter — nothing from `frame` — so there is no
    // "unauthenticated data" concern in checking it this early: once this
    // direction has opened MAX_ENVELOPE_FRAMES frames, no further frame is
    // admissible no matter what it contains, exactly mirroring where
    // `EnvelopeSealer.seal` checks it, before doing any work.
    assertFrameBoundNotReached(this.seq, 'inbound')

    const seqBytes = frame.subarray(0, SEQ_LENGTH)
    if (os2ip(seqBytes) !== BigInt(this.seq)) {
      throw new EnvelopeViolationError(
        `envelope sequence mismatch: expected ${this.seq}`
      )
    }

    const ciphertext = frame.subarray(SEQ_LENGTH, frame.length - TAG_LENGTH)
    const tag = frame.subarray(frame.length - TAG_LENGTH)

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      buildNonce(this.dir, seqBytes)
    )
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)

    let plaintext: Uint8Array
    try {
      plaintext = concatBytes(
        new Uint8Array(decipher.update(ciphertext)),
        new Uint8Array(decipher.final())
      )
    } catch {
      throw new EnvelopeViolationError('envelope GCM authentication failed')
    }

    // §10 block-count usage bound, counted from the AUTHENTICATED plaintext
    // rather than the frame's declared length, and checked only now that GCM
    // has verified this frame. AES-GCM ciphertext and plaintext are the same
    // length, so the two lengths agree for every frame that reaches this
    // line — they diverge only for a frame that fails authentication, and
    // that frame already threw above without ever reaching here. Checking
    // pre-decryption on the declared length instead would let an
    // unauthenticated, possibly forged frame dictate whether this direction
    // is told to reconnect, which is the same mistake as letting it move
    // `blockCount` at all.
    const blocks = blockCountFor(plaintext.length)
    assertBlockBoundNotReached(this.blockCount, blocks, 'inbound')

    this.seq += 1
    this.blockCount += blocks
    return plaintext
  }
}
