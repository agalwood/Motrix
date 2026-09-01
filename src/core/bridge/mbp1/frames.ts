// MBP1 pre-channel wire frames (docs/bridge-pairing-protocol.md §6.1, §6.7,
// §8, §11).
//
// Every message exchanged before the AEAD channel activates — and the three
// §6.7 credential messages that travel inside it — is a single WebSocket text
// frame carrying exactly one JSON object with a `type` discriminator, with
// binary fields base64url-encoded (§6.1). This module is the single source of
// truth for those shapes; `pair-session.ts` and `reconnect-session.ts` parse
// and emit through it rather than hand-rolling field checks.
//
// Three deliberate choices:
//
//   1. **Binary fields stay base64url strings in the inferred types.** The
//      schemas *validate* that a field decodes canonically to its exact
//      expected length (via `fromBase64Url`, which rejects padding,
//      non-alphabet characters, and non-canonical trailing bits), but they do
//      not transform. Keeping the parsed shape identical to the wire shape in
//      both directions means one schema describes both what the server accepts
//      and what it emits, and it keeps `sendText(json)` a plain JSON object.
//
//   2. **`protocolVersion` is NOT a `z.literal(1)`.** §11 gives a wrong version
//      its own code, `unsupportedVersion`, distinct from `protocolViolation`.
//      Pinning the literal here would collapse the two and turn a
//      version-2 client's clean "no negotiation" rejection into a malformed
//      frame report.
//
//   3. **Inbound object schemas are strict.** MBP1 has no negotiation (§3), and
//      §6.1 requires schema-invalid JSON to abort. An unrecognized field is
//      covered by neither the transcript nor the AAD (§6.4), so silently
//      dropping one would weaken the misbinding property.
//
// Nothing here logs: `pairHello` carries a ticket and `credentialOffer`
// carries key material (§11).

import type { Browser } from '@shared/protocol/bridge'
import { z } from 'zod'
import { fromBase64Url } from './canonical'

/** The only `protocolVersion` MBP1 v1 speaks (§3). */
export const MBP1_PROTOCOL_VERSION = 1

/** Maximum size of a pre-authentication frame, in bytes (§6.1). */
export const MAX_PRE_AUTH_FRAME_BYTES = 16 * 1024

const POINT_BYTES = 32
const MAC_BYTES = 32
const SIGNATURE_BYTES = 64
const KEY_BYTES = 32
const NONCE_BYTES = 32

/** `exp` in seconds, bounded so `exp * 1000` stays an exact JS integer. */
const MAX_EXP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      return false
    }
  }
  return true
}

/**
 * A string field that reaches `enc()` (§2) and therefore must be ASCII-only.
 * `enc` throws `ProtocolViolationError` on a non-ASCII string, so rejecting it
 * at the schema turns a would-be exception deep inside transcript
 * construction into an ordinary `protocolViolation` at frame parse time.
 */
const asciiString = () =>
  z.string().refine(isAscii, { message: 'must be ASCII-only' })

/**
 * A base64url field decoding to exactly `byteLength` bytes (§2, §6.1). Length
 * is part of the wire shape for every binary field MBP1 defines — points,
 * MACs, keys, nonces, and signatures all have fixed widths — so a wrong-length
 * field is a malformed frame, not a cryptographic failure to be reported as
 * one.
 */
const base64UrlBytes = (byteLength: number) =>
  z.string().refine(
    (s) => {
      try {
        return fromBase64Url(s).length === byteLength
      } catch {
        return false
      }
    },
    { message: `must be canonical base64url of exactly ${byteLength} bytes` }
  )

const protocolVersionField = z.number().int().min(0).max(0xffff_ffff)

const browserField: z.ZodType<Browser> = z.enum(['chromium', 'firefox'])

