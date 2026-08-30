// MBP1 group-generic SPAKE2 core (docs/bridge-pairing-protocol.md §3, §6.3–§6.6).
//
// The group is injected rather than hard-coded so the same composition — public
// share derivation, cofactor-cleared shared secret, transcript layout, key
// schedule, confirmation MACs — can be validated against the RFC 9382
// Appendix B P-256 vectors before MBP1's edwards25519 instantiation is trusted
// (§13). Passing only the MBP1 vectors would prove nothing about the
// composition: a wrong-but-self-consistent implementation reproduces its own
// generated vectors. Only MBP1's own group is defined here; the P-256 group
// those RFC vectors need is built inside `spake2-core.test.ts`, so the NIST
// curve implementation never reaches a production bundle.
//
// Everything this module handles is secret: `w`, `x`, `y`, `K`, `Ke`, `Ka`,
// `KcA`, `KcB`, the confirmation MACs, and the traffic keys (§11). It therefore
// logs nothing at any level, and all state is caller-owned and in-memory only.

import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import {
  concatBytes,
  enc,
  hkdf32,
  hmacSha256,
  os2ip,
  ProtocolViolationError,
} from './canonical'

/** `K` came out as the identity element, which is a failed attempt (§6.3, §7.2). */
export class IdentityKError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityKError'
  }
}

/**
 * The point operations SPAKE2 needs, satisfied structurally by the noble
 * `Point` classes. `toBytes` carries the optional compression flag only
 * because the P-256 group injected by the RFC-vector test must ask for the
 * RFC 9382 uncompressed encoding; the edwards25519 group ignores it.
 */
export interface GroupPoint {
  add(other: GroupPoint): GroupPoint
  subtract(other: GroupPoint): GroupPoint
  /** Constant-time in `scalar`; required for every secret scalar. */
  multiply(scalar: bigint): GroupPoint
  /** Variable-time; only for public constants such as the cofactor. */
  multiplyUnsafe(scalar: bigint): GroupPoint
  is0(): boolean
  toBytes(isCompressed?: boolean): Uint8Array
}

export interface Spake2Group {
  Point: { fromBytes(b: Uint8Array): GroupPoint; BASE: GroupPoint }
  order: bigint
  cofactor: bigint
  M: GroupPoint
  N: GroupPoint
  encodePoint(p: GroupPoint): Uint8Array
}

/** MBP1 ciphersuite group: edwards25519 with the RFC 9382 §6 constants (§3). */
export const EDWARDS25519_GROUP: Spake2Group = {
  Point: ed25519.Point,
  order: ed25519.Point.Fn.ORDER,
  cofactor: 8n,
  M: ed25519.Point.fromHex(
    'd048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf'
  ),
  N: ed25519.Point.fromHex(
    'd3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab'
  ),
  encodePoint: (p) => p.toBytes(),
}

/** Width of a SPAKE2 scalar draw and of `I2OSP(w, 32)` in the transcript (§6.3, §6.4). */
const SCALAR_BYTES = 32

const CONFIRMATION_KEYS_LABEL = utf8ToBytes('ConfirmationKeys')
const PAIR_TRAFFIC_SALT = utf8ToBytes('MBP1/pair/v1')
const PAIR_TRAFFIC_INFO_C2S = utf8ToBytes('MBP1-pair-traffic-c2s')
const PAIR_TRAFFIC_INFO_S2C = utf8ToBytes('MBP1-pair-traffic-s2c')

/**
 * Draws a scalar uniformly from `[1, order)` by rejection sampling (§6.3,
 * RFC 9382 §7): take 32 CSPRNG bytes, read them big-endian, and redraw while
 * the value is 0 or ≥ `order`. Modular reduction is deliberately not used —
 * it would bias the low end of the range. A short draw would silently lower
 * the entropy of the scalar, so an off-length `rng` result throws instead.
 */
