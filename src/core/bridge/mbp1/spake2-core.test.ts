import { p256 } from '@noble/curves/nist.js'
import { describe, expect, it } from 'vitest'
import rfc from './__tests__/fixtures/rfc9382-p256-vectors.json'
import { bytesToHex, hexToBytes, loadMbp1Vectors } from './__tests__/vectors'
import { os2ip, ProtocolViolationError } from './canonical'
import {
  buildTT,
  computePublicA,
  computePublicB,
  confirmationMacs,
  drawScalar,
  EDWARDS25519_GROUP,
  IdentityKError,
  keySchedule,
  pairTrafficKeys,
  type Spake2Group,
  sharedFromA,
  sharedFromB,
} from './spake2-core'

const ascii = (s: string) => new TextEncoder().encode(s)
const EMPTY = new Uint8Array(0)
const scalarBytes = (n: bigint) => hexToBytes(n.toString(16).padStart(64, '0'))

/**
 * P-256 with the RFC 9382 §6 constants, cofactor 1, and SEC1 uncompressed point
 * encoding — the group the Appendix B vectors are stated over. It lives here
 * rather than in `spake2-core.ts` because it has no runtime purpose: exporting
 * it from the module would drag `@noble/curves/nist.js` into the shipped
 * bundle. The core is group-generic by design, so injecting the group from the
 * test exercises exactly the same production code paths.
 */
const P256_TEST_GROUP: Spake2Group = {
  Point: p256.Point,
  order: p256.Point.Fn.ORDER,
  cofactor: 1n,
  M: p256.Point.fromHex(
    '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f'
  ),
  N: p256.Point.fromHex(
    '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49'
  ),
  encodePoint: (p) => p.toBytes(false),
}

// RFC 9382 Appendix B provides SPAKE2 vectors only for P-256, so the group-generic
// core is proven against all four of them before its edwards25519 instantiation is
// trusted (docs/bridge-pairing-protocol.md §13). The RFC transcript layout is the
// same as MBP1 §6.4 — enc(A) ‖ enc(B) ‖ enc(pA) ‖ enc(pB) ‖ enc(K) ‖ enc(I2OSP(w,32))
// — differing only in what the identity byte strings contain: the RFC passes the
// bare identity strings, MBP1 passes the §6.4 composite `A_id`/`B_id`. `buildTT`
// therefore takes already-assembled identities and serves both callers.
describe('SPAKE2 core — RFC 9382 Appendix B P-256 gate', () => {
  it('runs every published Appendix B vector', () => {
    expect(rfc.vectors).toHaveLength(4)
  })

  for (const v of rfc.vectors) {
    describe(v.label, () => {
      const w = os2ip(hexToBytes(v.w))
      const x = os2ip(hexToBytes(v.x))
      const y = os2ip(hexToBytes(v.y))

      it('reproduces pA and pB', () => {
        expect(bytesToHex(computePublicA(P256_TEST_GROUP, w, x))).toBe(v.pA)
        expect(bytesToHex(computePublicB(P256_TEST_GROUP, w, y))).toBe(v.pB)
      })

      it('reproduces K from both sides', () => {
        const fromA = sharedFromA(P256_TEST_GROUP, w, x, hexToBytes(v.pB))
        const fromB = sharedFromB(P256_TEST_GROUP, w, y, hexToBytes(v.pA))
        expect(bytesToHex(fromA)).toBe(v.K)
        expect(bytesToHex(fromB)).toBe(v.K)
      })

      it('reproduces the transcript TT', () => {
        const tt = buildTT(
          ascii(v.A),
          ascii(v.B),
          hexToBytes(v.pA),
          hexToBytes(v.pB),
          hexToBytes(v.K),
          w
        )
        expect(bytesToHex(tt)).toBe(v.TT)
      })

      it('reproduces the key schedule and confirmation MACs', () => {
        const keys = keySchedule(hexToBytes(v.TT), EMPTY)
        expect(bytesToHex(keys.Ke)).toBe(v.Ke)
        expect(bytesToHex(keys.Ka)).toBe(v.Ka)
        expect(bytesToHex(keys.KcA)).toBe(v.KcA)
        expect(bytesToHex(keys.KcB)).toBe(v.KcB)

        const macs = confirmationMacs(
          hexToBytes(v.KcA),
          hexToBytes(v.KcB),
          hexToBytes(v.TT)
        )
        expect(bytesToHex(macs.cA)).toBe(v.cA)
        expect(bytesToHex(macs.cB)).toBe(v.cB)
      })
    })
  }
})

