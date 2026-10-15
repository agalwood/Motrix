/**
 * MBP1 group-generic SPAKE2 core (bridge-pairing-protocol.md §3, §6.3-§6.6).
 *
 * The group is injected rather than hard-coded so the exact composition here
 * — public share derivation, cofactor-cleared shared secret, transcript
 * layout, key schedule, confirmation MACs — can be proven against the RFC
 * 9382 Appendix B P-256 vectors *before* the edwards25519 instantiation MBP1
 * actually uses is trusted (§13). Passing only self-generated MBP1 vectors
 * would prove nothing about the composition itself: a wrong-but-self-
 * consistent implementation reproduces its own vectors happily.
 *
 * `Spake2Group` operates entirely on wire-format byte encodings — every
 * point argument and return value is a `Uint8Array`, never a curve
 * library's own point type. This keeps the boundary narrow enough that the
 * underlying curve arithmetic can never leak into the transcript / key
 * schedule logic below, which is what makes validating the same code path
 * against two unrelated curve libraries' point representations (P-256 here,
 * edwards25519 in production) a meaningful test of the *composition* and not
 * just of one curve's arithmetic.
 *
 * Two entry points, one composition. `spake2Run` takes **both** scalars, which
 * is the shape §13's vectors (and RFC 9382 Appendix B's) are stated in and the
 * only shape in which A's and B's independently-computed secrets can be
 * cross-checked. `spake2ClientRun` takes only `x` and the peer's `pB`, which is
 * the shape a real client is in — `y` is B's secret and never crosses the wire
 * — and is therefore what `pairing-flow.ts` calls. Both derive the transcript
 * and key schedule through the same private `keyScheduleFrom`, so the vector
 * suite that gates one gates the other; a second copy for the client role would
 * put the production path outside everything those vectors prove.
 *
 * Everything this module touches is secret: `w`, `x`, `y`, `K`, `Ke`, `Ka`,
 * `KcA`, `KcB`, the confirmation MACs, the §6.6 traffic keys, and their inputs
 * (§11). This module MUST NOT log any of it at any level, and every
 * intermediate lives in caller-owned memory only — nothing here is persisted or
 * cached.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { concatBytes, enc, utf8 } from '@/background/mbp1/canonical'

/**
 * Thrown when a received point does not decode as a canonical on-curve
 * encoding (§6.3). Wire-level handling MUST map this onto the `pairError`
 * code `protocolViolation`.
 */
export class Spake2ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Spake2ProtocolViolationError'
  }
}

/**
 * Thrown when the computed shared secret `K` is the identity element of the
 * group — a failed protocol attempt, never a wire-level abort (§6.3, §7.2).
 */
export class Spake2IdentityKError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Spake2IdentityKError'
  }
}

/**
 * The minimal point operations every noble-curves `Point` class exposes,
 * satisfied structurally by both `ed25519.Point` (Edwards) and `p256.Point`
 * (Weierstrass) without importing either curve family's abstract types.
 * Kept private: nothing outside `buildGroup` ever sees this shape, so the
 * public `Spake2Group` contract stays curve-library-agnostic.
 */
interface GroupPoint {
  add(other: GroupPoint): GroupPoint
  negate(): GroupPoint
  /** Constant-time in `scalar`. Required for every *secret* scalar. */
  multiply(scalar: bigint): GroupPoint
  /** Variable-time in `scalar`. Only ever safe for public constants. */
  multiplyUnsafe(scalar: bigint): GroupPoint
  is0(): boolean
  toBytes(isCompressed?: boolean): Uint8Array
}
interface GroupPointCons {
  BASE: GroupPoint
  fromBytes(bytes: Uint8Array): GroupPoint
}

/**
 * The group operations SPAKE2 needs (§6.3), expressed entirely in wire-format
 * point encodings. `M`/`N` are this group's fixed SPAKE2 constants, already
 * encoded in the same wire format `mulBase`/`addPoints`/etc. produce and
 * consume. `decode` is a canonical-encoding validity check on its own —
 * callers that only need to reject a malformed peer share without using the
 * result may call it directly; every other method decodes internally.
 */
