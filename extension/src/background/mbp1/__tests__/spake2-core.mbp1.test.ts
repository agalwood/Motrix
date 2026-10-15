import { ED25519_TORSION_SUBGROUP, ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS } from '@/background/mbp1/__fixtures__/vectors'
import { reconnectTrafficKeys } from '@/background/mbp1/reconnect-mac'
import { deriveW } from '@/background/mbp1/scrypt-w'
import {
  drawScalar,
  ED25519_GROUP,
  P256_GROUP,
  pairTrafficKeys,
  Spake2IdentityKError,
  Spake2ProtocolViolationError,
  scalarFromBytes,
  sharedSecretFromDifference,
  spake2ClientRun,
  spake2ClientShare,
  spake2Run,
} from '@/background/mbp1/spake2-core'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))

describe('SPAKE2 core — MBP1 edwards25519 vectors (§13)', () => {
  const v0 = MBP1_VECTORS.spake2[0]
  if (!v0.inputs || !v0.intermediate || !v0.expected) {
    throw new Error('vector 0 missing fields')
  }
  const w = BigInt(`0x${v0.intermediate.w}`)
  const x = BigInt(`0x${v0.inputs.x}`)
  const y = BigInt(`0x${v0.inputs.y}`)

  it('reproduces vector 0 (chromium, nm ticket present)', () => {
    const r = spake2Run(ED25519_GROUP, {
      aId: fromHex(v0.intermediate?.aId ?? ''),
      bId: fromHex(v0.intermediate?.bId ?? ''),
      w,
      x,
      y,
      aad: fromHex(v0.intermediate?.aad ?? ''),
    })
    expect(hex(r.pA)).toBe(v0.expected.pA)
    expect(hex(r.pB)).toBe(v0.expected.pB)
    expect(hex(r.K)).toBe(v0.expected.K)
    expect(hex(r.TT)).toBe(v0.expected.TT)
    expect(hex(r.Ke)).toBe(v0.expected.Ke)
    expect(hex(r.Ka)).toBe(v0.expected.Ka)
    expect(hex(r.KcA)).toBe(v0.expected.KcA)
    expect(hex(r.KcB)).toBe(v0.expected.KcB)
    expect(hex(r.cA)).toBe(v0.expected.cA)
    expect(hex(r.cB)).toBe(v0.expected.cB)
  })

  // Vector 1 is vector 0 with the nmTicket absent: same aId/bId/w/x/y, only
  // aad differs. The transcript TT is unchanged because the ticket is bound
  // through AAD, not TT (§6.4) — only the confirmation keys and MACs move.
  it('binds the AAD variant into the confirmation keys only (vector 1)', () => {
    const v1 = MBP1_VECTORS.spake2[1]
    if (!v1.intermediate || !v1.expected) {
      throw new Error('vector 1 missing fields')
    }
    const r = spake2Run(ED25519_GROUP, {
      aId: fromHex(v0.intermediate?.aId ?? ''),
      bId: fromHex(v0.intermediate?.bId ?? ''),
      w,
      x,
      y,
      aad: fromHex(v1.intermediate.aad),
    })
    expect(hex(r.TT)).toBe(v1.expected.TT)
    expect(v1.expected.TT).toBe(v0.expected.TT)
    expect(hex(r.Ke)).toBe(v0.expected.Ke)
    expect(hex(r.Ka)).toBe(v0.expected.Ka)
    expect(hex(r.KcA)).toBe(v1.expected.KcA)
    expect(hex(r.KcB)).toBe(v1.expected.KcB)
    expect(hex(r.cA)).toBe(v1.expected.cA)
    expect(hex(r.cB)).toBe(v1.expected.cB)
  })
})

describe('ED25519_GROUP constants (§3)', () => {
  // Pinned against the spec's literal value rather than against noble's own
  // constant trivially matching itself: an `Fn.ORDER` -> `Fp.ORDER` slip (the
  // field prime instead of the scalar order) would still pass every vector
  // in this suite by coincidence of how those vectors were generated, so
  // this check exists purely to catch that specific class of mistake.
  it('exposes the exact group order ℓ = 2^252 + 27742317777372353535851937790883648493', () => {
    expect(ED25519_GROUP.order).toBe(
      2n ** 252n + 27742317777372353535851937790883648493n
    )
  })

  it('exposes the exact M/N constants from RFC 9382 §6 / spec §3', () => {
    expect(hex(ED25519_GROUP.M)).toBe(
      'd048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf'
    )
    expect(hex(ED25519_GROUP.N)).toBe(
      'd3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab'
    )
  })
})

