import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import {
  concatBytes,
  enc,
  encU32BE,
  encU64BE,
  fromBase64Url,
  len64LE,
  ProtocolViolationError,
  toBase64Url,
} from './canonical'

const v = loadMbp1Vectors()

describe('canonical encoding (§2)', () => {
  it('reproduces A_id from the spake2 vector', () => {
    // A_id = enc("MBP1/A/v1") ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(claimedExtensionId) ‖ enc(clientInstallationId)  (§6.4)
    const i = v.spake2[0].inputs
    const aId = concatBytes(
      enc('MBP1/A/v1'),
      enc(i.browser),
      enc(i.verifiedOrigin),
      enc(i.claimedExtensionId),
      enc(i.clientInstallationId)
    )
    expect(bytesToHex(aId)).toBe(v.spake2[0].intermediate.aId)
  })
  it('reproduces B_id', () => {
    const i = v.spake2[0].inputs
    const bId = concatBytes(
      enc('MBP1/B/v1'),
      enc('motrix-bridge'),
      enc(i.instanceId)
    )
    expect(bytesToHex(bId)).toBe(v.spake2[0].intermediate.bId)
  })
  it('len64LE / U32BE / U64BE are byte-exact', () => {
    expect(bytesToHex(len64LE(9))).toBe('0900000000000000')
    expect(bytesToHex(encU32BE(1))).toBe('00000001')
    expect(bytesToHex(encU64BE(1755600000))).toBe('0000000068a45480') // nmTicket exp inside expected.canonical
  })
  it('base64url is strict', () => {
    expect(
      toBase64Url(
        hexToBytes(
          'fd64b13bcbdd3fcaaac3953f6212c769495003162d404066e119f5fcc1551173'
        )
      )
    ).not.toContain('=')
    expect(() => fromBase64Url('AAA=')).toThrow() // padded
    expect(() => fromBase64Url('A+/A')).toThrow() // wrong alphabet
    expect(() => fromBase64Url('AB')).toThrow() // non-canonical trailing bits ('AB' decodes with leftover bits set)
    expect(fromBase64Url(toBase64Url(new Uint8Array([0, 255, 7])))).toEqual(
      new Uint8Array([0, 255, 7])
    )
  })
  it('enc rejects non-ASCII strings', () => {
    expect(() => enc('mötrix')).toThrow()
  })
  it('len64LE rejects out-of-range or non-integer input', () => {
    expect(() => len64LE(-1)).toThrow(ProtocolViolationError)
    expect(() => len64LE(-1n)).toThrow(ProtocolViolationError)
    expect(() => len64LE(2 ** 64)).toThrow(ProtocolViolationError)
    expect(() => len64LE(2n ** 64n)).toThrow(ProtocolViolationError)
    expect(() => len64LE(1.5)).toThrow(ProtocolViolationError)
  })
  it('encU32BE rejects out-of-range or non-integer input', () => {
    expect(() => encU32BE(-1)).toThrow(ProtocolViolationError)
    expect(() => encU32BE(2 ** 32)).toThrow(ProtocolViolationError)
    expect(() => encU32BE(1.5)).toThrow(ProtocolViolationError)
  })
  it('encU64BE rejects out-of-range or non-integer input', () => {
    expect(() => encU64BE(-1)).toThrow(ProtocolViolationError)
    expect(() => encU64BE(-1n)).toThrow(ProtocolViolationError)
    expect(() => encU64BE(2 ** 64)).toThrow(ProtocolViolationError)
    expect(() => encU64BE(2n ** 64n)).toThrow(ProtocolViolationError)
    expect(() => encU64BE(1.5)).toThrow(ProtocolViolationError)
  })
})