export function drawScalar(
  order: bigint,
  rng: (n: number) => Uint8Array
): bigint {
  for (;;) {
    const bytes = rng(SCALAR_BYTES)
    if (bytes.length !== SCALAR_BYTES) {
      throw new ProtocolViolationError(
        'drawScalar requires exactly 32 bytes of entropy per draw'
      )
    }
    const candidate = os2ip(bytes)
    if (candidate !== 0n && candidate < order) {
      return candidate
    }
  }
}

/**
 * `pA = w·M + x·P` (§6.3). `w` and `x` must already lie in `[1, order)`:
 * `deriveW` guarantees that for `w`, `drawScalar` for `x`.
 */
export function computePublicA(
  g: Spake2Group,
  w: bigint,
  x: bigint
): Uint8Array {
  return g.encodePoint(g.M.multiply(w).add(g.Point.BASE.multiply(x)))
}

/** `pB = w·N + y·P` (§6.3). Same scalar preconditions as `computePublicA`. */
export function computePublicB(
  g: Spake2Group,
  w: bigint,
  y: bigint
): Uint8Array {
  return g.encodePoint(g.N.multiply(w).add(g.Point.BASE.multiply(y)))
}

/** A's shared secret `K = h·x·(pB − w·N)` (§6.3). */
export function sharedFromA(
  g: Spake2Group,
  w: bigint,
  x: bigint,
  pB: Uint8Array
): Uint8Array {
  return sharedSecret(g, x, decodePoint(g, pB, 'pB'), g.N, w)
}

/** B's shared secret `K = h·y·(pA − w·M)` (§6.3). */
export function sharedFromB(
  g: Spake2Group,
  w: bigint,
  y: bigint,
  pA: Uint8Array
): Uint8Array {
  return sharedSecret(g, y, decodePoint(g, pA, 'pA'), g.M, w)
}

function sharedSecret(
  g: Spake2Group,
  scalar: bigint,
  peerShare: GroupPoint,
  mask: GroupPoint,
  w: bigint
): Uint8Array {
  const d = peerShare.subtract(mask.multiply(w))
  // DO NOT "simplify" the next line into `d.multiply((h * scalar) % order)`.
  // The cofactor multiply must stay a separate step: `d` may carry a low-order
  // torsion component `T`, and `h·scalar·d` kills it because `8 | h·scalar`,
  // whereas reducing `h·scalar` modulo the prime subgroup order destroys that
  // divisibility and leaves a residual torsion term. The two forms then
  // disagree whenever a peer sends a share with torsion in it.
  //
  // No test vector catches the difference — RFC 9382 Appendix B and the MBP1
  // vectors alike are generated from honest shares, whose `pB − w·N` is
  // torsion-free, and on the prime-order subgroup both forms agree exactly.
  // The only thing pinning this is the crafted torsion-share test in
  // `spake2-core.test.ts` ("clears a torsion component added to the peer
  // share"); a green vector suite is NOT evidence that this line is right.
  //
  // `multiplyUnsafe` is acceptable for `h` because it is a public curve
  // constant, not a secret; the secret scalar goes through constant-time
  // `multiply`.
  const k = d.multiply(scalar).multiplyUnsafe(g.cofactor)
  if (k.is0()) {
    throw new IdentityKError('SPAKE2 shared secret K is the identity element')
  }
  return g.encodePoint(k)
}

/**
 * Decodes a peer's share. Received points must be canonical encodings of
 * points on the curve; noble rejects non-canonical encodings, and anything it
 * rejects aborts the run with `protocolViolation` (§6.3).
 */
function decodePoint(
  g: Spake2Group,
  bytes: Uint8Array,
  field: string
): GroupPoint {
  try {
    return g.Point.fromBytes(bytes)
  } catch {
    throw new ProtocolViolationError(
      `${field} is not a canonical encoding of a curve point`
    )
  }
}

