/**
 * MBP1 NM attestation bootstrap (bridge-pairing-protocol.md §9.1) and
 * ticketProof signing (§6.5).
 *
 * The extension generates an ephemeral Ed25519 "binding" keypair per
 * bootstrap attempt, sends `bindingPub` to the Native Messaging host over NM
 * stdio, and later proves possession of `bindingPriv` to the Motrix bridge
 * server by signing the domain-tagged SPAKE2 transcript `TT` as
 * `confirmA.ticketProof`. This binds a minted ticket to the one handshake
 * that holds the corresponding private key, so the ticket cannot be replayed
 * onto a different pairing attempt.
 *
 * Curve operations go through `@noble/curves`, never WebCrypto — WebCrypto's
 * Ed25519 support needs Chrome 133 / Firefox 130, above this extension's
 * Chrome 120+ / Firefox 121+ floor (§3, Appendix B).
 *
 * `bindingPriv` MUST NOT be logged at any level (§11); it lives only in this
 * bootstrap's in-memory keypair for the lifetime of one pairing attempt.
 *
 * **Deviation from a minimal `{action, protocolVersion, bindingPub}` request
 * shape:** Line A's Native Messaging host — the peer this module must
 * interoperate with — only wakes a sleeping Motrix when the bootstrap
 * request's `allowLaunch` field is *literally* `true`; a request that omits it
 * never triggers the gesture-free wake path (§9.1 step 3: "wakes Motrix if
 * needed"). So the field stays on the wire, always present and explicit.
 *
 * It is a **parameter**, not a constant. An earlier shape typed it as the
 * literal `true` and hardcoded it, which would have silently discarded the
 * caller's choice the moment the discovery chain wired this up — every
 * background liveness probe would have launched the desktop app, which is
 * precisely what the flag exists to prevent. The host's "only literal `true`
 * wakes" rule is a fact about the host, not a reason to send only `true`.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { b64uEncode, concatBytes, utf8 } from '@/background/mbp1/canonical'

export interface BindingKeypair {
  priv: Uint8Array
  pub: Uint8Array
}

/** Generates a fresh ephemeral Ed25519 keypair for one bootstrap attempt (§9.1 step 1). */
export function generateBindingKeypair(): BindingKeypair {
  const priv = ed25519.utils.randomSecretKey()
  const pub = ed25519.getPublicKey(priv)
  return { priv, pub }
}

export interface BootstrapRequest {
  action: 'bootstrap'
  protocolVersion: 1
  bindingPub: string
  /**
   * MUST be the literal `true` (see the module-level deviation note above) —
   * Line A's host treats anything else, including a missing field, as "do
   * not wake Motrix."
   */
  allowLaunch: boolean
}

/**
 * Builds the NM stdio request the extension sends to the host (§9.1 step 2).
 *
 * `allowLaunch` is the caller's decision: `true` only when a user gesture is
 * driving the attempt, `false` for any background probe. See the module note
 * for why it must not be hardcoded.
 */
export function buildBootstrapRequest(
  pub: Uint8Array,
  allowLaunch: boolean
): BootstrapRequest {
  return {
    action: 'bootstrap',
    protocolVersion: 1,
    bindingPub: b64uEncode(pub),
    allowLaunch,
  }
}

const TICKET_PROOF_LABEL = utf8('MBP1/ticket-proof/v1')

/**
 * Signs `"MBP1/ticket-proof/v1" ‖ TT` with `bindingPriv` (§6.5, §9.1 step 4).
 * The server verifies this signature in RFC 8032 strict mode
 * (`zip215: false` in noble-curves 2.0.1), never the permissive ZIP-215
 * default (§9.1) — this module only signs and takes no position on
 * verification mode itself.
 */
export function signTicketProof(priv: Uint8Array, TT: Uint8Array): Uint8Array {
  return ed25519.sign(concatBytes(TICKET_PROOF_LABEL, TT), priv)
}
