import { createCipheriv } from 'node:crypto'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import { concatBytes, encU32BE, encU64BE } from './canonical'
import {
  DIR_C2S,
  DIR_S2C,
  type EnvelopeDirection,
  EnvelopeLimitError,
  EnvelopeOpener,
  EnvelopeSealer,
  EnvelopeViolationError,
} from './envelope'

const v = loadMbp1Vectors()
const { inputs, expected } = v.envelope

const keyC2S = hexToBytes(inputs.keyC2S)
const keyS2C = hexToBytes(inputs.keyS2C)
const plaintext0 = hexToBytes(inputs.plaintext0)
const plaintext1 = hexToBytes(inputs.plaintext1)

// Reimplements the wire format `seq64BE ‖ AES-256-GCM(...)` outside of
// `EnvelopeSealer.seal`, whose own §10 bound checks refuse to produce a
// frame at or past MAX_ENVELOPE_FRAMES / MAX_ENVELOPE_BLOCKS. A compliant
// sealer can never hand back such a frame, so the only way to prove
// `EnvelopeOpener.open` enforces its OWN bound — independently of whether
// the sender complied — is to seal one by hand. This is exactly the "peer
// implementation that simply never reconnects" scenario §10's bound exists
// to guard against.
const ENVELOPE_AAD = utf8ToBytes('MBP1/env/v1')

function sealRawFrame(
  key: Uint8Array,
  dir: EnvelopeDirection,
  seq: number,
  plaintext: Uint8Array
): Uint8Array {
  const seqBytes = encU64BE(seq)
  const cipher = createCipheriv(
    'aes-256-gcm',
    key,
    concatBytes(encU32BE(dir), seqBytes)
  )
  cipher.setAAD(ENVELOPE_AAD)
  const ciphertext = concatBytes(
    new Uint8Array(cipher.update(plaintext)),
    new Uint8Array(cipher.final())
  )
  const tag = new Uint8Array(cipher.getAuthTag())
  return concatBytes(seqBytes, ciphertext, tag)
}

describe('EnvelopeSealer (§10)', () => {
  it('reproduces frameC2S_seq0 then frameC2S_seq1 from successive seals', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    const f0 = sealer.seal(plaintext0)
    const f1 = sealer.seal(plaintext1)
    expect(bytesToHex(f0)).toBe(expected.frameC2S_seq0)
    expect(bytesToHex(f1)).toBe(expected.frameC2S_seq1)
  })

  it('reproduces frameS2C_seq0', () => {
    const sealer = new EnvelopeSealer(keyS2C, DIR_S2C)
    const f0 = sealer.seal(plaintext1)
    expect(bytesToHex(f0)).toBe(expected.frameS2C_seq0)
  })
})

describe('EnvelopeOpener (§10)', () => {
  it('round-trips frameC2S_seq0 then frameC2S_seq1 in order', () => {
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S)
    const p0 = opener.open(hexToBytes(expected.frameC2S_seq0))
    const p1 = opener.open(hexToBytes(expected.frameC2S_seq1))
    expect(bytesToHex(p0)).toBe(bytesToHex(plaintext0))
    expect(bytesToHex(p1)).toBe(bytesToHex(plaintext1))
  })

  it('round-trips frameS2C_seq0', () => {
    const opener = new EnvelopeOpener(keyS2C, DIR_S2C)
    const p0 = opener.open(hexToBytes(expected.frameS2C_seq0))
    expect(bytesToHex(p0)).toBe(bytesToHex(plaintext1))
  })
})