/**
 * `TT = enc(A_id) ‖ enc(B_id) ‖ enc(pA) ‖ enc(pB) ‖ enc(K) ‖ enc(I2OSP(w, 32))`
 * (§6.4). The identity arguments are already-assembled byte strings, so the
 * caller decides what an identity contains: MBP1 passes the §6.4 composites,
 * while the RFC 9382 vectors pass the bare identity strings. The layout is
 * identical either way.
 *
 * `w` must already be reduced mod the group order — `deriveW` guarantees that.
 * The value is encoded as given, so an unreduced `w` would produce a
 * transcript inconsistent with the `pA` the caller derived from it.
 */
export function buildTT(
  aIdentity: Uint8Array,
  bIdentity: Uint8Array,
  pA: Uint8Array,
  pB: Uint8Array,
  K: Uint8Array,
  w: bigint
): Uint8Array {
  return concatBytes(
    enc(aIdentity),
    enc(bIdentity),
    enc(pA),
    enc(pB),
    enc(K),
    enc(i2ospScalar(w))
  )
}

/**
 * `Ke ‖ Ka = SHA-256(TT)` and
 * `KcA ‖ KcB = HKDF-SHA-256(ikm=Ka, salt=empty, info="ConfirmationKeys" ‖ AAD, L=32)`,
 * 16 bytes each (§6.5). Binding the AAD into the confirmation keys is what
 * makes tampering with any AAD-covered field fail the pairing closed (§6.4).
 */
export function keySchedule(
  tt: Uint8Array,
  aad: Uint8Array
): { Ke: Uint8Array; Ka: Uint8Array; KcA: Uint8Array; KcB: Uint8Array } {
  const digest = new Uint8Array(createHash('sha256').update(tt).digest())
  const Ka = digest.slice(16)
  const confirmation = hkdf32(
    Ka,
    new Uint8Array(0),
    concatBytes(CONFIRMATION_KEYS_LABEL, aad)
  )
  return {
    Ke: digest.slice(0, 16),
    Ka,
    KcA: confirmation.slice(0, 16),
    KcB: confirmation.slice(16),
  }
}

/** `cA = HMAC-SHA-256(KcA, TT)`, `cB = HMAC-SHA-256(KcB, TT)` (§6.5). */
export function confirmationMacs(
  kcA: Uint8Array,
  kcB: Uint8Array,
  tt: Uint8Array
): { cA: Uint8Array; cB: Uint8Array } {
  return { cA: hmacSha256(kcA, tt), cB: hmacSha256(kcB, tt) }
}

/**
 * Pair-session traffic keys derived from `Ke` after mutual confirmation (§6.6).
 * The `info` labels are deliberately distinct from the §8 reconnect labels, so
 * key separation never rests on incidental differences in IKM or salt alone.
 */
export function pairTrafficKeys(ke: Uint8Array): {
  kC2S: Uint8Array
  kS2C: Uint8Array
} {
  return {
    kC2S: hkdf32(ke, PAIR_TRAFFIC_SALT, PAIR_TRAFFIC_INFO_C2S),
    kS2C: hkdf32(ke, PAIR_TRAFFIC_SALT, PAIR_TRAFFIC_INFO_S2C),
  }
}

/**
 * `I2OSP(w, 32)` — big-endian, zero-padded to the constant transcript width
 * required by RFC 9382 §3.3 (§6.4).
 *
 * A negative or oversized `w` is a broken local invariant, not peer-supplied
 * data, so these throw plain `Error`: `ProtocolViolationError` is mapped onto
 * the peer-facing `protocolViolation` pairError, and reporting our own bug as
 * the peer's violation would misattribute the failure.
 */
function i2ospScalar(w: bigint): Uint8Array {
  if (w < 0n) {
    throw new Error('w must be non-negative')
  }
  const out = new Uint8Array(SCALAR_BYTES)
  let remaining = w
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) {
    throw new Error('w does not fit in 32 bytes')
  }
  return out
}
