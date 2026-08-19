// MBP1 transcript identities, AAD, and ticket digest
// (docs/bridge-pairing-protocol.md §6.4).
//
// `buildTT` in `spake2-core.ts` already owns the TT byte layout; this module
// supplies the identity byte strings (`A_id`, `B_id`) it composes, plus the
// AAD and ticket digest bound into confirmation via `keySchedule`. Nothing
// here is secret on its own, but a ticket digest and AAD feed directly into
// key confirmation, so getting the field order wrong silently desynchronizes
// both parties rather than throwing.

import { createHash } from 'node:crypto'
import { concatBytes, enc, encU32BE, encU64BE } from './canonical'

const A_ID_LABEL = 'MBP1/A/v1'
const B_ID_LABEL = 'MBP1/B/v1'
const B_ID_ROLE = 'motrix-bridge'
const EMPTY = ''

/** `A_id = enc("MBP1/A/v1") ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(claimedExtensionId) ‖ enc(clientInstallationId)` (§6.4). */
export function buildAId(f: {
  browser: string
  verifiedOrigin: string
  claimedExtensionId: string
  clientInstallationId: string
}): Uint8Array {
  return concatBytes(
    enc(A_ID_LABEL),
    enc(f.browser),
    enc(f.verifiedOrigin),
    enc(f.claimedExtensionId),
    enc(f.clientInstallationId)
  )
}

/** `B_id = enc("MBP1/B/v1") ‖ enc("motrix-bridge") ‖ enc(instanceId)` (§6.4). */
export function buildBId(instanceId: string): Uint8Array {
  return concatBytes(enc(B_ID_LABEL), enc(B_ID_ROLE), enc(instanceId))
}

/**
 * The parsed values of every wire field of an `nmTicket` (§9.2), used to
 * compute the AAD's `ticketDigest` (§6.4). `bindingPub` and `mac` are the raw
 * bytes their base64url wire encodings decode to.
 */
export interface TicketWire {
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
 * `ticketDigest = SHA-256(encU32BE(v) ‖ enc(purpose) ‖ encU32BE(protocolVersion)
 *   ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId) ‖ encU64BE(exp)
 *   ‖ enc(bindingPub) ‖ enc(mac))` (§6.4).
 *
 * This hashes the **wire `purpose` string** as received, not the fixed
 * `"mbp1-attestation"` domain tag the §9.2 MAC input hard-codes — that
 * deliberate difference is what makes flipping `purpose` (or any other wire
 * field, including `mac` itself) change the digest and fail key confirmation
 * closed, rather than being absorbed by a MAC that never covers `purpose`.
 */
export function ticketDigest(t: TicketWire): Uint8Array {
  const data = concatBytes(
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
  return new Uint8Array(createHash('sha256').update(data).digest())
}

/**
 * `AAD = encU32BE(protocolVersion) ‖ enc(pairNonce) ‖ enc(ticketBindingKeyOrEmpty)
 *   ‖ enc(ticketDigestOrEmpty)` (§6.4). `ticketBindingKey` and `digest` are
 * `null` when no `nmTicket` was presented, encoding as `enc("")` — the empty
 * string, not an absent field — so both parties compute the same AAD length
 * either way.
 */
export function buildAad(
  protocolVersion: number,
  pairNonce: string,
  ticketBindingKey: Uint8Array | null,
  digest: Uint8Array | null
): Uint8Array {
  return concatBytes(
    encU32BE(protocolVersion),
    enc(pairNonce),
    enc(ticketBindingKey ?? EMPTY),
    enc(digest ?? EMPTY)
  )
}
