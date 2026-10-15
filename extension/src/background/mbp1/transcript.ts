/**
 * MBP1 transcript identity strings, PAKE AAD, and NM-ticket digest
 * (bridge-pairing-protocol.md §6.4, cross-referenced against §9.2).
 *
 * `buildAId`/`buildBId` produce the identity byte strings that feed
 * `spake2Run`'s `aId`/`bId` parameters (spake2-core.ts already owns the
 * `TT = enc(aId) ‖ enc(bId) ‖ ...` transcript *layout*) — this module owns
 * only their construction, so transcript assembly has exactly one home and
 * is never duplicated between the two files.
 *
 * `ticketDigest` deliberately hashes the wire `purpose` string rather than
 * a fixed domain tag. §9.2's ticket MAC canonical input uses a *different*
 * construction that fixes `purpose` to the constant `"mbp1-attestation"`
 * instead of the parsed field — the two are intentionally distinct so that
 * tampering `purpose` in transit is caught here even though it would not
 * change the §9.2 MAC input. See `__tests__/transcript.test.ts` for the
 * negative test that proves this module hashes the field, not the tag.
 *
 * Every value this module touches feeds key confirmation or ticket
 * validation and MUST NOT be logged at any level (§11), including the
 * identity strings, `ticketBindingKey`, ticket fields, and the digest
 * itself.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import {
  concatBytes,
  enc,
  encU32BE,
  encU64BE,
} from '@/background/mbp1/canonical'

const EMPTY_BYTES = new Uint8Array(0)

/** `A_id = enc("MBP1/A/v1") ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(claimedExtensionId) ‖ enc(clientInstallationId)` (§6.4). */
export function buildAId(a: {
  browser: string
  verifiedOrigin: string
  claimedExtensionId: string
  clientInstallationId: string
}): Uint8Array {
  return concatBytes(
    enc('MBP1/A/v1'),
    enc(a.browser),
    enc(a.verifiedOrigin),
    enc(a.claimedExtensionId),
    enc(a.clientInstallationId)
  )
}

/** `B_id = enc("MBP1/B/v1") ‖ enc("motrix-bridge") ‖ enc(instanceId)` (§6.4). */
export function buildBId(instanceId: string): Uint8Array {
  return concatBytes(enc('MBP1/B/v1'), enc('motrix-bridge'), enc(instanceId))
}

/**
 * The NM ticket's wire fields, already parsed into their canonical types
 * (§6.4: "the parsed values of every ticket field" — `v` and
 * `protocolVersion` as integers, `exp` as an integer, strings as UTF-8, and
 * `bindingPub`/`mac` as the raw bytes their base64url wire encoding decodes
 * to). This is the ticket's own `protocolVersion` field (`ticketProtocolVersion`
 * on the wire per §9.2), not the pairing protocol version passed alongside
 * it in `buildAad`.
 */
export interface ParsedTicket {
  v: number
  purpose: string
  protocolVersion: number
  serverGeneration: string
  browser: string
  callerId: string
  exp: number
  bindingPub: Uint8Array
  mac: Uint8Array
}

/**
 * `ticketDigest = SHA-256(encU32BE(v) ‖ enc(purpose) ‖ encU32BE(ticketProtocolVersion) ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId) ‖ encU64BE(exp) ‖ enc(bindingPub) ‖ enc(mac))` (§6.4).
 *
 * `bindingPub` and `mac` are hashed as their raw decoded bytes, not the
 * base64url wire spelling.
 */
export function ticketDigest(t: ParsedTicket): Uint8Array {
  return sha256(
    concatBytes(
      encU32BE(t.v),
      enc(t.purpose),
      encU32BE(t.protocolVersion),
      enc(t.serverGeneration),
      enc(t.browser),
      enc(t.callerId),
      encU64BE(t.exp),
      enc(t.bindingPub),
      enc(t.mac)
    )
  )
}

/**
 * `AAD = encU32BE(protocolVersion) ‖ enc(pairNonce) ‖ enc(ticketBindingKeyOrEmpty) ‖ enc(ticketDigestOrEmpty)` (§6.4),
 * bound into confirmation-key derivation via `spake2Run`'s `aad` parameter.
 *
 * `ticketBindingKey`/`ticket` are both `null` for a ticketless attempt; each
 * then contributes a zero-length `enc()` slot (an 8-byte zero length prefix
 * and no payload) rather than being omitted, so the AAD's field count and
 * order never depend on whether a ticket was presented.
 */
export function buildAad(args: {
  protocolVersion: number
  pairNonce: string
  ticketBindingKey: Uint8Array | null
  ticket: ParsedTicket | null
}): Uint8Array {
  return concatBytes(
    encU32BE(args.protocolVersion),
    enc(args.pairNonce),
    enc(args.ticketBindingKey ?? EMPTY_BYTES),
    enc(args.ticket ? ticketDigest(args.ticket) : EMPTY_BYTES)
  )
}
