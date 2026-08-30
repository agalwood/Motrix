// MBP1 NM attestation-ticket verification
// (docs/bridge-pairing-protocol.md §9.1, §9.2, §5).
//
// The native-messaging host is the only party that can mint a ticket: the
// `ticketKey` derives from `localToken`, which never leaves the host side
// (§9.1). Verifying a ticket at `pairHello` is therefore what lets the server
// resolve the §5 identity tri-state for a caller whose origin it cannot
// otherwise attribute.
//
// Two properties of §9.2 are load-bearing and easy to break by "tidying" the
// control flow:
//
//   1. **The MAC is verified first.** `ticketKey` depends on `localToken`
//      alone, which persists across bridge restarts while `serverGeneration`
//      rotates. Checking the MAC before the generation / `exp` / `callerId`
//      checks is what makes an honest ticket minted by a *previous* generation
//      resolve as a semantic `unverified` downgrade instead of being
//      misclassified as a forged-MAC abort — and conversely keeps a genuinely
//      forged MAC an abort no matter what its `serverGeneration` says.
//      Reordering these checks converts an abort into a downgrade and hands an
//      attacker a semantic bypass.
//   2. **Structural and cryptographic failures abort; only content failures
//      downgrade.** A legitimate extension never presents a malformed ticket,
//      and §6.4's ticket digest already fails in-transit tampering closed at
//      key confirmation. Aborting also resolves the otherwise contradictory
//      case where §6.5 demands a valid `ticketProof` that an invalid
//      `bindingPub` could never satisfy.
//
// The MAC input's leading element is the fixed domain tag
// `enc("mbp1-attestation")`, *not* the wire `purpose` field — the opposite
// convention from §6.4's `ticketDigest`, which hashes the wire value so that
// flipping `purpose` still changes the digest. Both are deliberate.
//
// Validation here runs before the approval dialog and touches no prompt or
// failure counter (§9.2), so a corrupted ticket cannot amplify the DoS
// surface. `localToken`, `ticketKey`, and the ticket MAC are all secret or
// secret-adjacent (§9.1, §11), so this module logs nothing at any level.

import { timingSafeEqual } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { z } from 'zod'
import {
  concatBytes,
  enc,
  encU32BE,
  encU64BE,
  fromBase64Url,
  hkdf32,
  hmacSha256,
  toBase64Url,
} from './canonical'
import type { TicketWire } from './transcript'

/** The only `v`, `purpose`, and `protocolVersion` a v1 ticket may carry (§9.2). */
const TICKET_VERSION = 1
const TICKET_PURPOSE = 'mbp1-attestation'
const TICKET_PROTOCOL_VERSION = 1

const TICKET_KEY_SALT = utf8ToBytes('MBP1/nm-ticket/v1')
const TICKET_KEY_INFO = utf8ToBytes('mac')
const MAC_DOMAIN_TAG = enc(TICKET_PURPOSE)
const PROOF_LABEL = utf8ToBytes('MBP1/ticket-proof/v1')

const POINT_LENGTH = 32
const SIGNATURE_LENGTH = 64

/** `exp` is a remaining-lifetime bound, not a mint timestamp (§9.2). */
export const MAX_REMAINING_LIFETIME_MS = 60_000

/** Which §9.2 abort row a ticket hit. Every value maps to `pairError {code:"protocolViolation"}`. */
export type TicketAbortReason =
  | 'schema'
  | 'macMismatch'
  | 'formatMismatch'
  | 'bindingKeyInvalid'
  | 'bindingKeyMismatch'
  | 'callerIdMismatch'
  | 'browserMismatch'
  | 'replayed'
  | 'expTooFar'

/** Which §9.2 downgrade row a ticket hit. Both map to the §5 `unverified` state. */
export type TicketDowngradeReason = 'unknownGeneration' | 'expired'

/**
 * The §6.5 obligation that §9.2's last two table rows defer out of
 * `pairHello`: whenever a ticket was presented, `confirmA.ticketProof` MUST be
 * a 64-byte Ed25519 signature over `"MBP1/ticket-proof/v1" ‖ TT` that verifies
 * under this `bindingPub` in the strict mode of §9.1. A proof that is not 64
 * bytes is a `protocolViolation`; a well-formed proof that fails to verify is
 * a `codeMismatch` that consumes an attempt (§6.5, §7.2). Neither outcome is
 * knowable at `pairHello`, so a non-abort verdict only names the obligation
 * and the key it must be discharged against.
 */