export interface Spake2Group {
  readonly M: Uint8Array
  readonly N: Uint8Array
  readonly order: bigint
  /** `scalar·P` (the group's base point) → wire encoding. */
  mulBase(scalar: bigint): Uint8Array
  addPoints(a: Uint8Array, b: Uint8Array): Uint8Array
  negPoint(p: Uint8Array): Uint8Array
  /** Constant-time in `scalar`. Required for every *secret* scalar. */
  mulPoint(p: Uint8Array, scalar: bigint): Uint8Array
  /** Throws `Spake2ProtocolViolationError` on non-canonical / off-curve input. */
  decode(b: Uint8Array): unknown
  /**
   * Multiplies by the group's public cofactor constant `h` (variable-time —
   * `h` is never secret). `h = 8` for edwards25519, `h = 1` (a harmless
   * identity operation) for P-256.
   */
  cofactorClear(p: Uint8Array): Uint8Array
  isIdentity(p: Uint8Array): boolean
}

function buildGroup(
  Point: GroupPointCons,
  order: bigint,
  cofactor: bigint,
  M: Uint8Array,
  N: Uint8Array,
  encodePoint: (p: GroupPoint) => Uint8Array
): Spake2Group {
  function decodeOrThrow(bytes: Uint8Array): GroupPoint {
    try {
      return Point.fromBytes(bytes)
    } catch {
      throw new Spake2ProtocolViolationError(
        'point is not a canonical encoding of a point on the curve'
      )
    }
  }
  return {
    M,
    N,
    order,
    mulBase(scalar) {
      return encodePoint(Point.BASE.multiply(scalar))
    },
    addPoints(a, b) {
      return encodePoint(decodeOrThrow(a).add(decodeOrThrow(b)))
    },
    negPoint(p) {
      return encodePoint(decodeOrThrow(p).negate())
    },
    mulPoint(p, scalar) {
      return encodePoint(decodeOrThrow(p).multiply(scalar))
    },
    decode(b) {
      return decodeOrThrow(b)
    },
    // `multiplyUnsafe` is deliberately used here (variable-time): `cofactor`
    // is a public curve constant, never secret. See `sharedSecretFromDifference`
    // below for the composition this exists to support and the much longer
    // warning about why it must stay a *separate* step from the secret-scalar
    // multiply that produces its input.
    cofactorClear(p) {
      return encodePoint(decodeOrThrow(p).multiplyUnsafe(cofactor))
    },
    isIdentity(p) {
      return decodeOrThrow(p).is0()
    },
  }
}

/**
 * MBP1's actual ciphersuite group: edwards25519 with the RFC 9382 §6 fixed
 * points (bridge-pairing-protocol.md §3), cofactor `h = 8`, 32-byte RFC 8032
 * compressed point encoding. `ed25519.Point.fromBytes` defaults to strict
 * RFC 8032 decoding (`zip215 = false`), matching §6.3's canonical-encoding
 * requirement without any extra argument.
 */
export const ED25519_GROUP: Spake2Group = buildGroup(
  ed25519.Point,
  ed25519.Point.Fn.ORDER,
  8n,
  hexToBytes(
    'd048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf'
  ),
  hexToBytes(
    'd3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab'
  ),
  (p) => p.toBytes()
)

/**
 * The P-256 group used *only* to gate this module against RFC 9382 Appendix
 * B (§13) before `ED25519_GROUP` is trusted. `M`/`N` are Table 1's P-256
 * generation seeds, transcribed from RFC 9382 §6 (SEC1 compressed, 33
 * bytes) and re-encoded to the uncompressed 65-byte SEC1 form Appendix B's
 * vectors use for every point field, so this group's wire format is
 * internally consistent end to end. P-256 has cofactor `h = 1`:
 * `cofactorClear` is a harmless no-op multiply-by-one, exercised for
 * uniformity with the edwards25519 group rather than skipped.
 */
