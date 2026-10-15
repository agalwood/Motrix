/**
 * MBP1 AEAD envelope (bridge-pairing-protocol.md §10).
 *
 * Active on `/pair` after §6.6 and on `/v1` after §8, in both directions, for
 * every frame. MDXP JSON-RPC payload bytes are the plaintext, unchanged.
 *
 * ```
 * frame  = seq64BE ‖ AES-256-GCM(key = k_dir, nonce, plaintext, aad)
 * nonce  = dirTag(4 bytes BE) ‖ seq64BE          (12 bytes)
 * dirTag = 0x00000001 (client→server) | 0x00000002 (server→client)
 * aad    = "MBP1/env/v1" (ASCII, 11 bytes)
 * ```
 *
 * `seq` starts at 0 per direction and increments by exactly 1 per frame. The
 * receiver requires strict equality with its expected counter — no window —
 * so replay protection *is* the strict sequence check: any gap, repeat, or
 * GCM authentication failure is an `EnvelopeViolation` and MUST close the
 * connection. The 1 MiB plaintext cap is enforced on both `seal` and `open`:
 * a peer that holds the key could otherwise force unbounded buffering on the
 * receive side by simply sending an oversized frame, so the cap has to be
 * checked before this module ever asks WebCrypto to authenticate it.
 *
 * This module uses WebCrypto (`crypto.subtle`) for AES-256-GCM — permitted by
 * §3 for symmetric primitives (curves must go through noble, never
 * WebCrypto) — so its interface is necessarily async, unlike a `node:crypto`
 * server-side implementation of the same envelope.
 *
 * `k_dir` (both direction keys) MUST NOT be logged at any level (§11), and
 * nothing here persists or caches key material beyond the imported
 * `CryptoKey` handles for the lifetime of one connection.
 */
import {
  concatBytes,
  encU32BE,
  encU64BE,
  utf8,
} from '@/background/mbp1/canonical'

export type Direction = 'c2s' | 's2c'

export type EnvelopeViolationReason =
  | 'malformedFrame'
  | 'oversizePlaintext'
  | 'sequenceMismatch'
  | 'gcmAuthFailure'
  | 'usageBoundExceeded'

/**
 * Thrown by `seal`/`open` on any protocol-level envelope failure (§10). Every
 * instance MUST close the connection — none of these reasons are recoverable
 * in place, and §10 provides no in-place rekey in v1.
 *
 * **Closing and blaming are separate decisions.** Which method threw, not just
 * `reason`, determines whether the peer is at fault:
 *
 * - From `open`, the frame came from the peer, so `malformedFrame`,
 *   `oversizePlaintext`, `sequenceMismatch`, and `gcmAuthFailure` are the
 *   peer's fault and are the §10 `envelopeViolation` closes.
 * - From `seal`, the input came from *this* side. `oversizePlaintext` on
 *   `seal` is a local caller handing us a frame over the 1 MiB cap — our bug,
 *   never the peer's — so it MUST NOT be reported to the peer as
 *   `envelopeViolation`.
 *
 * `usageBoundExceeded` is the exception, and it is **not** an
 * `envelopeViolation` in either direction. The agreed cross-implementation
 * contract is: both sides treat a usage-bound event as *close this connection
 * and re-establish via §8 with fresh keys*, and **neither side reports it to
 * the peer as a protocol violation.**
 *
 * - From `seal`: **we** exhausted our own outbound key. Nobody misbehaved.
 *   Reporting it to the peer would accuse them of a fault that is ours.
 * - From `open`: the **peer** kept sending past the point where §10 required it
 *   to close and reconnect, so it did fail a MUST — but the frame itself is
 *   well-formed and authentic (it passed the sequence check and GCM), §10 lists
 *   only gap, repeat, and GCM failure as `envelopeViolation`, and the remedy is
 *   the same reconnect either way. So: reconnect, don't accuse.
 *
 * The direction still changes what *happened*, which is why the message text
 * differs; it no longer changes what the caller should do.
 *
 * **For the caller that turns these into wire behavior.** The error's shape is
 * not what protects you here — the mapping layer is. Line A's server split this
 * into a distinct error class and *still* collapsed it at its wire layer, where
 * a fall-through closed with an internal-error code and a message reading like a
 * server bug. So: switch on `reason`, map `usageBoundExceeded` to a reconnect
 * rather than to a user-visible error state, and do not surface it as a failure.
 * Expect a well-behaved peer to close with a code meaning "reconnect" rather
 * than `1011`, but do not *depend* on the close code — our own outbound counter
 * reaching the bound is sufficient signal on its own.
 */
export class EnvelopeViolation extends Error {
  readonly reason: EnvelopeViolationReason

  constructor(reason: EnvelopeViolationReason, message: string) {
    super(message)
    this.name = 'EnvelopeViolation'
    this.reason = reason
  }
}

const DIR_TAG: Record<Direction, number> = { c2s: 0x00000001, s2c: 0x00000002 }
const AAD = utf8('MBP1/env/v1')
const SEQ_BYTES = 8
const GCM_TAG_BYTES = 16
const AES_BLOCK_BYTES = 16
const MAX_PLAINTEXT_BYTES = 1024 * 1024
/** §10: a direction MUST be closed and rekeyed before either bound is hit. */
const MAX_FRAMES_PER_DIRECTION = 2 ** 24
const MAX_BLOCKS_PER_DIRECTION = 2 ** 30

function blocksFor(plaintextByteLength: number): number {
  return Math.ceil(plaintextByteLength / AES_BLOCK_BYTES)
}

