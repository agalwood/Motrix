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

/** A direction has reached its 2^24-frame or 2^30-block usage bound and MUST reconnect (§10). */
export class EnvelopeLimitError extends Error {}

const AAD = utf8ToBytes('MBP1/env/v1')
const SEQ_LENGTH = 8
const TAG_LENGTH = 16
const BLOCK_SIZE = 16
const MAX_PLAINTEXT_LENGTH = 1024 * 1024 // 1 MiB (§10)
const MAX_FRAMES = 2 ** 24 // §10
const MAX_BLOCKS = 2 ** 30 // §10 (16 GiB of plaintext)

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
 * `seq` starts at `startSeq` (default 0) and increments by exactly 1 per
 * frame; `blockCount` starts at `startBlockCount` (default 0) and
 * accumulates `ceil(plaintextLength / 16)` per frame. Both default to the
 * real production starting point (a fresh connection always starts a
 * direction at 0), and both exist as constructor parameters — not
 * production-only setters — so the 2^24-frame and 2^30-block usage bounds
 * are reachable from a test without a debug back door.
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

  /** `frame = seq64BE ‖ AES-256-GCM(key, nonce, plaintext, aad)` (§10). */
  seal(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_PLAINTEXT_LENGTH) {
      throw new EnvelopeViolationError(
        `envelope plaintext of ${plaintext.length} bytes exceeds the 1 MiB frame limit`
      )
    }
    if (this.seq >= MAX_FRAMES) {
      throw new EnvelopeLimitError(
        'envelope frame-count usage bound reached (2^24 frames); reconnect required'
      )
    }
    const blocks = blockCountFor(plaintext.length)
    if (this.blockCount + blocks > MAX_BLOCKS) {
      throw new EnvelopeLimitError(
        'envelope encrypted-block usage bound reached (2^30 blocks); reconnect required'
      )
    }

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
 */
export class EnvelopeOpener {
  private readonly key: Uint8Array
  private readonly dir: EnvelopeDirection
  private seq: number

  constructor(key: Uint8Array, dir: EnvelopeDirection, startSeq = 0) {
    this.key = key
    this.dir = dir
    this.seq = startSeq
  }

  open(frame: Uint8Array): Uint8Array {
    if (frame.length < SEQ_LENGTH + TAG_LENGTH) {
      throw new EnvelopeViolationError(
        `envelope frame of ${frame.length} bytes is shorter than the seq+tag minimum`
      )
    }

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

    this.seq += 1
    return plaintext
  }
}