export const P256_GROUP: Spake2Group = buildGroup(
  p256.Point,
  p256.Point.Fn.ORDER,
  1n,
  p256.Point.fromBytes(
    hexToBytes(
      '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f'
    )
  ).toBytes(false),
  p256.Point.fromBytes(
    hexToBytes(
      '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49'
    )
  ).toBytes(false),
  (p) => p.toBytes(false)
)

/** Width of a SPAKE2 scalar draw and of `I2OSP(w, 32)` in the transcript (§6.3, §6.4). */
const SCALAR_BYTES = 32

/**
 * Draws a scalar uniformly from `[1, order)` by rejection sampling (§6.3,
 * RFC 9382 §7): draw 32 CSPRNG bytes, interpret them big-endian, and redraw
 * while the value is 0 or ≥ `order`. Modular reduction is deliberately never
 * used here — it would bias the low end of the range, which is exactly what
 * rejection sampling exists to avoid. `rng` defaults to
 * `@noble/hashes`'s `randomBytes`, which uses the platform CSPRNG
 * (`crypto.getRandomValues` in a browser extension background worker); it is
 * overridable for deterministic tests.
 */
export function drawScalar(
  order: bigint,
  rng: (n: number) => Uint8Array = randomBytes
): bigint {
  for (;;) {
    const bytes = rng(SCALAR_BYTES)
    if (bytes.length !== SCALAR_BYTES) {
      throw new Spake2ProtocolViolationError(
        'drawScalar requires exactly 32 bytes of entropy per draw'
      )
    }
    const candidate = os2ip(bytes)
    if (candidate !== 0n && candidate < order) {
      return candidate
    }
  }
}

/** Big-endian interpretation of a byte string as an integer (§2 `OS2IP`). */
function os2ip(bytes: Uint8Array): bigint {
  let n = 0n
  for (const byte of bytes) {
    n = (n << 8n) | BigInt(byte)
  }
  return n
}

/**
 * `OS2IP` for callers outside this module — specifically for turning
 * `deriveW`'s 32-byte big-endian `w` into the scalar `spake2ClientRun` needs.
 *
 * Exported rather than duplicated at the call site because a second big-endian
 * decoder is a second chance to write a little-endian one, and the resulting
 * `w` would be wrong in a way no local test could see: both sides would still
 * agree on `pA`, and only key confirmation against the *real* Motrix would
 * fail.
 */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  return os2ip(bytes)
}

/**
 * `I2OSP(w, 32)` (§2): big-endian, zero-padded to the transcript's constant
 * scalar width (RFC 9382 §3.3, §6.4). A negative or oversized `w` is a
 * broken local invariant rather than peer-supplied data — `deriveW` and
 * `drawScalar` both guarantee `w` fits — so this throws a plain `Error`
 * rather than `Spake2ProtocolViolationError`, which is reserved for
 * peer-facing wire failures.
 */
function i2osp32(w: bigint): Uint8Array {
  if (w < 0n) {
    throw new Error('i2osp32: w must be non-negative')
  }
  const out = new Uint8Array(SCALAR_BYTES)
  let remaining = w
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) {
    throw new Error('i2osp32: w does not fit in 32 bytes')
  }
  return out
}

/** A local, broken invariant on a caller-supplied scalar — never peer data. */
function assertScalarInRange(
  value: bigint,
  order: bigint,
  label: string
): void {
  if (value <= 0n || value >= order) {
    throw new Error(`${label} must lie in [1, order); got out-of-range scalar`)
  }
}

const CONFIRMATION_KEYS_LABEL = utf8('ConfirmationKeys')