/** Plain equality on two fixed-width, non-secret sequence encodings. */
function sequenceBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * WebCrypto's `BufferSource` requires a concrete `ArrayBuffer` backing
 * store, but every byte value in this module — and in the `canonical.ts`
 * encoders it composes with — is typed as plain `Uint8Array` (which this
 * package's `Uint8Array<TArrayBuffer = ArrayBufferLike>` default leaves
 * unpinned). None of them are ever constructed over a `SharedArrayBuffer`,
 * so this narrows the type at the WebCrypto boundary without copying or
 * changing runtime behavior.
 */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>
}

async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    asBufferSource(rawKey),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * One side of one MBP1 secure-channel connection: seals its own outbound
 * direction and opens the peer's inbound direction, each with strict,
 * independently-tracked sequence counters and usage bounds. `role`
 * determines the direction mapping (§10): the client seals `c2s` and opens
 * `s2c`; the server seals `s2c` and opens `c2s`.
 */
export class EnvelopeCodec {
  private readonly outboundDirection: Direction
  private readonly inboundDirection: Direction
  private readonly outboundKey: CryptoKey
  private readonly inboundKey: CryptoKey
  private outboundSeq = 0
  private outboundBlocks = 0
  private inboundSeq = 0
  private inboundBlocks = 0

  private constructor(
    outboundDirection: Direction,
    inboundDirection: Direction,
    outboundKey: CryptoKey,
    inboundKey: CryptoKey
  ) {
    this.outboundDirection = outboundDirection
    this.inboundDirection = inboundDirection
    this.outboundKey = outboundKey
    this.inboundKey = inboundKey
  }

  static async create(
    keyC2S: Uint8Array,
    keyS2C: Uint8Array,
    role: 'client' | 'server'
  ): Promise<EnvelopeCodec> {
    const importedC2S = await importAesGcmKey(keyC2S)
    const importedS2C = await importAesGcmKey(keyS2C)
    return role === 'client'
      ? new EnvelopeCodec('c2s', 's2c', importedC2S, importedS2C)
      : new EnvelopeCodec('s2c', 'c2s', importedS2C, importedC2S)
  }

  /** Seals `plaintext` on this codec's outbound direction, then advances its seq. */
  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new EnvelopeViolation(
        'oversizePlaintext',
        `plaintext of ${plaintext.length} bytes exceeds the 1 MiB frame cap`
      )
    }
    const blocks = blocksFor(plaintext.length)
    if (
      this.outboundSeq >= MAX_FRAMES_PER_DIRECTION ||
      this.outboundBlocks + blocks > MAX_BLOCKS_PER_DIRECTION
    ) {
      throw new EnvelopeViolation(
        'usageBoundExceeded',
        'outbound direction reached its 2^24-frame / 2^30-block usage bound; rekey required'
      )
    }
    const seqBytes = encU64BE(this.outboundSeq)
    const nonce = concatBytes(
      encU32BE(DIR_TAG[this.outboundDirection]),
      seqBytes
    )
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(AAD),
          tagLength: 128,
        },
        this.outboundKey,
        asBufferSource(plaintext)
      )
    )
    this.outboundSeq += 1
    this.outboundBlocks += blocks
    return concatBytes(seqBytes, ciphertext)
  }

  /**
   * Opens `frame` on this codec's inbound direction. Requires `frame`'s
   * leading seq to equal the expected counter exactly (no window) before any
   * decryption is attempted, and rejects a plaintext over the 1 MiB cap from
   * the frame's declared length alone — before WebCrypto ever runs — so an
   * oversized frame cannot force this side to buffer or authenticate more
   * than the cap allows.
   */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < SEQ_BYTES + GCM_TAG_BYTES) {
      throw new EnvelopeViolation(
        'malformedFrame',
        `frame of ${frame.length} bytes is too short for a seq + GCM tag`
      )
    }
    const seqBytes = frame.slice(0, SEQ_BYTES)
    const ciphertext = frame.slice(SEQ_BYTES)
    const plaintextLength = ciphertext.length - GCM_TAG_BYTES
    if (plaintextLength > MAX_PLAINTEXT_BYTES) {
      throw new EnvelopeViolation(
        'oversizePlaintext',
        `frame declares a plaintext of ${plaintextLength} bytes, exceeding the 1 MiB frame cap`
      )
    }
    const expectedSeqBytes = encU64BE(this.inboundSeq)
    if (!sequenceBytesEqual(seqBytes, expectedSeqBytes)) {
      throw new EnvelopeViolation(
        'sequenceMismatch',
        'frame seq does not equal the expected inbound counter (gap or repeat)'
      )
    }
    const blocks = blocksFor(plaintextLength)
    if (
      this.inboundSeq >= MAX_FRAMES_PER_DIRECTION ||
      this.inboundBlocks + blocks > MAX_BLOCKS_PER_DIRECTION
    ) {
      throw new EnvelopeViolation(
        'usageBoundExceeded',
        'inbound direction reached its 2^24-frame / 2^30-block usage bound; rekey required'
      )
    }
    const nonce = concatBytes(
      encU32BE(DIR_TAG[this.inboundDirection]),
      seqBytes
    )
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(AAD),
          tagLength: 128,
        },
        this.inboundKey,
        asBufferSource(ciphertext)
      )
    } catch {
      throw new EnvelopeViolation(
        'gcmAuthFailure',
        'GCM authentication failed (tampered ciphertext, wrong key, or wrong dirTag)'
      )
    }
    this.inboundSeq += 1
    this.inboundBlocks += blocks
    return new Uint8Array(plaintext)
  }
}
