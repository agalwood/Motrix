import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import {
  b64uDecode,
  b64uEncode,
  concatBytes,
  enc,
  encU32BE,
  encU64BE,
  len64LE,
  timingSafeEqualBytes,
  utf8,
} from '@/background/mbp1/canonical'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

describe('len64LE / enc / encU32BE / encU64BE', () => {
  it('enc(string) prefixes an 8-byte LE length (matches aId prefix)', () => {
    // "MBP1/A/v1" is 9 bytes -> 09 00 00 00 00 00 00 00 + ascii
    expect(hex(enc('MBP1/A/v1'))).toBe('09000000000000004d4250312f412f7631')
  })

  it('len64LE encodes the length as little-endian, independent of enc()', () => {
    expect(hex(len64LE(9))).toBe('0900000000000000')
    expect(hex(len64LE(0))).toBe('0000000000000000')
    expect(hex(len64LE(256))).toBe('0001000000000000')
  })

  it('encU64BE matches the ticket exp encoding', () => {
    // exp 1755600000 -> 00000000 68a45480 (from nmTicket.canonical tail)
    expect(hex(encU64BE(1755600000))).toBe('0000000068a45480')
  })

  it('encU32BE matches the ticket v/protocolVersion encoding', () => {
    expect(hex(encU32BE(1))).toBe('00000001')
    expect(hex(encU32BE(0))).toBe('00000000')
  })

  it('encU64BE throws rather than wraps on out-of-range input', () => {
    // The bug this guards against: DataView.setBigUint64 wraps modulo 2**64,
    // so encU64BE(0) and encU64BE(2**64) would otherwise emit identical
    // bytes -- exactly the collision §6.4 rules out (flipping `exp` MUST
    // change the ticket digest).
    expect(() => encU64BE(2 ** 64)).toThrow()
    expect(() => encU64BE(-1)).toThrow()
    expect(hex(encU64BE(0))).not.toBe(hex(encU64BE(1)))
  })

  it('encU32BE throws on out-of-range input rather than wrapping', () => {
    expect(() => encU32BE(2 ** 32)).toThrow()
    expect(() => encU32BE(-1)).toThrow()
  })

  it('len64LE throws on out-of-range input rather than wrapping', () => {
    expect(() => len64LE(-1)).toThrow()
    expect(() => len64LE(1.5)).toThrow()
  })

  it('enc rejects non-ASCII strings', () => {
    expect(() => enc('café')).toThrow()
  })

  it('enc accepts raw bytes without the ASCII check (point/scalar fields)', () => {
    const raw = new Uint8Array([0xff, 0x00, 0x80])
    expect(hex(enc(raw))).toBe(`${hex(len64LE(3))}${hex(raw)}`)
  })

  it('utf8 encodes ASCII strings byte-identically', () => {
    expect(hex(utf8('chromium'))).toBe(
      Buffer.from('chromium', 'utf8').toString('hex')
    )
  })

  it('concatBytes joins parts in order without mutating inputs', () => {
    const a = new Uint8Array([1, 2])
    const b = new Uint8Array([3])
    const joined = concatBytes(a, b, new Uint8Array())
    expect(Array.from(joined)).toEqual([1, 2, 3])
    expect(Array.from(a)).toEqual([1, 2])
  })
})