export interface DeferredTicketProof {
  bindingPub: Uint8Array
}

/**
 * The three dispositions of §9.2's exhaustive outcome table. `attested`
 * carries the *proven* caller identity; whether that identity is `official` or
 * `attested-non-official` is decided by the immutable allowlist (§5), never
 * here.
 */
export type TicketVerdict =
  | { kind: 'abort'; reason: TicketAbortReason }
  | {
      kind: 'downgrade'
      reason: TicketDowngradeReason
      deferredProof: DeferredTicketProof
    }
  | { kind: 'attested'; callerId: string; deferredProof: DeferredTicketProof }

/** Everything §9.2 compares a ticket against: the host secret, the live generation, the clock, and the `pairHello` fields. */
export interface TicketContext {
  localToken: string
  serverGeneration: string
  nowMs: number
  helloBrowser: string
  helloClaimedExtensionId: string
  /** Raw `pairHello.ticketBindingKey`, or `null` when the field was absent. */
  helloTicketBindingKey: Uint8Array | null
  replay: TicketReplayCache
}

/**
 * `ticketKey = HKDF-SHA-256(ikm=UTF8(localToken), salt="MBP1/nm-ticket/v1",
 * info="mac", L=32)` (§9.2). Depends on `localToken` alone, which is why
 * `localToken` MUST persist across bridge restarts: a rotated `localToken`
 * turns every outstanding honest ticket into a MAC abort instead of the
 * intended generation downgrade.
 */
export function deriveTicketKey(localToken: string): Uint8Array {
  return hkdf32(utf8ToBytes(localToken), TICKET_KEY_SALT, TICKET_KEY_INFO)
}

/**
 * `enc("mbp1-attestation") ‖ encU32BE(v) ‖ encU32BE(protocolVersion)
 *  ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId) ‖ encU64BE(exp)
 *  ‖ enc(bindingPub)` (§9.2).
 *
 * `purpose` is part of the parameter only because a ticket carries it on the
 * wire; the MAC covers the fixed domain tag instead, so the wire value cannot
 * change these bytes. §6.4's `ticketDigest` is what pins `purpose`.
 */
export function ticketMacInput(t: Omit<TicketWire, 'mac'>): Uint8Array {
  return concatBytes(
    MAC_DOMAIN_TAG,
    encU32BE(t.v),
    encU32BE(t.protocolVersion),
    enc(t.serverGeneration),
    enc(t.browser),
    enc(t.callerId),
    encU64BE(t.exp),
    enc(t.bindingPub)
  )
}

/**
 * §9.1 binding-key validation: a canonical RFC 8032 encoding of an
 * on-curve point that is not the identity, not of small order, and lies in
 * the prime-order subgroup.
 *
 * Skipping this check is what would turn the ticket into a bearer object:
 * `bindingPub` = identity together with `ticketProof` = (identity ‖ 0)
 * satisfies the group equation for *every* message, so possession of
 * `bindingPriv` would prove nothing.
 */
export function validateBindingPub(bytes: Uint8Array): boolean {
  if (bytes.length !== POINT_LENGTH) {
    return false
  }
  try {
    // `fromBytes` is the canonical RFC 8032 decode (it rejects `y >= p` and
    // off-curve encodings by throwing); `is0` is the identity test. The
    // identity is doubly covered, since `ord(identity) = 1` divides 8.
    const point = ed25519.Point.fromBytes(bytes)
    return !point.is0() && !point.isSmallOrder() && point.isTorsionFree()
  } catch {
    return false
  }
}