describe('EnvelopeOpener mustReject (§10)', () => {
  it('rejects frameC2S_seq0 with its last ciphertext byte flipped (gcm auth failure)', () => {
    const tampered = hexToBytes(expected.frameC2S_seq0)
    tampered[tampered.length - 1] ^= 0x01
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S)
    expect(() => opener.open(tampered)).toThrow(EnvelopeViolationError)
  })

  it('rejects frameC2S_seq0 opened with the same key but DIR_S2C (dirTag-only mismatch)', () => {
    const opener = new EnvelopeOpener(keyC2S, DIR_S2C)
    expect(() => opener.open(hexToBytes(expected.frameC2S_seq0))).toThrow(
      EnvelopeViolationError
    )
  })

  it('rejects frameC2S_seq0 opened with the s2c key', () => {
    const opener = new EnvelopeOpener(keyS2C, DIR_C2S)
    expect(() => opener.open(hexToBytes(expected.frameC2S_seq0))).toThrow(
      EnvelopeViolationError
    )
  })

  it('rejects frameC2S_seq1 presented when the expected seq is 0 (strict sequence check)', () => {
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S)
    expect(() => opener.open(hexToBytes(expected.frameC2S_seq1))).toThrow(
      EnvelopeViolationError
    )
  })

  it('rejects a frame carrying more than the 1 MiB plaintext limit', () => {
    // §10 caps the plaintext of a FRAME, not just of what we send. The receive
    // side is the direction that protects us: an authenticated peer holding the
    // traffic key could otherwise make us allocate and decrypt an arbitrarily
    // large frame. Refused on length alone, before any crypto runs, so the
    // frame need not be a genuinely sealed one.
    //
    // The message is asserted, not just the class: an unsealed oversized frame
    // ALSO fails GCM, so a bare `toThrow(EnvelopeViolationError)` would pass
    // just as happily with no length check at all. Only the reason separates
    // the control being tested from the one behind it.
    const oversized = new Uint8Array(8 + 16 + 1024 * 1024 + 1)
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S)
    expect(() => opener.open(oversized)).toThrow(/1 MiB plaintext limit/)
  })

  it('admits a frame whose plaintext is exactly at the 1 MiB limit', () => {
    // The boundary, sealed for real, so the cap cannot be off by one against a
    // frame a conforming peer is allowed to send.
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    const atLimit = sealer.seal(new Uint8Array(1024 * 1024))
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S)
    expect(opener.open(atLimit)).toHaveLength(1024 * 1024)
  })
})

describe('EnvelopeSealer usage bounds and size cap (§10)', () => {
  it('throws EnvelopeLimitError once the 2^24 frame-count bound is reached', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 2 ** 24)
    expect(() => sealer.seal(new Uint8Array([1]))).toThrow(EnvelopeLimitError)
  })

  it('does not throw one frame below the 2^24 frame-count bound', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 2 ** 24 - 1)
    expect(() => sealer.seal(new Uint8Array([1]))).not.toThrow()
  })

  it('throws EnvelopeLimitError once the 2^30 encrypted-block bound is reached', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 0, 2 ** 30)
    expect(() => sealer.seal(new Uint8Array([1]))).toThrow(EnvelopeLimitError)
  })

  it('does not throw one block below the 2^30 encrypted-block bound', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 0, 2 ** 30 - 1)
    expect(() => sealer.seal(new Uint8Array([1]))).not.toThrow()
  })

  it('throws EnvelopeViolationError for plaintext over the 1 MiB frame limit', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    const oversized = new Uint8Array(1024 * 1024 + 1)
    expect(() => sealer.seal(oversized)).toThrow(EnvelopeViolationError)
  })

  it('accepts plaintext exactly at the 1 MiB frame limit', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    const atLimit = new Uint8Array(1024 * 1024)
    expect(() => sealer.seal(atLimit)).not.toThrow()
  })
})