/**
 * `K = h·(secretScalar·d)` (§6.3) — the SPAKE2 shared-secret computation
 * from one party's own secret scalar (`x` for A, `y` for B) and the
 * peer-share-minus-mask difference `d` (`pB − w·N` for A, `pA − w·M` for B).
 * `spake2Run` calls this for both `kFromA` and `kFromB` below, and it is
 * exported specifically so the crafted torsion-guard test in
 * `spake2-core.mbp1.test.ts` exercises this exact composition rather than an
 * independently-written mirror of it that could drift from what
 * `spake2Run` actually does.
 *
 * DO NOT "simplify" this into a single `g.mulPoint(d, (h·secretScalar) %
 * g.order)`, folding the cofactor into the secret scalar before the
 * multiply. Cofactor multiplication is not a mod-order operation: `d` may
 * carry a low-order torsion component `T`, and multiplying by `h` as a
 * literal integer (not reduced mod the prime-subgroup order) kills it
 * because `h | h`, whereas `(h·secretScalar) mod order` can lose that exact
 * divisibility and leave a residual torsion term. The two forms then
 * disagree — but ONLY against a torsion-carrying peer share; every
 * published RFC 9382 and MBP1 vector is generated from honest, torsion-free
 * shares, so **a green vector suite is not evidence this function is
 * correct.** Only the crafted torsion-carrying share in
 * `spake2-core.mbp1.test.ts` proves it. `g.cofactor` is deliberately not
 * part of the public `Spake2Group` interface at all — the only way to apply
 * it is through `g.cofactorClear`, which forces this two-step order.
 */
export function sharedSecretFromDifference(
  g: Spake2Group,
  d: Uint8Array,
  secretScalar: bigint
): Uint8Array {
  return g.cofactorClear(g.mulPoint(d, secretScalar))
}

/** Everything §6.4-§6.5 derives once both shares and `K` are known. */
export interface Spake2KeySchedule {
  TT: Uint8Array
  Ke: Uint8Array
  Ka: Uint8Array
  KcA: Uint8Array
  KcB: Uint8Array
  cA: Uint8Array
  cB: Uint8Array
}

export interface Spake2Result extends Spake2KeySchedule {
  pA: Uint8Array
  pB: Uint8Array
  K: Uint8Array
}

/**
 * `TT` (§6.4), then `Ke ‖ Ka`, `KcA ‖ KcB`, `cA` and `cB` (§6.5).
 *
 * The **single** composition of the transcript and key schedule in this
 * package. `spake2Run` (both scalars given, which is the shape §13's vectors
 * are stated in) and `spake2ClientRun` (only `x` known, which is the shape a
 * real client is in) both go through it, so the RFC 9382 P-256 vectors that
 * gate `spake2Run` gate the production client path too. Writing a second copy
 * for the client role would put the production path outside everything those
 * vectors prove.
 */
function keyScheduleFrom(args: {
  aId: Uint8Array
  bId: Uint8Array
  pA: Uint8Array
  pB: Uint8Array
  K: Uint8Array
  w: bigint
  aad: Uint8Array
}): Spake2KeySchedule {
  // TT = enc(aId) || enc(bId) || enc(pA) || enc(pB) || enc(K) || enc(I2OSP(w, 32)) (§6.4).
  const TT = concatBytes(
    enc(args.aId),
    enc(args.bId),
    enc(args.pA),
    enc(args.pB),
    enc(args.K),
    enc(i2osp32(args.w))
  )

  // Ke || Ka = SHA-256(TT), 16 bytes each (§6.5).
  const digest = sha256(TT)
  const Ke = digest.slice(0, 16)
  const Ka = digest.slice(16, 32)

  // KcA || KcB = HKDF-SHA-256(ikm=Ka, salt=empty, info="ConfirmationKeys" || aad, L=32) (§6.5).
  const confirmationKeys = hkdf(
    sha256,
    Ka,
    new Uint8Array(0),
    concatBytes(CONFIRMATION_KEYS_LABEL, args.aad),
    32
  )
  const KcA = confirmationKeys.slice(0, 16)
  const KcB = confirmationKeys.slice(16, 32)

  // cA = HMAC-SHA-256(KcA, TT), cB = HMAC-SHA-256(KcB, TT) (§6.5).
  return {
    TT,
    Ke,
    Ka,
    KcA,
    KcB,
    cA: hmac(sha256, KcA, TT),
    cB: hmac(sha256, KcB, TT),
  }
}