/**
 * Verifies a §6.5 `ticketProof`: an Ed25519 signature over
 * `"MBP1/ticket-proof/v1" ‖ TT` under `bindingPub`, in **RFC 8032 strict mode
 * (`zip215: false`)**. The permissive ZIP-215 default MUST NOT be used (§9.1):
 * it accepts non-canonical `R` encodings and the (identity ‖ 0) forgery that
 * strict mode rejects.
 *
 * Callers own the §6.5 disposition split, which this boolean cannot express: a
 * proof that is not `SIGNATURE_LENGTH` bytes is a `protocolViolation` and MUST
 * be rejected before this call, whereas `false` from a well-formed proof is a
 * `codeMismatch` that consumes an attempt. A wrong-length signature returns
 * `false` here only so a missed length check can never become a silent pass.
 *
 * `bindingPub` is *not* re-validated here: §9.2's binding-key row already
 * aborted the pairing before §6.5 can be reached, which is the normative order.
 * Strict mode independently rejects a small-order key, so the (identity ‖ 0)
 * bearer forgery fails here too rather than depending on that ordering.
 *
 * Conformance caveat (§9.1): noble's strict mode still checks the *cofactored*
 * equation, so a signer that legitimately knows `bindingPriv` can produce a
 * torsion-tweaked signature this accepts. That requires the private key, so it
 * is not a forgery and MBP1 does not rely on cofactorless equality.
 */
export function verifyTicketProofStrict(
  bindingPub: Uint8Array,
  tt: Uint8Array,
  sig: Uint8Array
): boolean {
  if (sig.length !== SIGNATURE_LENGTH) {
    return false
  }
  try {
    return ed25519.verify(sig, concatBytes(PROOF_LABEL, tt), bindingPub, {
      zip215: false,
    })
  } catch {
    return false
  }
}

/**
 * One-shot store for ticket MACs, keyed by the canonical base64url encoding of
 * the 32 MAC bytes (§9.2 replay row). Entries are retained until their
 * ticket's `exp` passes: after that the ticket can only resolve as the
 * `expired` downgrade, which grants no identity a ticketless peer would not
 * already get, so pruning cannot be used to raise an identity.
 *
 * **Scope is one process.** The one-shot guarantee does not survive a restart,
 * and nothing rescues it except `serverGeneration` rotating on every bridge
 * start: a ticket replayed into a later process downgrades to `unverified` on
 * the generation row, which is exactly what presenting no ticket at all yields.
 * A change that ever made `serverGeneration` persist across restarts would
 * therefore open a real one-shot replay window here and must restore a durable
 * cache in the same change.
 */
export class TicketReplayCache {
  private readonly seen = new Map<string, number>()

  has(macB64: string): boolean {
    return this.seen.has(macB64)
  }

  /**
   * Records a consumed MAC. Retention is clamped to
   * `min(expMs, nowMs + MAX_REMAINING_LIFETIME_MS)` because `add` runs *before*
   * the `expTooFar` row: without the clamp, a buggy or compromised host holding
   * `localToken` could mint tickets whose `exp` is centuries away and pin an
   * entry `prune` can never remove, growing the map for the life of the
   * process. The clamp costs nothing — a ticket beyond the remaining-lifetime
   * bound is aborted on the very next row and can never be honoured, so there
   * is no window in which forgetting it early admits anything.
   */
  add(macB64: string, expMs: number, nowMs: number): void {
    this.seen.set(macB64, Math.min(expMs, nowMs + MAX_REMAINING_LIFETIME_MS))
  }

  prune(nowMs: number): void {
    for (const [macB64, expMs] of this.seen) {
      if (expMs <= nowMs) {
        this.seen.delete(macB64)
      }
    }
  }
}

/** `exp` in seconds, bounded so `exp * 1000` stays an exact JS integer. */
const MAX_EXP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

/**
 * The wire shape of `pairHello.nmTicket` (§9.2). Structural only: the exact
 * `v` / `purpose` / `protocolVersion` values are a separate §9.2 row checked
 * *after* the MAC, so enforcing them here would preempt the normative order.
 * The integer bounds keep `ticketMacInput`'s encoders in range.
 *
 * Strict, because §9.2 states that every wire field except `mac` is MAC-covered
 * so that no field can be swapped independently. An unknown extra field would
 * be covered by neither the MAC nor §6.4's ticket digest, so accepting and
 * silently dropping one would weaken that invariant; a legitimate host — which
 * mints exactly these nine fields — never sends one.
 */