/**
 * The `pairHello.nmTicket` wire shape (§9.2), used **only** to recover the
 * parsed field values §6.4's `ticketDigest` hashes.
 *
 * `ticket-verify.ts` owns ticket validation and keeps its own strict schema;
 * this one is a reader, applied after `verifyNmTicket` has already returned a
 * non-abort verdict. That ordering is what keeps the duplication safe: the
 * authoritative accept/reject decision is made in exactly one place, and this
 * schema never gets to admit a ticket that module rejected.
 */
export const nmTicketWireSchema = z
  .object({
    v: z.number().int().min(0).max(0xffff_ffff),
    purpose: asciiString(),
    protocolVersion: z.number().int().min(0).max(0xffff_ffff),
    serverGeneration: asciiString(),
    browser: asciiString(),
    callerId: asciiString(),
    exp: z.number().int().min(0).max(MAX_EXP_SECONDS),
    bindingPub: z.string(),
    mac: z.string(),
  })
  .strict()

export type NmTicketWire = z.infer<typeof nmTicketWireSchema>

/**
 * `pairHello` (A→B, §6.1). `nmTicket` stays `unknown` so the raw object
 * reaches `verifyNmTicket` untouched — §9.2's outcome table, not this schema,
 * decides whether a presented ticket aborts the pairing.
 *
 * `ticketBindingKey` is "required iff `nmTicket` present" (§6.1), enforced in
 * both directions: a ticket without its binding key cannot satisfy §9.2's
 * binding-key row, and a binding key without a ticket would make §6.4's
 * `ticketBindingKeyOrEmpty` ambiguous.
 */
export const pairHelloFrameSchema = z
  .object({
    type: z.literal('pairHello'),
    protocolVersion: protocolVersionField,
    browser: browserField,
    claimedExtensionId: asciiString(),
    clientInstallationId: asciiString(),
    nmTicket: z.unknown().optional(),
    ticketBindingKey: base64UrlBytes(KEY_BYTES).optional(),
  })
  .strict()
  .refine(
    (f) => (f.nmTicket === undefined) === (f.ticketBindingKey === undefined),
    {
      message:
        'ticketBindingKey is required if and only if nmTicket is present',
    }
  )

export type PairHelloFrame = z.infer<typeof pairHelloFrameSchema>

/**
 * `pairAccept` (B→A, §6.1). Sent when the dialog is queued; it carries **no**
 * approval semantics — only successful key confirmation proves the user
 * approved.
 */
export const pairAcceptFrameSchema = z
  .object({
    type: z.literal('pairAccept'),
    protocolVersion: protocolVersionField,
    instanceId: asciiString(),
  })
  .strict()

export type PairAcceptFrame = z.infer<typeof pairAcceptFrameSchema>

/** `pakeA` (A→B, §6.1): A's SPAKE2 public share. */
export const pakeAFrameSchema = z
  .object({
    type: z.literal('pakeA'),
    pA: base64UrlBytes(POINT_BYTES),
  })
  .strict()

export type PakeAFrame = z.infer<typeof pakeAFrameSchema>

/** `pakeB` (B→A, §6.1): B's SPAKE2 public share. */
export const pakeBFrameSchema = z
  .object({
    type: z.literal('pakeB'),
    pB: base64UrlBytes(POINT_BYTES),
  })
  .strict()

export type PakeBFrame = z.infer<typeof pakeBFrameSchema>

/**
 * `confirmA` (A→B, §6.1, §6.5). `ticketProof` is required iff an `nmTicket`
 * was sent in `pairHello`; that cross-frame condition is enforced by the
 * session, which is the only party that remembers whether a ticket was
 * presented. Its 64-byte length is enforced here, so a wrong-length proof is a
 * `protocolViolation` rather than reaching the verifier as a `codeMismatch`
 * (§6.5).
 */
export const confirmAFrameSchema = z
  .object({
    type: z.literal('confirmA'),
    cA: base64UrlBytes(MAC_BYTES),
    ticketProof: base64UrlBytes(SIGNATURE_BYTES).optional(),
  })
  .strict()

export type ConfirmAFrame = z.infer<typeof confirmAFrameSchema>

