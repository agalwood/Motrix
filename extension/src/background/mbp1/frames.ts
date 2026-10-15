/**
 * MBP1 pre-channel wire frames, client side (bridge-pairing-protocol.md §6.1,
 * §6.7, §8, §11).
 *
 * Every message exchanged before the AEAD channel activates — and the three
 * §6.7 credential messages that travel inside it — is a single WebSocket
 * **text** frame carrying exactly one JSON object with a `type` discriminator,
 * with binary fields base64url-encoded (§6.1). This module is the single source
 * of truth for those shapes on this side of the wire; `pairing-flow.ts` and
 * `reconnect-flow.ts` emit and parse through it rather than hand-rolling field
 * checks.
 *
 * ## Two rules that break pairings silently
 *
 * 1. **Every schema is `.strict()`, on both sides.** Line A's schemas are
 *    strict, so one extra property anywhere is a `protocolViolation` and the
 *    pairing dies rather than tolerating an unknown field. Outbound frames are
 *    therefore built *and then validated against the same schema* before they
 *    are sent (`buildX` helpers below), so an accidental extra or missing
 *    property is a local, diagnosable throw instead of a socket the peer closes
 *    with 1002. This mirrors Line A, which self-checks every frame it emits.
 *
 * 2. **`protocolVersion` is present on some frames and absent on others.** It
 *    is NOT a uniform envelope field: `pairHello`, `pairAccept` and
 *    `reconnectChallenge` carry it, while `pakeA`/`pakeB`,
 *    `confirmA`/`confirmB`, all three credential frames, `pairError`,
 *    **`reconnectResponse`** and `reconnectAccept` do not. Adding it where it
 *    does not belong is an extra property, so it fails rule 1.
 *
 * `protocolVersion` is deliberately not `z.literal(1)` on the frames that do
 * carry it: §11 gives a wrong version its own code, `unsupportedVersion`,
 * distinct from `protocolViolation`. Pinning the literal here would collapse
 * the two, so the version check is a separate step (`assertProtocolVersion`)
 * that reports the right code.
 *
 * ## Parse order
 *
 * `parseServerFrame` mirrors Line A's order exactly: the discriminator envelope
 * (`{type: string}`) first, then the specific schema. That is what lets both
 * sides distinguish "this payload is not even a frame" from "unknown message
 * type" from "known type, invalid body" — and it keeps the client's own error
 * reporting able to make the same distinction the server's does.
 *
 * Nothing here logs (§11): `pairHello` carries a ticket, `credentialOffer`
 * carries key material, and even a `pairError` code must not be logged.
 */