describe('drawScalar rejection sampling (§6.3, RFC 9382 §7)', () => {
  const order = ED25519_GROUP.order
  const scalarBytes = (n: bigint) => fromHex(n.toString(16).padStart(64, '0'))

  it('redraws while the candidate is 0 or >= order, never reduces modularly', () => {
    const queue = [
      scalarBytes(order + 1n),
      scalarBytes(order),
      scalarBytes(0n),
      scalarBytes(7n),
    ]
    let draws = 0
    const rng = (n: number) => {
      draws += 1
      expect(n).toBe(32)
      const next = queue.shift()
      if (next === undefined) throw new Error('rng exhausted')
      return next
    }
    expect(drawScalar(order, rng)).toBe(7n)
    expect(draws).toBe(4)
  })

  it('throws if the rng returns the wrong number of bytes', () => {
    expect(() => drawScalar(order, () => new Uint8Array(31))).toThrow(
      Spake2ProtocolViolationError
    )
  })
})

describe('SPAKE2 core failure handling (§6.3, wire-level protocolViolation / pairingFailed)', () => {
  it('rejects a non-canonical / off-curve point encoding', () => {
    // All-0xff: interpreted as y, this exceeds the field prime -- RFC 8032
    // forbids non-reduced y coordinates in a canonical encoding.
    const nonCanonical = new Uint8Array(32).fill(0xff)
    expect(() => ED25519_GROUP.decode(nonCanonical)).toThrow(
      Spake2ProtocolViolationError
    )
    expect(() =>
      ED25519_GROUP.addPoints(nonCanonical, ED25519_GROUP.M)
    ).toThrow(Spake2ProtocolViolationError)
    expect(() => ED25519_GROUP.mulPoint(nonCanonical, 7n)).toThrow(
      Spake2ProtocolViolationError
    )
  })

  it('rejects a wrong-length encoding', () => {
    expect(() => ED25519_GROUP.decode(new Uint8Array(31))).toThrow(
      Spake2ProtocolViolationError
    )
  })

  // §6.3: "If K is the identity element, abort." `spake2Run` cannot exercise
  // this itself through its own public interface: it derives pA and pB
  // honestly from the SAME w/x/y it is given, and since the group order ℓ is
  // prime and coprime to the cofactor h=8, K = h·x·y·P is identity only if
  // ℓ | x or ℓ | y — impossible for x, y already constrained to [1, ℓ) by
  // `assertScalarInRange`/`drawScalar`. This case only arises against a real
  // (adversarial or buggy) peer share received over the wire, which is the
  // one-sided `spake2ClientRun` caller's concern — asserted directly against
  // that entry point below ("throws Spake2IdentityKError when pB is exactly
  // w·N"). This test stays because it pins the primitive-level building block
  // that entry point rests on: `g.isIdentity` flags exactly the degenerate
  // share §6.3 describes, a peer replaying `pB = w·N` (i.e. contributing no
  // `y·P` term of its own).
  it('flags a peer share that drives K to the identity element', () => {
    const g = ED25519_GROUP
    const w = 424242n
    const x = 99999n
    const replayedPB = g.mulPoint(g.N, w)
    const d = g.addPoints(replayedPB, g.negPoint(g.mulPoint(g.N, w)))
    const K = sharedSecretFromDifference(g, d, x)
    expect(g.isIdentity(K)).toBe(true)
  })

  // DO NOT DELETE THIS TEST AS REDUNDANT WITH THE VECTORS ABOVE. It is the
  // only check in this suite that pins the correct cofactor composition, and
  // it calls `sharedSecretFromDifference` — the exact function `spake2Run`
  // itself calls for both `kFromA` and `kFromB` — rather than an
  // independently-written mirror of it, so a regression to that shared
  // function is caught here even though `spake2Run`'s own scalar-only
  // argument surface can never be fed an adversarial/torsion-tainted peer
  // share directly (it always derives its own honest, matched pA/pB).
  //
  // `K = h·(x·d)` (production, via `sharedSecretFromDifference`) and the
  // plausible "simplification" `K' = ((h·x) mod ℓ)·d` agree exactly whenever
  // `d` is torsion-free — which is true for every `d` derived from an honest
  // share in RFC 9382 Appendix B and the MBP1 vectors alike, since those are
  // all generated from honest, torsion-free shares. A green vector suite is
  // therefore NOT evidence that the cofactor composition in
  // `sharedSecretFromDifference` is correct; only a crafted torsion-carrying
  // share can prove it (see the large comment on `sharedSecretFromDifference`
  // in spake2-core.ts).
  //
  // A torsion point of order dividing `h` is necessary but not automatically
  // sufficient to separate the two forms. Writing `s = (h·x) mod ℓ`, the two
  // forms differ by exactly `(s mod ord(T))·T`, so the torsion point's order
  // decides how often the guard actually bites:
  //   - order 2: differs only when `s` is odd, i.e. only for the subset of
  //     `x` where `floor(h·x/ℓ)` is odd -- a coin flip over `x` in general,
  //     so such a guard could silently stop discriminating if the specific
  //     `x` used ever changed.
  //   - order 8 (used below, `h = 8` for edwards25519): since `ℓ ≡ 5 (mod
  //     8)`, `s mod 8 = 3·floor(8x/ℓ) mod 8`, which vanishes only when
  //     `floor(8x/ℓ) = 0`. In exactly that case `s = 8x` with no reduction
  //     needed, so the two forms are the *same expression* and no torsion
  //     point of any order could separate them. Order 8 is therefore
  //     maximally discriminating: it bites for every `x` where biting is
  //     even mathematically possible.
  // `x` below is deliberately chosen as `order - 1` (so `floor(8x/order) =
  // 7 != 0`) rather than reused from a published vector, so this guard's
  // discrimination does not depend on an incidental property of vector data
  // that a future vector regeneration could silently change.
  it('the correct cofactor composition ignores an order-8 torsion component that the folded form would not', () => {
    const g = ED25519_GROUP
    const order = g.order
    const w = 12345n
    const x = order - 1n
    expect((8n * x) / order).not.toBe(0n) // guard precondition: biting is possible

    const T = ED25519_TORSION_SUBGROUP[1]
    if (T === undefined) throw new Error('missing torsion point fixture')
    const torsionPoint = fromHex(T)
    expect(ed25519.Point.fromBytes(torsionPoint).multiplyUnsafe(8n).is0()).toBe(
      true
    ) // self-check: T really has order exactly 8
    expect(ed25519.Point.fromBytes(torsionPoint).multiplyUnsafe(4n).is0()).toBe(
      false
    )

    const wN = g.mulPoint(g.N, w)
    const y = 424243n
    const pB = g.addPoints(wN, g.mulBase(y))
    const dHonest = g.addPoints(pB, g.negPoint(wN))
    const kHonest = sharedSecretFromDifference(g, dHonest, x)
    expect(g.isIdentity(kHonest)).toBe(false)

    const pBTainted = g.addPoints(pB, torsionPoint)
    const dTainted = g.addPoints(pBTainted, g.negPoint(wN))
    expect(hex(dTainted)).not.toBe(hex(dHonest))

    // Production composition (the exact function `spake2Run` calls):
    // correct, ignores the torsion component.
    const kTaintedCorrect = sharedSecretFromDifference(g, dTainted, x)
    expect(hex(kTaintedCorrect)).toBe(hex(kHonest))

    // The rejected "simplification", computed independently of
    // spake2-core.ts by calling noble directly: folds `h` into the secret
    // scalar mod the group order instead of clearing it as a separate
    // public-constant step.
    const foldedScalar = (8n * x) % order
    const kTaintedWrong = ed25519.Point.fromBytes(dTainted)
      .multiplyUnsafe(foldedScalar)
      .toBytes()
    expect(hex(kTaintedWrong)).not.toBe(hex(kHonest))

    // Self-check completing the "vectors can't catch this" claim: on the
    // SAME honest (torsion-free) `d`, the two forms agree exactly, which is
    // exactly why every published vector is blind to this distinction.
    const kHonestWrongForm = ed25519.Point.fromBytes(dHonest)
      .multiplyUnsafe(foldedScalar)
      .toBytes()
    expect(hex(kHonestWrongForm)).toBe(hex(kHonest))
  })
})