/** `confirmB` (B→A, §6.1, §6.5). */
export const confirmBFrameSchema = z
  .object({
    type: z.literal('confirmB'),
    cB: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type ConfirmBFrame = z.infer<typeof confirmBFrameSchema>

/**
 * `credentialOffer` (B→A, §6.7 step 1). Travels inside the AEAD envelope. The
 * server persists the credential durably in state `provisional` **before**
 * sending this.
 */
export const credentialOfferFrameSchema = z
  .object({
    type: z.literal('credentialOffer'),
    credentialId: asciiString(),
    mutualKey: base64UrlBytes(KEY_BYTES),
  })
  .strict()

export type CredentialOfferFrame = z.infer<typeof credentialOfferFrameSchema>

/** `credentialAck` (A→B, §6.7 step 2). Travels inside the AEAD envelope. */
export const credentialAckFrameSchema = z
  .object({
    type: z.literal('credentialAck'),
    credentialId: asciiString(),
  })
  .strict()

export type CredentialAckFrame = z.infer<typeof credentialAckFrameSchema>

/** `credentialCommitted` (B→A, §6.7 step 3). Travels inside the AEAD envelope. */
export const credentialCommittedFrameSchema = z
  .object({
    type: z.literal('credentialCommitted'),
  })
  .strict()

export type CredentialCommittedFrame = z.infer<
  typeof credentialCommittedFrameSchema
>

/** `reconnectChallenge` (B→A, §8). The server speaks first on `/v1`. */
export const reconnectChallengeFrameSchema = z
  .object({
    type: z.literal('reconnectChallenge'),
    protocolVersion: protocolVersionField,
    S: base64UrlBytes(NONCE_BYTES),
  })
  .strict()

export type ReconnectChallengeFrame = z.infer<
  typeof reconnectChallengeFrameSchema
>

/** `reconnectResponse` (A→B, §8). */
export const reconnectResponseFrameSchema = z
  .object({
    type: z.literal('reconnectResponse'),
    credentialId: asciiString(),
    C: base64UrlBytes(NONCE_BYTES),
    mac: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type ReconnectResponseFrame = z.infer<
  typeof reconnectResponseFrameSchema
>

/** `reconnectAccept` (B→A, §8). */
export const reconnectAcceptFrameSchema = z
  .object({
    type: z.literal('reconnectAccept'),
    mac: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type ReconnectAcceptFrame = z.infer<typeof reconnectAcceptFrameSchema>

/**
 * The §11 error codes. Beyond `codeMismatch`/`attemptsRemaining`, which the
 * user needs, a `pairError` MUST NOT reveal which internal step failed — so
 * these codes are the entire vocabulary, and no free-form detail field exists
 * to leak one.
 */
export const PAIR_ERROR_CODES = [
  'unsupportedVersion',
  'busy',
  'rateLimited',
  'codeMismatch',
  'expired',
  'denied',
  'aborted',
  'authFailed',
  'protocolViolation',
  'pairingFailed',
] as const

export type PairErrorCode = (typeof PAIR_ERROR_CODES)[number]

/** `pairError` (B→A, §11). Pre-channel only. */
export const pairErrorFrameSchema = z
  .object({
    type: z.literal('pairError'),
    code: z.enum(PAIR_ERROR_CODES),
    attemptsRemaining: z.number().int().min(0).optional(),
  })
  .strict()

export type PairErrorFrame = z.infer<typeof pairErrorFrameSchema>

/**
 * The discriminator envelope every pre-channel frame shares (§6.1): one JSON
 * object with a string `type`. A frame that does not even reach this shape —
 * a JSON array, a bare string, `null` — is malformed, and an unrecognized
 * `type` aborts with `protocolViolation`. Sessions parse this first so they
 * can distinguish "unknown message type" from "known type, invalid body"
 * before dispatching to the specific schema above.
 */
export const frameEnvelopeSchema = z.object({ type: z.string() })
