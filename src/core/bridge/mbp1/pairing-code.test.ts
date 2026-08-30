import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadMbp1Vectors } from './__tests__/vectors'
import { ProtocolViolationError } from './canonical'
import {
  CROCKFORD_ALPHABET,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from './pairing-code'

const v = loadMbp1Vectors()

describe('pairing code format (§7.1)', () => {
  it('has the 32-symbol Crockford alphabet excluding I, L, O, U', () => {
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
    expect(CROCKFORD_ALPHABET.length).toBe(32)
  })

  it('generates all-zero bits as the first symbol repeated 8 times', () => {
    expect(generatePairingCode(new Uint8Array(5))).toBe('00000000')
  })

  it('generates all-one bits as the last symbol repeated 8 times', () => {
    expect(
      generatePairingCode(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))
    ).toBe('ZZZZZZZZ')
  })

  it('splits 40 bits into eight big-endian 5-bit groups', () => {
    expect(
      generatePairingCode(new Uint8Array([0b00001000, 0b01000010, 0, 0, 0]))
    ).toBe('11100000')
  })

  it('rejects a shorter-than-5-byte input', () => {
    expect(() => generatePairingCode(new Uint8Array(4))).toThrow(
      ProtocolViolationError
    )
  })

  it('rejects a longer-than-5-byte input', () => {
    expect(() => generatePairingCode(new Uint8Array(6))).toThrow(
      ProtocolViolationError
    )
  })

  it('formats a code with a hyphen after the 4th symbol', () => {
    expect(formatPairingCode('MTX7K2Q9')).toBe('MTX7-K2Q9')
  })

  it('normalizes by stripping hyphens/spaces and uppercasing', () => {
    expect(normalizePairingCode('mtx7-k2q9 ')).toBe('MTX7K2Q9')
  })

  it('remaps O, I, L in both cases (O→0, I→1, L→1)', () => {
    // 'iI-oO-lL7K' -> strip '-' -> 'iIoOlL7K' -> upper -> 'IIOOLL7K'
    // -> O:0, I:1, L:1 -> '1100117K' (independently hand-verified against
    // §7.1, not derived from the code under test)
    expect(normalizePairingCode('iI-oO-lL7K')).toBe('1100117K')
  })

  it('matches the spake2[0] vector linkage', () => {
    expect(normalizePairingCode(v.spake2[0].inputs.codeDisplayed)).toBe(
      v.spake2[0].inputs.codeNormalized
    )
  })

  it('rejects a symbol outside the Crockford alphabet', () => {
    expect(normalizePairingCode('MTXU-K2Q9')).toBeNull()
  })

  it('rejects fewer than 8 symbols', () => {
    expect(normalizePairingCode('MTX7K2Q')).toBeNull()
  })

  it('rejects more than 8 symbols after normalization', () => {
    expect(normalizePairingCode('MTX7-K2Q99')).toBeNull()
  })

  it('round-trips generate -> format -> normalize', () => {
    const code = generatePairingCode(randomBytes(5))
    expect(normalizePairingCode(formatPairingCode(code))).toBe(code)
  })
})
