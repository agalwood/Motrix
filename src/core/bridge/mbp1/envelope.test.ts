import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import {
  DIR_C2S,
  DIR_S2C,
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
