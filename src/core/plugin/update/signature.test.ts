import { keypair } from '@test-utils/moext'
import { describe, expect, it } from 'vitest'
import { verifyBuiltinSignature } from './signature'

describe('verifyBuiltinSignature', () => {
  const bytes = Buffer.from('moext-bytes')

  it('accepts a signature from a pinned key', () => {
    const k = keypair()
    expect(verifyBuiltinSignature(bytes, k.sign(bytes), [k.pem])).toBe(true)
  })

  it('accepts when ANY key in the array verifies (rotation)', () => {
    const old = keypair()
    const next = keypair()
    expect(
      verifyBuiltinSignature(bytes, next.sign(bytes), [old.pem, next.pem])
    ).toBe(true)
  })

  it('rejects tampered bytes, wrong keys, and garbage signatures', () => {
    const k = keypair()
    const other = keypair()
    const sig = k.sign(bytes)
    expect(verifyBuiltinSignature(Buffer.from('tampered'), sig, [k.pem])).toBe(
      false
    )
    expect(verifyBuiltinSignature(bytes, sig, [other.pem])).toBe(false)
    expect(verifyBuiltinSignature(bytes, '!!!not-base64!!!', [k.pem])).toBe(
      false
    )
    expect(verifyBuiltinSignature(bytes, sig, [])).toBe(false)
  })
})