describe('P256_GROUP and ED25519_GROUP wire-encoding independence', () => {
  // Sanity check that the two groups injected into spake2Run really are
  // different curve libraries with different point-encoding widths, which
  // is what makes the RFC gate in spake2-core.rfc.test.ts a meaningful proof
  // of the shared composition rather than a P-256-flavored copy of the same
  // edwards25519 code path.
  it('P256_GROUP uses the 65-byte uncompressed SEC1 encoding, not the 32-byte edwards encoding', () => {
    expect(P256_GROUP.M.length).toBe(65)
    expect(ED25519_GROUP.M.length).toBe(32)
  })

  it('P256_GROUP has cofactor 1: cofactorClear is a harmless identity operation', () => {
    const doubled = P256_GROUP.mulBase(3n)
    expect(hex(P256_GROUP.cofactorClear(doubled))).toBe(hex(doubled))
  })
})

// The client role is the shape a real extension is in: `y` is B's secret and
// is never known here, so `spake2ClientRun` — not `spake2Run` — is what
// `pairing-flow.ts` calls. These assert the production client path against the
// same normative vectors, so a divergence between the two compositions cannot
// hide behind `spake2Run`'s green suite above.
describe('spake2ClientShare / spake2ClientRun (A-role, §6.3-§6.6)', () => {
  const v0 = MBP1_VECTORS.spake2[0]
  if (!v0.inputs || !v0.intermediate || !v0.expected) {
    throw new Error('vector 0 missing fields')
  }
  const w = BigInt(`0x${v0.intermediate.w}`)
  const x = BigInt(`0x${v0.inputs.x}`)
  const aId = fromHex(v0.intermediate.aId ?? '')
  const bId = fromHex(v0.intermediate.bId ?? '')
  const aad = fromHex(v0.intermediate.aad ?? '')
  const pB = fromHex(v0.expected.pB ?? '')

  it('derives pA from w and x alone, matching the vector', () => {
    expect(hex(spake2ClientShare(ED25519_GROUP, w, x))).toBe(v0.expected.pA)
  })

  it('reproduces the full vector from pB alone, without knowing y', () => {
    const r = spake2ClientRun(ED25519_GROUP, { aId, bId, w, x, pB, aad })
    expect(hex(r.pA)).toBe(v0.expected.pA)
    expect(hex(r.K)).toBe(v0.expected.K)
    expect(hex(r.TT)).toBe(v0.expected.TT)
    expect(hex(r.Ke)).toBe(v0.expected.Ke)
    expect(hex(r.Ka)).toBe(v0.expected.Ka)
    expect(hex(r.KcA)).toBe(v0.expected.KcA)
    expect(hex(r.KcB)).toBe(v0.expected.KcB)
    expect(hex(r.cA)).toBe(v0.expected.cA)
    expect(hex(r.cB)).toBe(v0.expected.cB)
  })

  it('binds the ticketless AAD variant into the confirmation keys only', () => {
    const v1 = MBP1_VECTORS.spake2[1]
    if (!v1.intermediate || !v1.expected) {
      throw new Error('vector 1 missing fields')
    }
    const r = spake2ClientRun(ED25519_GROUP, {
      aId,
      bId,
      w,
      x,
      pB,
      aad: fromHex(v1.intermediate.aad),
    })
    expect(hex(r.TT)).toBe(v0.expected.TT)
    expect(hex(r.cA)).toBe(v1.expected.cA)
    expect(hex(r.cB)).toBe(v1.expected.cB)
  })

  it('rejects a non-canonical pB with a protocolViolation, not a silent result', () => {
    // All-0xff is not a valid RFC 8032 point encoding (§6.3).
    expect(() =>
      spake2ClientRun(ED25519_GROUP, {
        aId,
        bId,
        w,
        x,
        pB: new Uint8Array(32).fill(0xff),
        aad,
      })
    ).toThrow(Spake2ProtocolViolationError)
  })

  it('throws Spake2IdentityKError when pB is exactly w·N (K = identity)', () => {
    // The one input for which A's shared secret degenerates: pB − w·N is the
    // identity, so `K` carries no secret at all. §6.3 requires an abort, and
    // §7.2 counts it as a failed attempt.
    const wN = ED25519_GROUP.mulPoint(ED25519_GROUP.N, w)
    expect(() =>
      spake2ClientRun(ED25519_GROUP, { aId, bId, w, x, pB: wN, aad })
    ).toThrow(Spake2IdentityKError)
  })

  it('recomputes pA internally rather than trusting a caller-held copy', () => {
    // The transcript must bind the share that was actually sent. Proven by
    // construction: `spake2ClientRun` takes no `pA` parameter at all, so the
    // only pA that can reach TT is the one `spake2ClientShare` derives from the
    // same (w, x) — and that is the value the flow sent in `pakeA`.
    const sent = spake2ClientShare(ED25519_GROUP, w, x)
    const r = spake2ClientRun(ED25519_GROUP, { aId, bId, w, x, pB, aad })
    expect(hex(r.pA)).toBe(hex(sent))
  })
})