// With the composition proven on P-256, the same code paths are re-run on the
// real MBP1 ciphersuite (§3) against the normative in-tree vectors (§13). This
// half is what exercises edwards25519's 32-byte compressed encoding, the
// cofactor-8 path, and the §6.6 traffic-key labels — none of which the
// cofactor-1 P-256 gate can reach.
describe('SPAKE2 core — MBP1 edwards25519 vectors', () => {
  const vectors = loadMbp1Vectors()
  const v0 = vectors.spake2[0]
  const v1 = vectors.spake2[1]
  const G = EDWARDS25519_GROUP
  const w = os2ip(hexToBytes(v0.intermediate.w))
  const x = os2ip(hexToBytes(v0.inputs.x))
  const y = os2ip(hexToBytes(v0.inputs.y))

  it('reproduces pA and pB', () => {
    expect(bytesToHex(computePublicA(G, w, x))).toBe(v0.expected.pA)
    expect(bytesToHex(computePublicB(G, w, y))).toBe(v0.expected.pB)
  })

  it('reproduces K from both sides', () => {
    const fromA = sharedFromA(G, w, x, hexToBytes(v0.expected.pB))
    const fromB = sharedFromB(G, w, y, hexToBytes(v0.expected.pA))
    expect(bytesToHex(fromA)).toBe(v0.expected.K)
    expect(bytesToHex(fromB)).toBe(v0.expected.K)
  })

  it('reproduces the transcript TT from the composite identities', () => {
    const tt = buildTT(
      hexToBytes(v0.intermediate.aId),
      hexToBytes(v0.intermediate.bId),
      hexToBytes(v0.expected.pA),
      hexToBytes(v0.expected.pB),
      hexToBytes(v0.expected.K),
      w
    )
    expect(bytesToHex(tt)).toBe(v0.expected.TT)
  })

  it('reproduces the key schedule and confirmation MACs', () => {
    const keys = keySchedule(
      hexToBytes(v0.expected.TT),
      hexToBytes(v0.intermediate.aad)
    )
    expect(bytesToHex(keys.Ke)).toBe(v0.expected.Ke)
    expect(bytesToHex(keys.Ka)).toBe(v0.expected.Ka)
    expect(bytesToHex(keys.KcA)).toBe(v0.expected.KcA)
    expect(bytesToHex(keys.KcB)).toBe(v0.expected.KcB)

    const macs = confirmationMacs(
      hexToBytes(v0.expected.KcA),
      hexToBytes(v0.expected.KcB),
      hexToBytes(v0.expected.TT)
    )
    expect(bytesToHex(macs.cA)).toBe(v0.expected.cA)
    expect(bytesToHex(macs.cB)).toBe(v0.expected.cB)
  })

  it('reproduces the pair-session traffic keys', () => {
    const traffic = pairTrafficKeys(hexToBytes(v0.expected.Ke))
    expect(bytesToHex(traffic.kC2S)).toBe(v0.expected.trafficC2S)
    expect(bytesToHex(traffic.kS2C)).toBe(v0.expected.trafficS2C)
  })

  // Vector 1 is vector 0 with the nmTicket absent: the transcript is unchanged
  // because the ticket is bound through the AAD, not TT (§6.4), so only the
  // confirmation keys and MACs move.
  it('binds the AAD variant into the confirmation keys only', () => {
    expect(v1.expected.TT).toBe(v0.expected.TT)

    const keys = keySchedule(
      hexToBytes(v1.expected.TT),
      hexToBytes(v1.intermediate.aad)
    )
    expect(bytesToHex(keys.Ke)).toBe(v0.expected.Ke)
    expect(bytesToHex(keys.Ka)).toBe(v0.expected.Ka)
    expect(bytesToHex(keys.KcA)).toBe(v1.expected.KcA)
    expect(bytesToHex(keys.KcB)).toBe(v1.expected.KcB)

    const macs = confirmationMacs(
      keys.KcA,
      keys.KcB,
      hexToBytes(v1.expected.TT)
    )
    expect(bytesToHex(macs.cA)).toBe(v1.expected.cA)
    expect(bytesToHex(macs.cB)).toBe(v1.expected.cB)
  })
})

describe('drawScalar rejection sampling (§6.3)', () => {
  const order = EDWARDS25519_GROUP.order

  // Pinned against the §3 literal rather than against itself. The vectors
  // constrain the cofactor and M/N through pA/pB/K, but nothing constrains
  // `order`: noble validates scalars against its own curve params, and the
  // rejection bounds below are derived from this same constant — so an
  // `Fn.ORDER` → `Fp.ORDER` slip would pass every other test in this file.
  it('exposes the edwards25519 group order ℓ from §3', () => {
    expect(order).toBe(2n ** 252n + 27742317777372353535851937790883648493n)
  })

  it('redraws on 0 and on values at or above the order', () => {
    const queue = [
      scalarBytes(order + 1n),
      scalarBytes(order),
      scalarBytes(0n),
      scalarBytes(7n),
    ]
    let draws = 0
    const rng = () => {
      draws += 1
      return queue.shift() as Uint8Array
    }

    expect(drawScalar(order, rng)).toBe(7n)
    expect(draws).toBe(4)
  })

  it('asks for 32 bytes per draw and rejects a short draw', () => {
    const widths: number[] = []
    expect(
      drawScalar(order, (n) => {
        widths.push(n)
        return scalarBytes(9n)
      })
    ).toBe(9n)
    expect(widths).toEqual([32])

    expect(() => drawScalar(order, () => new Uint8Array(31))).toThrow(
      ProtocolViolationError
    )
  })
})