/**
 * Runs the full SPAKE2 composition (§6.3-§6.5) for one protocol attempt,
 * given both sides' scalars directly. This is the shape both the RFC 9382
 * Appendix B vectors and the MBP1 vectors are stated in (§13: `w`, `x`, `y`
 * given, not drawn), and it lets a single call cross-check that A's and B's
 * independently-computed shared secrets agree (§6.3) before deriving
 * anything from `K`.
 *
 * `w`, `x`, `y` MUST already lie in `[1, order)` — `deriveW`
 * (scrypt-w.ts) guarantees this for `w`; `drawScalar` above guarantees it
 * for `x`/`y` when they are drawn rather than vector-supplied.
 *
 * Throws `Spake2ProtocolViolationError` if `aad`/`aId`/`bId` combine with a
 * non-canonical point anywhere in the derived shares (not expected here,
 * since both shares are derived locally from valid group elements — this
 * exists for defense in depth) and `Spake2IdentityKError` if the shared
 * secret is the identity element (§6.3, §7.2: a failed attempt).
 */
export function spake2Run(
  g: Spake2Group,
  args: {
    aId: Uint8Array
    bId: Uint8Array
    w: bigint
    x: bigint
    y: bigint
    aad: Uint8Array
  }
): Spake2Result {
  const { aId, bId, w, x, y, aad } = args
  assertScalarInRange(w, g.order, 'w')
  assertScalarInRange(x, g.order, 'x')
  assertScalarInRange(y, g.order, 'y')

  // pA = w·M + x·P, pB = w·N + y·P (§6.3).
  const wM = g.mulPoint(g.M, w)
  const wN = g.mulPoint(g.N, w)
  const pA = g.addPoints(wM, g.mulBase(x))
  const pB = g.addPoints(wN, g.mulBase(y))

  // A's view: K = h·x·(pB - w·N). B's view: K = h·y·(pA - w·M). Computing
  // both and requiring agreement (rather than trusting one) is a cheap
  // correctness check on the group implementation itself: for honest,
  // torsion-free `pA`/`pB` — which is exactly what was just derived above —
  // the two must be bytewise identical (RFC 9382 §3.3).
  const dFromA = g.addPoints(pB, g.negPoint(wN))
  const kFromA = sharedSecretFromDifference(g, dFromA, x)
  const dFromB = g.addPoints(pA, g.negPoint(wM))
  const kFromB = sharedSecretFromDifference(g, dFromB, y)
  if (!bytesEqual(kFromA, kFromB)) {
    // Not a peer-facing failure: with `pA`/`pB` freshly derived from `w`,
    // `x`, `y` above, A's and B's shared-secret formulas are algebraically
    // identical, so disagreement here means the group implementation itself
    // is broken, not that a real peer sent a bad share.
    throw new Error(
      'spake2Run: A and B computed different shared secrets from self-derived shares'
    )
  }
  if (g.isIdentity(kFromA)) {
    throw new Spake2IdentityKError(
      'SPAKE2 shared secret K is the identity element'
    )
  }
  const K = kFromA

  return {
    pA,
    pB,
    K,
    ...keyScheduleFrom({ aId, bId, pA, pB, K, w, aad }),
  }
}

/**
 * `pA = w·M + x·P` (§6.3) — A's public share, which is everything the client
 * needs to send `pakeA` before `pB` exists.
 *
 * Split from `spake2ClientRun` rather than returning intermediate state,
 * because `pA` is a pure function of `w` and `x`: `spake2ClientRun` recomputes
 * it internally, so the value bound into `TT` is identical to the value sent on
 * the wire *by construction*, with no caller-held state that could drift. The
 * cost is one extra pair of scalar multiplications per run, which is nothing
 * next to the scrypt in `deriveW`.
 */
