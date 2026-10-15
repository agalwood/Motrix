// Source: Motrix docs/bridge-pairing-protocol-vectors.json
// @ feat/mbp1_phase_a_bridge_20260820 (c14b4b6, "docs(bridge): address
// crypto-review round 3 findings in MBP1 spec") — the last commit to touch
// that file at the time this copy was made. Copied verbatim; do not hand-edit
// mbp1-vectors.json — regenerate the source repo's file and re-copy instead.
//
// rfc9382-p256-vectors.json is transcribed from the checked-in generator at
// Motrix scripts/generate-bridge-pairing-vectors.mjs (same revision), whose
// header documents that it reproduced these four RFC 9382 Appendix B P-256
// vectors exactly before generating the MBP1 edwards25519 vectors above.
import mbp1 from '@/background/mbp1/__fixtures__/mbp1-vectors.json'
import rfc from '@/background/mbp1/__fixtures__/rfc9382-p256-vectors.json'

/** One SPAKE2/MBP1 first-pair derivation vector (`spake2` array entries). */
export interface Mbp1SpakeVector {
  name: string
  inputs?: Record<string, string>
  intermediate?: Record<string, string>
  expected: Record<string, string>
}

export interface Mbp1ScryptWVector {
  inputs: {
    codeNormalized: string
    pairNonce: string
    params: { N: number; r: number; p: number; dkLen: number }
  }
  expected: { scryptOutput: string; w: string }
}

export interface Mbp1ReconnectVector {
  inputs: Record<string, string>
  expected: Record<string, string>
}

export interface Mbp1NmTicketMustReject {
  case: string
  bindingPub?: string | string[]
  signature?: string
  reason: string
}

export interface Mbp1NmTicketVector {
  inputs: Record<string, string | number>
  expected: Record<string, string>
  mustReject: Mbp1NmTicketMustReject[]
  note?: string
}

export interface Mbp1EnvelopeMustReject {
  case: string
  reason: string
}

export interface Mbp1EnvelopeVector {
  inputs: Record<string, string>
  expected: Record<string, string>
  mustReject: Mbp1EnvelopeMustReject[]
}

/** The full normative MBP1 cross-implementation vector file (rev 2). */
export interface Mbp1Vectors {
  description: string
  generator: { library: string; coreValidation: string }
  spake2: Mbp1SpakeVector[]
  scryptW: Mbp1ScryptWVector
  reconnect: Mbp1ReconnectVector
  nmTicket: Mbp1NmTicketVector
  envelope: Mbp1EnvelopeVector
}

/**
 * A single RFC 9382 Appendix B P-256 SPAKE2 core vector. `A`/`B` are the
 * UTF-8 participant identity strings (empty string for the two vectors that
 * use no identity); every other field is lowercase hex.
 */
export interface Rfc9382Vector {
  label: string
  A: string
  B: string
  w: string
  x: string
  y: string
  pA: string
  pB: string
  K: string
  Ke: string
  Ka: string
  KcA: string
  KcB: string
  cA: string
  cB: string
}

export const MBP1_VECTORS = mbp1 as Mbp1Vectors
export const RFC9382_P256_VECTORS = rfc as Rfc9382Vector[]

// sha256 of the raw bytes of mbp1-vectors.json, as copied from the Motrix
// source above. This is the frozen rev-2 digest recorded in the Line C
// ledger — authoritative because Line A's checked-in generator reproduces
// that file byte-identically. The drift test in __tests__/vectors-drift.test.ts
// re-derives this digest from the copy on disk; if it ever fails, the fixture
// was copied wrong (line endings, encoding, trailing newline) — fix the file,
// never this constant.
export const MBP1_VECTORS_SHA256 =
  'b00c0fa1cacf5393933f401389c50a850206c175549754e92ae0f8e985d03667'