describe('SPAKE2 core failure handling', () => {
  const G = EDWARDS25519_GROUP
  const vectors = loadMbp1Vectors()
  const v0 = vectors.spake2[0]
  const w = os2ip(hexToBytes(v0.intermediate.w))
  const x = os2ip(hexToBytes(v0.inputs.x))
  const y = os2ip(hexToBytes(v0.inputs.y))

  // A peer that replays exactly w·N drives pB − w·N to the identity, so K is
  // the identity element and the run is a failed attempt (§6.3, §7.2).
  it('rejects a peer share that drives K to the identity element', () => {
    const pB = G.encodePoint(G.N.multiply(w))
    expect(() => sharedFromA(G, w, x, pB)).toThrow(IdentityKError)

    const pA = G.encodePoint(G.M.multiply(w))
    expect(() => sharedFromB(G, w, y, pA)).toThrow(IdentityKError)
  })

  it('rejects peer shares that are not canonical curve points', () => {
    // y = 2^255 - 1 exceeds the field prime, which RFC 8032 forbids.
    const nonCanonical = new Uint8Array(32).fill(0xff)
    expect(() => sharedFromA(G, w, x, nonCanonical)).toThrow(
      ProtocolViolationError
    )
    expect(() => sharedFromB(G, w, y, nonCanonical)).toThrow(
      ProtocolViolationError
    )
    expect(() => sharedFromA(G, w, x, new Uint8Array(31))).toThrow(
      ProtocolViolationError
    )
  })

  // DO NOT DELETE THIS TEST AS REDUNDANT WITH THE VECTORS. It is the only
  // check in the suite that pins the correct cofactor form. Folding the
  // cofactor into the scalar as `(pB − w·N)·(h·x mod ℓ)` — the plausible
  // "simplification" of `sharedSecret` — passes every published vector, RFC
  // 9382 Appendix B and MBP1 alike: those vectors are generated from honest
  // shares, so `pB − w·N` is torsion-free and both forms agree exactly on the
  // prime-order subgroup.
  //
  // A torsion-carrying peer point is necessary but NOT automatically
  // sufficient to separate them. Writing `s = 8x mod ℓ`, the two forms differ
  // by exactly `(s mod ord(T))·T`, so the torsion point's order decides how
  // often the guard bites:
  //
  //   - order 2 (the point `ecff…7f`): differ only when `s` is odd, i.e. when
  //     `floor(8x/ℓ)` is odd — true for this vector's `x`, but a coin flip over
  //     `x` in general. Such a guard would silently stop discriminating if the
  //     vectors were ever regenerated.
  //   - order 8 (used below): since ℓ ≡ 5 (mod 8), `s mod 8 = 3·floor(8x/ℓ)
  //     mod 8`, which vanishes only when `floor(8x/ℓ) = 0`. In that case
  //     `s = 8x` exactly and the two forms are the *same expression*, so no
  //     test could separate them. Order 8 is therefore maximally
  //     discriminating: it bites for every `x` where biting is possible.
  //
  // The explicit folded-form assertion below keeps this self-checking — if a
  // future fixture ever stops separating the two forms, the build fails loudly
  // instead of going quietly blind. Verified by mutation: with the folded form
  // in `sharedSecret`, this is the single failing test in the file (29 of 30
  // stay green, the order-8 check among them since it never calls the core).
  const orderEightPoint = G.Point.fromBytes(
    hexToBytes(
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'
    )
  )

  it('uses a torsion point of order exactly 8', () => {
    expect(orderEightPoint.multiplyUnsafe(8n).is0()).toBe(true)
    expect(orderEightPoint.multiplyUnsafe(4n).is0()).toBe(false)
  })

  it('clears a torsion component added to the peer share', () => {
    const taintedB = G.encodePoint(
      G.Point.fromBytes(hexToBytes(v0.expected.pB)).add(orderEightPoint)
    )
    const taintedA = G.encodePoint(
      G.Point.fromBytes(hexToBytes(v0.expected.pA)).add(orderEightPoint)
    )
    expect(taintedB).not.toEqual(hexToBytes(v0.expected.pB))
    expect(taintedA).not.toEqual(hexToBytes(v0.expected.pA))

    expect(bytesToHex(sharedFromA(G, w, x, taintedB))).toBe(v0.expected.K)
    expect(bytesToHex(sharedFromB(G, w, y, taintedA))).toBe(v0.expected.K)

    // Self-check: the folded form must actually disagree on these inputs,
    // otherwise the assertions above prove nothing about the cofactor.
    const foldedFromA = G.encodePoint(
      G.Point.fromBytes(taintedB)
        .subtract(G.N.multiply(w))
        .multiply((G.cofactor * x) % G.order)
    )
    const foldedFromB = G.encodePoint(
      G.Point.fromBytes(taintedA)
        .subtract(G.M.multiply(w))
        .multiply((G.cofactor * y) % G.order)
    )
    expect(bytesToHex(foldedFromA)).not.toBe(v0.expected.K)
    expect(bytesToHex(foldedFromB)).not.toBe(v0.expected.K)
  })
})