describe('pairTrafficKeys (§6.6)', () => {
  it('matches the vector traffic keys derived from Ke', () => {
    const v0 = MBP1_VECTORS.spake2[0]
    if (!v0.expected) throw new Error('vector 0 missing fields')
    const keys = pairTrafficKeys(fromHex(v0.expected.Ke ?? ''))
    expect(hex(keys.c2s)).toBe(v0.expected.trafficC2S)
    expect(hex(keys.s2c)).toBe(v0.expected.trafficS2C)
  })

  it('does not reuse the §8 reconnect labels', () => {
    // Both key families ultimately derive from a shared secret; §6.6 requires
    // globally unique labels so separation never rests on the IKM or salt
    // alone. Feeding one family's IKM through the other's labels must not
    // reproduce either vector.
    const v0 = MBP1_VECTORS.spake2[0]
    if (!v0.expected) throw new Error('vector 0 missing fields')
    const Ke = fromHex(v0.expected.Ke ?? '')
    const reconnectShaped = reconnectTrafficKeys(Ke, Ke, Ke)
    expect(hex(reconnectShaped.c2s)).not.toBe(v0.expected.trafficC2S)
    expect(hex(reconnectShaped.s2c)).not.toBe(v0.expected.trafficS2C)
  })

  it('separates the two directions', () => {
    const keys = pairTrafficKeys(new Uint8Array(16).fill(7))
    expect(hex(keys.c2s)).not.toBe(hex(keys.s2c))
    expect(keys.c2s.length).toBe(32)
    expect(keys.s2c.length).toBe(32)
  })
})