describe('EnvelopeOpener usage bounds (§10)', () => {
  it('throws EnvelopeLimitError once the 2^24 frame-count bound is reached', () => {
    // The frame-count check reads only the opener's own counter, never the
    // frame, so it fires before the frame is parsed at all — an arbitrary
    // length-valid buffer exercises it without needing real encryption.
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 2 ** 24)
    const arbitraryValidLengthFrame = new Uint8Array(8 + 16)
    expect(() => opener.open(arbitraryValidLengthFrame)).toThrow(
      EnvelopeLimitError
    )
  })

  it('does not throw one frame below the 2^24 frame-count bound', () => {
    // Below the bound, a genuinely sealed frame must still round-trip: the
    // guard must not fire early against a compliant sender.
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 2 ** 24 - 1)
    const frame = sealer.seal(new Uint8Array([1]))
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 2 ** 24 - 1)
    expect(() => opener.open(frame)).not.toThrow()
  })

  it('throws EnvelopeLimitError once the 2^30 encrypted-block bound is reached', () => {
    // A compliant EnvelopeSealer would refuse to produce this frame (its own
    // block bound matches), so it is sealed by hand: this is the "peer never
    // reconnects" scenario, not a compliant sender's last legal frame.
    const frame = sealRawFrame(keyC2S, DIR_C2S, 0, new Uint8Array([1]))
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 0, 2 ** 30)
    expect(() => opener.open(frame)).toThrow(EnvelopeLimitError)
  })

  it('does not throw one block below the 2^30 encrypted-block bound', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 0, 2 ** 30 - 1)
    const frame = sealer.seal(new Uint8Array([1]))
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 0, 2 ** 30 - 1)
    expect(() => opener.open(frame)).not.toThrow()
  })

  it('rejects a tampered frame at the block bound with a GCM failure, not a limit error', () => {
    // Proves the block-count check runs on the AUTHENTICATED plaintext, not
    // the frame's declared length: if it ran on the declared length before
    // decryption, this tampered frame's length alone would already trip
    // EnvelopeLimitError, silently hiding that the frame was never actually
    // authentic.
    const frame = sealRawFrame(keyC2S, DIR_C2S, 0, new Uint8Array([1]))
    frame[frame.length - 1] ^= 0x01 // flip the last tag byte -> GCM auth fails
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 0, 2 ** 30)
    expect(() => opener.open(frame)).toThrow(EnvelopeViolationError)
  })

  it('does not advance seq after the block bound throws, so re-presenting the same frame keeps failing the same way', () => {
    // If `seq` (or `blockCount`) had advanced despite the throw, presenting
    // the identical frame again would report a sequence mismatch instead of
    // the same limit error — proving the rejected frame was never admitted.
    const frame = sealRawFrame(keyC2S, DIR_C2S, 5, new Uint8Array([1]))
    const opener = new EnvelopeOpener(keyC2S, DIR_C2S, 5, 2 ** 30)
    expect(() => opener.open(frame)).toThrow(EnvelopeLimitError)
    expect(() => opener.open(frame)).toThrow(EnvelopeLimitError)
  })
})

describe('EnvelopeSealer proactive-reconnect counters (§10)', () => {
  it('starts sealedFrameCount and sealedBlockCount at the constructor seams', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S, 7, 42)
    expect(sealer.sealedFrameCount).toBe(7)
    expect(sealer.sealedBlockCount).toBe(42)
  })

  it('advances sealedFrameCount by exactly 1 per seal', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    sealer.seal(new Uint8Array(1))
    expect(sealer.sealedFrameCount).toBe(1)
    sealer.seal(new Uint8Array(1))
    expect(sealer.sealedFrameCount).toBe(2)
  })

  it('advances sealedBlockCount by ceil(plaintextLength / 16) per seal', () => {
    const sealer = new EnvelopeSealer(keyC2S, DIR_C2S)
    expect(sealer.sealedBlockCount).toBe(0)
    sealer.seal(new Uint8Array(16)) // ceil(16/16) = 1 block
    expect(sealer.sealedBlockCount).toBe(1)
    sealer.seal(new Uint8Array(17)) // ceil(17/16) = 2 blocks
    expect(sealer.sealedBlockCount).toBe(3)
    sealer.seal(new Uint8Array(0)) // ceil(0/16) = 0 blocks
    expect(sealer.sealedBlockCount).toBe(3)
  })
})