const ticketWireSchema = z
  .object({
    v: z.number().int().min(0).max(0xffff_ffff),
    purpose: z.string(),
    protocolVersion: z.number().int().min(0).max(0xffff_ffff),
    serverGeneration: z.string(),
    browser: z.string(),
    callerId: z.string(),
    exp: z.number().int().min(0).max(MAX_EXP_SECONDS),
    bindingPub: z.string(),
    mac: z.string(),
  })
  .strict()

interface ParsedTicket {
  ticket: TicketWire
  macInput: Uint8Array
}

/**
 * Parses the wire object into the field values §9.2 encodes, returning `null`
 * for anything that cannot be canonically decoded at all — a bad shape, a
 * padded or non-canonical base64url field, or a non-ASCII string field (§2).
 * This is the one rejection that necessarily precedes the MAC check: without
 * these bytes there is no MAC to recompute.
 */
function parseTicketWire(wire: unknown): ParsedTicket | null {
  const parsed = ticketWireSchema.safeParse(wire)
  if (!parsed.success) {
    return null
  }
  try {
    const ticket: TicketWire = {
      ...parsed.data,
      bindingPub: fromBase64Url(parsed.data.bindingPub),
      mac: fromBase64Url(parsed.data.mac),
    }
    return { ticket, macInput: ticketMacInput(ticket) }
  } catch {
    return null
  }
}

/** Constant-time byte equality; lengths are public, so an early length exit leaks nothing (§2). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function abort(reason: TicketAbortReason): TicketVerdict {
  return { kind: 'abort', reason }
}

/**
 * Applies §9.2's exhaustive outcome table to a presented `nmTicket`, in the
 * table's normative order — MAC first, then the format, binding-key, caller,
 * browser, replay, and lifetime abort rows, then the two downgrade rows.
 *
 * Called only when a ticket *was* presented: a caller that presents none is
 * unaffected and resolves its identity from the verified origin alone (§5).
 * A structural abort takes precedence over identity, so an abort verdict ends
 * the pairing even for a caller that the verified origin would make
 * `official`.
 */
export function verifyNmTicket(
  wire: unknown,
  ctx: TicketContext
): TicketVerdict {
  const parsed = parseTicketWire(wire)
  if (parsed === null) {
    return abort('schema')
  }
  const t = parsed.ticket

  // §9.2: the mac is verified first, before any semantic check.
  const expectedMac = hmacSha256(
    deriveTicketKey(ctx.localToken),
    parsed.macInput
  )
  if (!constantTimeEqual(t.mac, expectedMac)) {
    return abort('macMismatch')
  }

  if (
    t.v !== TICKET_VERSION ||
    t.purpose !== TICKET_PURPOSE ||
    t.protocolVersion !== TICKET_PROTOCOL_VERSION
  ) {
    return abort('formatMismatch')
  }

  if (!validateBindingPub(t.bindingPub)) {
    return abort('bindingKeyInvalid')
  }

  if (
    ctx.helloTicketBindingKey === null ||
    !constantTimeEqual(t.bindingPub, ctx.helloTicketBindingKey)
  ) {
    return abort('bindingKeyMismatch')
  }

  if (t.callerId !== ctx.helloClaimedExtensionId) {
    return abort('callerIdMismatch')
  }

  if (t.browser !== ctx.helloBrowser) {
    return abort('browserMismatch')
  }

  const expMs = t.exp * 1000
  const macKey = toBase64Url(t.mac)
  ctx.replay.prune(ctx.nowMs)
  if (ctx.replay.has(macKey)) {
    return abort('replayed')
  }
  // Consumed at the table's replay position: every preceding abort row has
  // passed, so the ticket has been used even if a later row rejects it.
  ctx.replay.add(macKey, expMs, ctx.nowMs)

  if (expMs > ctx.nowMs + MAX_REMAINING_LIFETIME_MS) {
    return abort('expTooFar')
  }

  const deferredProof: DeferredTicketProof = { bindingPub: t.bindingPub }

  if (t.serverGeneration !== ctx.serverGeneration) {
    return { kind: 'downgrade', reason: 'unknownGeneration', deferredProof }
  }

  if (expMs <= ctx.nowMs) {
    return { kind: 'downgrade', reason: 'expired', deferredProof }
  }

  return { kind: 'attested', callerId: t.callerId, deferredProof }
}