describe('scalarFromBytes', () => {
  it('reads deriveW output big-endian, matching the vector w', () => {
    const v0 = MBP1_VECTORS.spake2[0]
    if (!v0.inputs || !v0.intermediate) {
      throw new Error('vector 0 missing fields')
    }
    const wBytes = deriveW(v0.inputs.codeNormalized, v0.inputs.pairNonce)
    expect(scalarFromBytes(wBytes)).toBe(BigInt(`0x${v0.intermediate.w}`))
  })

  it('is big-endian, not little-endian', () => {
    expect(scalarFromBytes(new Uint8Array([0x01, 0x00]))).toBe(256n)
  })
})

describe('spake2Run internal consistency and error surfaces', () => {
  it('exports Spake2IdentityKError for callers to catch', () => {
    expect(Spake2IdentityKError.prototype).toBeInstanceOf(Error)
  })

  it('rejects an out-of-range scalar rather than silently reducing it', () => {
    const v0 = MBP1_VECTORS.spake2[0]
    if (!v0.inputs || !v0.intermediate)
      throw new Error('vector 0 missing fields')
    expect(() =>
      spake2Run(ED25519_GROUP, {
        aId: fromHex(v0.intermediate?.aId ?? ''),
        bId: fromHex(v0.intermediate?.bId ?? ''),
        w: ED25519_GROUP.order, // out of range: must be < order
        x: BigInt(`0x${v0.inputs?.x}`),
        y: BigInt(`0x${v0.inputs?.y}`),
        aad: new Uint8Array(0),
      })
    ).toThrow()
  })
})