export function spake2ClientShare(
  g: Spake2Group,
  w: bigint,
  x: bigint
): Uint8Array {
  assertScalarInRange(w, g.order, 'w')
  assertScalarInRange(x, g.order, 'x')
  return g.addPoints(g.mulPoint(g.M, w), g.mulBase(x))
}

export interface Spake2ClientResult extends Spake2KeySchedule {
  pA: Uint8Array
  K: Uint8Array
}

/**
 * The client half of one SPAKE2 run (§6.3-§6.5): given the peer's `pB`, derive
 * `K = h·x·(pB − w·N)` and everything §6.4/§6.5 hang off it.
 *
 * This is the shape a real client is in — `y` is B's secret and is never known
 * here — so it, not `spake2Run`, is the production entry point `pairing-flow.ts`
 * calls. Both share `keyScheduleFrom`, so the two agree by construction and the
 * §13 vectors gate both.
 *
 * Throws `Spake2ProtocolViolationError` when `pB` is not a canonical encoding
 * of a point on the curve (§6.3: abort with `protocolViolation`), and
 * `Spake2IdentityKError` when the shared secret is the identity element (§6.3,
 * §7.2: a failed attempt, and one that must stay indistinguishable from a bad
 * confirmation MAC — otherwise it is an oracle for `pB = w·N`, i.e. for `w`).
 */
export function spake2ClientRun(
  g: Spake2Group,
  args: {
    aId: Uint8Array
    bId: Uint8Array
    w: bigint
    x: bigint
    pB: Uint8Array
    aad: Uint8Array
  }
): Spake2ClientResult {
  const { aId, bId, w, x, pB, aad } = args
  const pA = spake2ClientShare(g, w, x)
  // `pB − w·N`, then the cofactor-cleared secret multiply. `addPoints`/
  // `negPoint` decode `pB` and throw `Spake2ProtocolViolationError` on a
  // non-canonical or off-curve encoding, which is the §6.3 abort.
  const d = g.addPoints(pB, g.negPoint(g.mulPoint(g.N, w)))
  const K = sharedSecretFromDifference(g, d, x)
  if (g.isIdentity(K)) {
    throw new Spake2IdentityKError(
      'SPAKE2 shared secret K is the identity element'
    )
  }
  return { pA, K, ...keyScheduleFrom({ aId, bId, pA, pB, K, w, aad }) }
}

const PAIR_TRAFFIC_SALT = utf8('MBP1/pair/v1')
const PAIR_TRAFFIC_INFO_C2S = utf8('MBP1-pair-traffic-c2s')
const PAIR_TRAFFIC_INFO_S2C = utf8('MBP1-pair-traffic-s2c')
const TRAFFIC_KEY_BYTES = 32

/**
 * §6.6 pair-session traffic keys, derived from `Ke` after mutual confirmation:
 *
 * ```
 * kC2S = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-c2s", L=32)
 * kS2C = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-s2c", L=32)
 * ```
 *
 * The `info` labels are deliberately distinct from §8's reconnect labels
 * (`"MBP1-traffic-c2s"` / `"MBP1-traffic-s2c"`, salt `S ‖ C`) — every HKDF/HMAC
 * invocation in MBP1 carries a globally unique label, so key separation never
 * rests on incidental differences in IKM or salt alone. Do not unify the two
 * families.
 *
 * Both keys MUST NOT be logged at any level (§11).
 */
export function pairTrafficKeys(Ke: Uint8Array): {
  c2s: Uint8Array
  s2c: Uint8Array
} {
  return {
    c2s: hkdf(
      sha256,
      Ke,
      PAIR_TRAFFIC_SALT,
      PAIR_TRAFFIC_INFO_C2S,
      TRAFFIC_KEY_BYTES
    ),
    s2c: hkdf(
      sha256,
      Ke,
      PAIR_TRAFFIC_SALT,
      PAIR_TRAFFIC_INFO_S2C,
      TRAFFIC_KEY_BYTES
    ),
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}
