/**
 * MBP1 pairing-code format and local normalization (bridge-pairing-protocol.md
 * §7.1). The code is the PAKE password: it MUST never travel over any
 * network channel and MUST never be logged (§7.1, §11). Everything in this
 * module runs before any network traffic, so a string that fails validation
 * here never consumes an attempt.
 */

/** Crockford base32 (32 symbols; excludes I, L, O, U). */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Visually confusable letters folded onto their Crockford digit lookalikes. */
const CONFUSABLE_MAP: ReadonlyMap<string, string> = new Map([
  ['O', '0'],
  ['I', '1'],
  ['L', '1'],
])

/**
 * Normalize user-entered pairing-code text: strip ASCII hyphens and spaces,
 * uppercase, map O→0/I→1/L→1, then require exactly 8 Crockford symbols.
 * Returns `null` (never throws) on any validation failure.
 */
/**
 * Entry-time cleanup for code inputs (§7.1): drops separators, whitespace,
 * and clipboard noise so a display-form paste (`XXXX-XXXX`) fills an input
 * cleanly. Deliberately NOT the full normalization — confusable folding
 * (O→0, I→1, L→1) and casing stay out so pasted and typed characters render
 * identically before submit; `normalizePairingCode` below owns the rest.
 */
export function sanitizePairingCodeInput(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, '')
}

export function normalizePairingCode(input: string): string | null {
  const upper = input.replace(/[- ]/g, '').toUpperCase()
  let mapped = ''
  for (const char of upper) {
    mapped += CONFUSABLE_MAP.get(char) ?? char
  }
  // The length check MUST come after uppercasing, not before it. Every other
  // step here is one character in, one character out, but `toUpperCase()` is
  // not length-preserving in Unicode, and some expansions land entirely inside
  // the Crockford alphabet: `ß` → `SS` and `ﬁ` → `FI` (whose `I` then folds to
  // `1`). Checking length first would let an 8-character input clear the
  // alphabet check below and be returned as a 16-symbol "code" — a value this
  // function promises cannot exist, and one that would consume a §7.2 attempt
  // on a code the server can never match. Line A normalizes in this same order.
  if (mapped.length !== 8) {
    return null
  }
  for (const char of mapped) {
    if (!CROCKFORD_ALPHABET.includes(char)) {
      return null
    }
  }
  return mapped
}
