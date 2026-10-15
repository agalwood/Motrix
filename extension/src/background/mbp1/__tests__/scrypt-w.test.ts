import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { deriveW } from '@/background/mbp1/scrypt-w'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('deriveW (§6.2 pairing code -> scalar w)', () => {
  it('derives w from code + nonce (scryptW vector)', () => {
    const { inputs, expected } = MBP1_VECTORS.scryptW
    const w = deriveW(inputs.codeNormalized, inputs.pairNonce)
    expect(hex(w)).toBe(expected.w)
  })

  it('derives w matching the first spake2 vector intermediate.w', () => {
    // Cross-check against a second, independently-recorded vector field for
    // the same underlying derivation (different vector object entirely).
    const v = MBP1_VECTORS.spake2[0]
    if (
      !v?.inputs?.codeNormalized ||
      !v.inputs.pairNonce ||
      !v.intermediate?.w
    ) {
      throw new Error('vector missing fields')
    }
    const w = deriveW(v.inputs.codeNormalized, v.inputs.pairNonce)
    expect(hex(w)).toBe(v.intermediate.w)
  })

  it('returns a 32-byte big-endian scalar', () => {
    const { inputs } = MBP1_VECTORS.scryptW
    const w = deriveW(inputs.codeNormalized, inputs.pairNonce)
    expect(w).toBeInstanceOf(Uint8Array)
    expect(w.length).toBe(32)
  })

  it('is session-unique: a different pairNonce yields a different w', () => {
    const { inputs } = MBP1_VECTORS.scryptW
    const w1 = deriveW(inputs.codeNormalized, inputs.pairNonce)
    const w2 = deriveW(inputs.codeNormalized, `${inputs.pairNonce}-x`)
    expect(hex(w1)).not.toBe(hex(w2))
  })

  it('refuses non-ASCII rather than deriving a w the server cannot match', () => {
    // The server encodes these with `Buffer.from(s, 'ascii')`, which truncates
    // each character to its low byte; this side uses UTF-8. So a non-ASCII
    // input does not merely look odd — it derives a *different* `w` on each
    // side, and the only symptom is key confirmation failing against a real
    // Motrix. Refusing is the only behaviour that cannot silently diverge.
    const { inputs } = MBP1_VECTORS.scryptW
    expect(() => deriveW('MTX7K2Q9', 'nonce-é')).toThrow(/pairNonce/)
    expect(() => deriveW('MTX7K2Qé', inputs.pairNonce)).toThrow(
      /codeNormalized/
    )
    // A pure-ASCII pair still works, so the guard is not rejecting everything.
    expect(() => deriveW(inputs.codeNormalized, inputs.pairNonce)).not.toThrow()
  })
})
