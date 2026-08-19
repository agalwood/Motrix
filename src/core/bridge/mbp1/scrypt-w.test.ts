import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { loadMbp1Vectors } from './__tests__/vectors'
import { deriveW } from './scrypt-w'

const ORDER = ed25519.Point.Fn.ORDER
const v = loadMbp1Vectors()

describe('w derivation (§6.2)', () => {
  it('matches scryptW.expected.w', () => {
    const w = deriveW(
      v.scryptW.inputs.codeNormalized,
      v.scryptW.inputs.pairNonce,
      ORDER
    )
    expect(w.toString(16).padStart(64, '0')).toBe(v.scryptW.expected.w)
  })
})