describe('composition against real vector hex (spec §2 + §6.4)', () => {
  it('reconstructs spake2[0].intermediate.aId from its constituent fields', () => {
    const v = MBP1_VECTORS.spake2[0]
    if (!v?.inputs || !v.intermediate) throw new Error('vector missing fields')
    const aId = concatBytes(
      enc('MBP1/A/v1'),
      enc(v.inputs.browser ?? ''),
      enc(v.inputs.verifiedOrigin ?? ''),
      enc(v.inputs.claimedExtensionId ?? ''),
      enc(v.inputs.clientInstallationId ?? '')
    )
    expect(hex(aId)).toBe(v.intermediate.aId)
  })

  it('reconstructs spake2[0].intermediate.bId from its constituent fields', () => {
    const v = MBP1_VECTORS.spake2[0]
    if (!v?.inputs || !v.intermediate) throw new Error('vector missing fields')
    const bId = concatBytes(
      enc('MBP1/B/v1'),
      enc('motrix-bridge'),
      enc(v.inputs.instanceId ?? '')
    )
    expect(hex(bId)).toBe(v.intermediate.bId)
  })

  it('reconstructs nmTicket.expected.canonical (the ticket MAC input, §9.2)', () => {
    const { inputs, expected } = MBP1_VECTORS.nmTicket
    const v = inputs.v
    const bindingPub = inputs.bindingPub
    const serverGeneration = inputs.serverGeneration
    const browser = inputs.browser
    const callerId = inputs.callerId
    const exp = inputs.exp
    if (
      typeof v !== 'number' ||
      typeof bindingPub !== 'string' ||
      typeof serverGeneration !== 'string' ||
      typeof browser !== 'string' ||
      typeof callerId !== 'string' ||
      typeof exp !== 'number'
    ) {
      throw new Error('vector missing fields')
    }
    const canonical = concatBytes(
      enc('mbp1-attestation'),
      encU32BE(v),
      encU32BE(1), // ticketProtocolVersion, fixed at 1 for MBP1 v1 (§9.2)
      enc(serverGeneration),
      enc(browser),
      enc(callerId),
      encU64BE(exp),
      enc(fromHex(bindingPub))
    )
    expect(hex(canonical)).toBe(expected.canonical)
  })
})

describe('base64url codec (RFC 4648 §5, no padding)', () => {
  it('round-trips', () => {
    const b = new Uint8Array([0xfb, 0xff, 0x00])
    expect(b64uDecode(b64uEncode(b))).toEqual(b)
  })

  it('rejects standard-base64 characters that are not in the url alphabet', () => {
    // `+` and `/` are standard base64, not base64url, and not padding. The
    // assertion this replaces used `'++/='` and was the *only* one claiming to
    // cover padding — it threw on the `+` at index 0 and never reached the `=`.
    expect(() => b64uDecode('++++')).toThrow()
    expect(() => b64uDecode('////')).toThrow()
  })

  it('rejects padding, which §2 requires decoders to refuse', () => {
    // `=` is absent from the alphabet, so today this throws on the character.
    // The point of asserting it is that nothing else does: skipping `=` in the
    // decode loop would leave every other test in this file green while
    // `b64uDecode` silently accepted padded input, and the non-canonical
    // trailing-bits check would not catch it either — the buffer is 0.
    expect(() => b64uDecode('AQ==')).toThrow()
    expect(() => b64uDecode('AQI=')).toThrow()
  })

  it('round-trips point-sized (32-byte) values, matching pA', () => {
    const v = MBP1_VECTORS.spake2[0]
    if (!v?.expected.pA) throw new Error('vector missing pA')
    const bytes = fromHex(v.expected.pA)
    expect(b64uDecode(b64uEncode(bytes))).toEqual(bytes)
  })

  it('rejects characters outside the base64url alphabet', () => {
    expect(() => b64uDecode('+abc')).toThrow()
    expect(() => b64uDecode('/abc')).toThrow()
    expect(() => b64uDecode('abc def')).toThrow()
  })

  it('rejects an impossible length (len % 4 === 1)', () => {
    expect(() => b64uDecode('a')).toThrow()
    expect(() => b64uDecode('abcde')).toThrow()
  })

  it('rejects non-canonical encodings with nonzero trailing bits', () => {
    // 'A'=0, 'Q'=16 in the base64url alphabet: (0<<6)|16 = 16, whose low 4
    // bits are zero, so 'AQ' is a canonical 1-byte encoding. 'A'=0, 'B'=1:
    // (0<<6)|1 = 1, whose low 4 bits are nonzero, so 'AB' is not.
    expect(() => b64uDecode('AQ')).not.toThrow()
    expect(() => b64uDecode('AB')).toThrow()
  })

  it('encodes with no padding characters ever emitted', () => {
    for (let n = 0; n <= 8; n++) {
      const encoded = b64uEncode(new Uint8Array(n).fill(0xab))
      expect(encoded.includes('=')).toBe(false)
    }
  })
})

describe('timingSafeEqualBytes', () => {
  it('returns true for identical byte strings', () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))
    ).toBe(true)
  })

  it('returns false for a single differing byte', () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))
    ).toBe(false)
  })

  it('returns false (never throws) on length mismatch', () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))
    ).toBe(false)
    expect(timingSafeEqualBytes(new Uint8Array(0), new Uint8Array(0))).toBe(
      true
    )
  })
})