import { z } from 'zod'
import { b64uDecode } from '@/background/mbp1/canonical'
import type { ParsedTicket } from '@/background/mbp1/transcript'

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
    if (s.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/**
 * A string field that reaches `enc()` (§2) and therefore must be ASCII-only.
 * `enc` throws on a non-ASCII string, so rejecting it at the schema turns a
 * would-be exception deep inside transcript construction into an ordinary
 * frame-parse failure.
 */
const asciiString = (): z.ZodType<string> =>
  z.string().refine(isAscii, { message: 'must be ASCII-only' })

/**
 * A base64url field decoding **canonically** to exactly `byteLength` bytes
 * (§2, §6.1). `b64uDecode` rejects `=` padding, standard-base64 `+`/`/`, an
 * impossible length, and a final character whose unused low bits are nonzero —
 * the same three rejections Line A's decoder makes, so a value this accepts is
 * a value the peer accepts.
 *
 * Length is part of the wire shape for every binary field MBP1 defines, so a
 * wrong-length field is a malformed frame rather than a cryptographic failure
 * to be reported as one.
 */
const base64UrlBytes = (byteLength: number): z.ZodType<string> =>
  z.string().refine(
    (s) => {
      try {
        return b64uDecode(s).length === byteLength
      } catch {
        return false
      }
    },
    { message: `must be canonical base64url of exactly ${byteLength} bytes` }
  )

const protocolVersionField = z.number().int().min(0).max(0xffff_ffff)

const browserField = z.enum(['chromium', 'firefox', 'safari'])

export type Mbp1Browser = z.infer<typeof browserField>

export function isMbp1Browser(value: unknown): value is Mbp1Browser {
  return browserField.safeParse(value).success
}

// -- client -> server ------------------------------------------------------

/**
 * `pairHello` (A→B, §6.1) — the first frame on `/pair`, and where identity now
 * lives. `/pair` carries only `?nonce=`; the old query-parameter identity is
 * gone, and `extensionName`/`extensionVersion` have no home here at all.
 *
 * `nmTicket` stays `unknown` so the host's ticket object travels **byte-for-byte
 * unmodified** — the client never rewrites, normalizes, or drops it (§9.2, and
 * see `pairing-flow.ts` on why dropping one is worse than sending it).
 *
 * The refinement is the "required iff" rule Line A enforces with the same
 * wording: a ticketless attempt omits **both** fields — not `null`, not an
 * empty string.
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

/** `pakeA` (A→B, §6.1): A's SPAKE2 public share. No `protocolVersion`. */
export const pakeAFrameSchema = z
  .object({
    type: z.literal('pakeA'),
    pA: base64UrlBytes(POINT_BYTES),
  })
  .strict()

export type PakeAFrame = z.infer<typeof pakeAFrameSchema>

/**
 * `confirmA` (A→B, §6.1, §6.5). No `protocolVersion`.
 *
 * `ticketProof` is required **iff** an `nmTicket` was sent in `pairHello`. That
 * cross-frame condition cannot live in a schema — only the session remembers
 * whether a ticket was presented — so `pairing-flow.ts` enforces it and Line
 * A's session enforces the mirror. The 64-byte length *is* enforced here, which
 * is why a wrong-length proof is a `protocolViolation` rather than surfacing as
 * a `codeMismatch`.
 */
export const confirmAFrameSchema = z
  .object({
    type: z.literal('confirmA'),
    cA: base64UrlBytes(MAC_BYTES),
    ticketProof: base64UrlBytes(SIGNATURE_BYTES).optional(),
  })
  .strict()

export type ConfirmAFrame = z.infer<typeof confirmAFrameSchema>

/**
 * `credentialAck` (A→B, §6.7 step 2). Travels inside the AEAD envelope.
 *
 * The server compares the echoed `credentialId` against the one it offered, so
 * it must be echoed back exactly.
 */
export const credentialAckFrameSchema = z
  .object({
    type: z.literal('credentialAck'),
    credentialId: asciiString(),
  })
  .strict()

export type CredentialAckFrame = z.infer<typeof credentialAckFrameSchema>

/**
 * `reconnectResponse` (A→B, §8).
 *
 * **Carries no `protocolVersion`** — the single easiest frame to get wrong,
 * because `reconnectChallenge` (the frame it answers) does carry one. Adding it
 * here is an extra property against Line A's strict schema and kills the
 * reconnect.
 */
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

// -- server -> client ------------------------------------------------------

/**
 * `pairAccept` (B→A, §6.1) — sent when the server has **queued the approval
 * dialog**, and carrying **no approval semantics whatsoever**.
 *
 * Line A's own comment is explicit that it "carries no approval semantics —
 * only successful key confirmation proves the user approved". The user may
 * still be looking at the dialog, or may dismiss it. So nothing may be
 * persisted on the strength of this frame and no UI state may read "connected",
 * "approved" or "paired" — the only proof of approval is a `confirmB` that
 * verifies.
 *
 * `instanceId` is the §4.1 routing hint, never a security signal.
 */
export const pairAcceptFrameSchema = z
  .object({
    type: z.literal('pairAccept'),
    protocolVersion: protocolVersionField,
    instanceId: asciiString(),
  })
  .strict()

export type PairAcceptFrame = z.infer<typeof pairAcceptFrameSchema>

/** `pakeB` (B→A, §6.1): B's SPAKE2 public share. */
export const pakeBFrameSchema = z
  .object({
    type: z.literal('pakeB'),
    pB: base64UrlBytes(POINT_BYTES),
  })
  .strict()

export type PakeBFrame = z.infer<typeof pakeBFrameSchema>

/** `confirmB` (B→A, §6.1, §6.5). */
export const confirmBFrameSchema = z
  .object({
    type: z.literal('confirmB'),
    cB: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type ConfirmBFrame = z.infer<typeof confirmBFrameSchema>

/**
 * `credentialOffer` (B→A, §6.7 step 1). Travels inside the AEAD envelope.
 *
 * `mutualKey` stays the base64url string all the way into `CredentialStore`; it
 * is never decoded at the storage layer.
 */
export const credentialOfferFrameSchema = z
  .object({
    type: z.literal('credentialOffer'),
    credentialId: asciiString(),
    mutualKey: base64UrlBytes(KEY_BYTES),
  })
  .strict()

export type CredentialOfferFrame = z.infer<typeof credentialOfferFrameSchema>

/** `credentialCommitted` (B→A, §6.7 step 3). No payload, inside the envelope. */
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

/** `reconnectAccept` (B→A, §8). No `protocolVersion`. */
export const reconnectAcceptFrameSchema = z
  .object({
    type: z.literal('reconnectAccept'),
    mac: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type ReconnectAcceptFrame = z.infer<typeof reconnectAcceptFrameSchema>

/**
 * The §11 error codes — the entire vocabulary, with no free-form detail
 * field. Beyond `codeMismatch`/`attemptsRemaining`, which the user genuinely
 * needs, a `pairError` must not reveal which internal step failed, which is
 * why no message field exists to parse. `denied` is deliberately distinct
 * from `aborted`: only the former records an operator refusal, while the
 * latter also covers transport/session teardown.
 */
export const PAIR_ERROR_CODES = [
  'unsupportedVersion',
  'busy',
  'rateLimited',
  'codeMismatch',
  'expired',
  'aborted',
  'denied',
  'authFailed',
  'protocolViolation',
  'pairingFailed',
] as const

export type PairErrorCode = (typeof PAIR_ERROR_CODES)[number]

/**
 * `pairError` (B→A, §11). **Pre-channel only** — it never appears inside the
 * AEAD envelope.
 *
 * `attemptsRemaining` is untrusted display data: the client enforces its own
 * §6.5 ceiling and its own §7.3 backoff regardless of what this says.
 */
export const pairErrorFrameSchema = z
  .object({
    type: z.literal('pairError'),
    code: z.enum(PAIR_ERROR_CODES),
    attemptsRemaining: z.number().int().min(0).optional(),
  })
  .strict()

export type PairErrorFrame = z.infer<typeof pairErrorFrameSchema>

/**
 * The `pairHello.nmTicket` wire shape (§9.2), used **only** to recover the
 * parsed field values §6.4's `ticketDigest` hashes. The client never validates
 * a ticket — that is the server's job (§9.2) — it only re-encodes what it
 * parsed so both sides compute the same AAD.
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
    bindingPub: base64UrlBytes(KEY_BYTES),
    mac: base64UrlBytes(MAC_BYTES),
  })
  .strict()

export type NmTicketWire = z.infer<typeof nmTicketWireSchema>

/**
 * The discriminator envelope every pre-channel frame shares (§6.1): one JSON
 * object with a string `type`.
 */
const frameEnvelopeSchema = z.object({ type: z.string() })

// -- errors ----------------------------------------------------------------

/**
 * Why a frame could not be turned into a usable message.
 *
 * - `malformed` — the payload never reached "object with a string `type`" (a
 *   JSON array, a bare string, `null`, unparseable JSON, an oversize frame).
 * - `unknownType` — a well-formed envelope naming a `type` this side does not
 *   accept here.
 * - `invalidBody` — a known `type` whose body failed its schema.
 * - `unsupportedVersion` — a `protocolVersion` other than 1. Kept distinct
 *   because §11 gives it its own code; treating it as a generic violation on
 *   the client side loses the one thing the user could act on.
 */
export type FrameErrorKind =
  | 'malformed'
  | 'unknownType'
  | 'invalidBody'
  | 'unsupportedVersion'

export class FrameError extends Error {
  readonly kind: FrameErrorKind

  constructor(kind: FrameErrorKind, message: string) {
    super(message)
    this.name = 'FrameError'
    this.kind = kind
  }
}

// -- outbound builders -----------------------------------------------------

/**
 * Validates a frame this side is about to emit against its own schema, and
 * returns it as a plain JSON object.
 *
 * Self-checking outbound frames is what makes the "one schema describes both
 * directions" claim literally true, and it is the cheapest possible guard
 * against the failure mode this whole module exists to prevent: Line A's
 * schemas are strict, so a stray property would come back as a socket closed
 * with `protocolViolation` and no indication of which field was wrong.
 */
function validateOutbound<T>(schema: z.ZodType<T>, frame: unknown): T {
  const parsed = schema.safeParse(frame)
  if (!parsed.success) {
    // The message names the frame type and the failing path only — never a
    // field *value*, which for these frames is key material (§11).
    throw new FrameError(
      'invalidBody',
      `refusing to send a frame that fails its own schema: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`
    )
  }
  return parsed.data
}

/**
 * Builds `pairHello`. `nmTicket` and `ticketBindingKey` are both present or
 * both absent — passing one alone throws here rather than at the peer.
 *
 * `nmTicket` is passed through exactly as received from the host.
 */
export function buildPairHello(args: {
  browser: Mbp1Browser
  claimedExtensionId: string
  clientInstallationId: string
  nmTicket?: unknown
  ticketBindingKey?: string
}): PairHelloFrame {
  // Built by explicit assignment rather than by spreading optionals: under
  // `exactOptionalPropertyTypes` an explicit `nmTicket: undefined` is a
  // *present* key with an undefined value, which `JSON.stringify` drops but
  // `.strict()` and the refinement above both see. Only genuinely absent keys
  // produce a ticketless frame.
  const frame: Record<string, unknown> = {
    type: 'pairHello',
    protocolVersion: MBP1_PROTOCOL_VERSION,
    browser: args.browser,
    claimedExtensionId: args.claimedExtensionId,
    clientInstallationId: args.clientInstallationId,
  }
  if (args.nmTicket !== undefined) frame.nmTicket = args.nmTicket
  if (args.ticketBindingKey !== undefined) {
    frame.ticketBindingKey = args.ticketBindingKey
  }
  return validateOutbound(pairHelloFrameSchema, frame)
}

/** Builds `pakeA`. */
export function buildPakeA(pA: string): PakeAFrame {
  return validateOutbound(pakeAFrameSchema, { type: 'pakeA', pA })
}

/** Builds `confirmA`, with `ticketProof` present iff one was supplied. */
export function buildConfirmA(cA: string, ticketProof?: string): ConfirmAFrame {
  const frame: Record<string, unknown> = { type: 'confirmA', cA }
  if (ticketProof !== undefined) frame.ticketProof = ticketProof
  return validateOutbound(confirmAFrameSchema, frame)
}

/** Builds `credentialAck`, echoing the offered `credentialId` exactly. */
export function buildCredentialAck(credentialId: string): CredentialAckFrame {
  return validateOutbound(credentialAckFrameSchema, {
    type: 'credentialAck',
    credentialId,
  })
}

/** Builds `reconnectResponse`. Note: no `protocolVersion`. */
export function buildReconnectResponse(args: {
  credentialId: string
  C: string
  mac: string
}): ReconnectResponseFrame {
  return validateOutbound(reconnectResponseFrameSchema, {
    type: 'reconnectResponse',
    credentialId: args.credentialId,
    C: args.C,
    mac: args.mac,
  })
}

// -- inbound parsing -------------------------------------------------------

/** Every frame this client accepts from the server. */
export type ServerFrame =
  | PairAcceptFrame
  | PakeBFrame
  | ConfirmBFrame
  | CredentialOfferFrame
  | CredentialCommittedFrame
  | ReconnectChallengeFrame
  | ReconnectAcceptFrame
  | PairErrorFrame

const SERVER_FRAME_SCHEMAS = {
  pairAccept: pairAcceptFrameSchema,
  pakeB: pakeBFrameSchema,
  confirmB: confirmBFrameSchema,
  credentialOffer: credentialOfferFrameSchema,
  credentialCommitted: credentialCommittedFrameSchema,
  reconnectChallenge: reconnectChallengeFrameSchema,
  reconnectAccept: reconnectAcceptFrameSchema,
  pairError: pairErrorFrameSchema,
} as const satisfies Record<string, z.ZodType<ServerFrame>>

/**
 * Parses one server→client frame, envelope first (§6.1).
 *
 * The two-step order is deliberate and mirrors Line A's: it is what makes
 * "unknown message type" distinguishable from "known type, invalid body",
 * which the two sides' error reporting has to agree on. A single
 * discriminated-union parse would collapse both into one failure.
 */
export function parseServerFrame(value: unknown): ServerFrame {
  const envelope = frameEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new FrameError(
      'malformed',
      'payload is not a JSON object with a string `type`'
    )
  }
  const type = envelope.data.type
  const schema = Object.hasOwn(SERVER_FRAME_SCHEMAS, type)
    ? SERVER_FRAME_SCHEMAS[type as keyof typeof SERVER_FRAME_SCHEMAS]
    : undefined
  if (schema === undefined) {
    throw new FrameError('unknownType', 'unrecognized frame type')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new FrameError(
      'invalidBody',
      `frame ${type} failed its schema: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`
    )
  }
  return parsed.data
}

const utf8Encoder = new TextEncoder()

/**
 * Parses one raw **text** frame off the wire: §6.1's size cap, then JSON, then
 * `parseServerFrame`.
 *
 * The size cap is checked first because §6.1 makes an oversize
 * pre-authentication frame a `protocolViolation` in its own right — and
 * checking it before `JSON.parse` is what keeps a hostile peer from forcing
 * this side to parse an arbitrarily large document. §6.1's cap is a **wire
 * byte** cap, and the wire bytes of a WebSocket text frame are UTF-8, so the
 * real measure is the string's UTF-8 size: `raw.length` counts UTF-16 code
 * units, which UNDER-counts UTF-8 by up to 3× for non-ASCII content. The
 * code-unit check still runs first — every code unit encodes to at least one
 * byte, so it rejects everything huge without allocating, which bounds the
 * exact re-encode below to ~3× the cap.
 */
export function parseTextFrame(raw: string): ServerFrame {
  if (
    raw.length > MAX_PRE_AUTH_FRAME_BYTES ||
    utf8Encoder.encode(raw).byteLength > MAX_PRE_AUTH_FRAME_BYTES
  ) {
    throw new FrameError('malformed', 'frame exceeds the 16 KiB §6.1 cap')
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new FrameError('malformed', 'frame is not valid JSON')
  }
  return parseServerFrame(body)
}

/**
 * §11: a `protocolVersion` other than 1 is `unsupportedVersion`, not a generic
 * violation. Fail closed — MBP1 has no negotiation (§3).
 */
export function assertProtocolVersion(protocolVersion: number): void {
  if (protocolVersion !== MBP1_PROTOCOL_VERSION) {
    throw new FrameError(
      'unsupportedVersion',
      'peer speaks a protocol version this client does not implement'
    )
  }
}

/**
 * Reads a host-supplied `nmTicket` into the parsed field values §6.4's
 * `ticketDigest` hashes — `v`/`protocolVersion` as integers, `exp` as an
 * integer, strings as-is, and `bindingPub`/`mac` as the **raw bytes** their
 * base64url wire encoding decodes to.
 *
 * This is a reader, not a validator: whether the ticket is *acceptable* is
 * §9.2's question and the server's alone. All this decides is whether the
 * client can compute an AAD at all.
 */
export function parseNmTicket(value: unknown): ParsedTicket {
  const parsed = nmTicketWireSchema.safeParse(value)
  if (!parsed.success) {
    throw new FrameError(
      'invalidBody',
      `nmTicket is not a well-formed ticket object: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`
    )
  }
  const wire = parsed.data
  return {
    v: wire.v,
    purpose: wire.purpose,
    protocolVersion: wire.protocolVersion,
    serverGeneration: wire.serverGeneration,
    browser: wire.browser,
    callerId: wire.callerId,
    exp: wire.exp,
    bindingPub: b64uDecode(wire.bindingPub),
    mac: b64uDecode(wire.mac),
  }
}

// -- transport port --------------------------------------------------------

/**
 * The transport a flow drives: one MBP1 WebSocket, carrying JSON **text**
 * frames before the AEAD channel activates and **binary** envelope frames
 * after (§6.1, §10).
 *
 * Deliberately not a dependency on `WebSocketClient`. The flows need only these
 * six operations, and keeping the port this narrow is what lets every flow test
 * drive a scripted in-memory peer instead of a socket. `ConnectionManager`
 * adapts the real `WebSocketClient` to it, via `WebSocketFrameChannel`.
 *
 * Contract the adapter must honour, because the flows depend on all of it:
 *
 * - `open` requests the subprotocol `motrix-bridge.v1`; the server rejects the
 *   upgrade with 401 without it.
 * - `receiveText`/`receiveBinary` reject — never hang and never resolve — when
 *   the socket closes before a frame arrives, or when `timeoutMs` elapses. A
 *   flow that cannot tell "closed" from "still waiting" cannot honour §7.2's
 *   deadlines.
 * - `receiveText` resolves the **raw text** of the frame, not a parsed object.
 *   The asymmetry with `sendText` is deliberate: stringifying is the socket's
 *   own job, but the *parse* has to stay on the flow's side of the boundary,
 *   because §6.1's 16 KiB cap is a property of the raw frame and because the
 *   malformed / unknown-type / invalid-body distinction is the flow's to make.
 * - A text frame arriving after the channel is active, or a binary frame
 *   arriving before it, is a §6.1 violation. The flow asks for exactly one
 *   shape at a time, so the adapter may surface the mismatch as a rejection.
 * - `close` is idempotent and safe to call on an already-closed socket; the
 *   flows call it unconditionally on the way out.
 */
export interface FrameChannel {
  open(url: string): Promise<void>
  sendText(frame: object): Promise<void>
  receiveText(timeoutMs: number): Promise<string>
  sendBinary(frame: Uint8Array): Promise<void>
  receiveBinary(timeoutMs: number): Promise<Uint8Array>
  close(): void
}

/** The WebSocket subprotocol every MBP1 upgrade must request (Line A: 401 without it). */
export const MBP1_SUBPROTOCOL = 'motrix-bridge.v1'

/**
 * `ws://127.0.0.1:<port>/pair?nonce=<nonce>` (§4).
 *
 * `/pair` carries **only** `?nonce=`. Identity moved into `pairHello`, and
 * there is no `?token=` mode on `/pair` at all.
 */
export function pairUrl(port: number, nonce: string): string {
  return `ws://127.0.0.1:${port}/pair?nonce=${encodeURIComponent(nonce)}`
}

/** `ws://127.0.0.1:<port>/v1` (§4) — no query credentials, ever. */
export function reconnectUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1`
}
