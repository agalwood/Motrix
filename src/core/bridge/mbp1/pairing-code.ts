// MBP1 pairing code format (docs/bridge-pairing-protocol.md §7.1).
//
// The pairing code IS the PAKE password: it MUST never be logged, in either
// generated, displayed, or normalized form.

/** Crockford base32 alphabet (32 symbols; excludes I, L, O, U) (§7.1). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Draws an 8-symbol pairing code from 40 bits of CSPRNG entropy: the 40 bits
 * split big-endian into eight 5-bit groups, each indexing the alphabet (§7.1).
 */
export function generatePairingCode(random5: Uint8Array): string {
  let bits = 0n
  for (const byte of random5) {
    bits = (bits << 8n) | BigInt(byte)
  }

  let code = ''
  for (let group = 7; group >= 0; group--) {
    const index = Number((bits >> BigInt(group * 5)) & 0b11111n)
    code += CROCKFORD_ALPHABET[index]
  }
  return code
}

/** Display grouping: an already-uppercase 8-symbol code as `XXXX-XXXX` (§7.1). */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`
}

/**
 * Input normalization (§7.1): strip ASCII hyphens and spaces, uppercase, map
 * `O→0`, `I→1`, `L→1`, then require exactly 8 alphabet symbols. Returns
 * `null` if normalization does not yield exactly 8 valid symbols.
 */
export function normalizePairingCode(input: string): string | null {
  const normalized = input
    .replace(/[- ]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/L/g, '1')

  if (normalized.length !== 8) {
    return null
  }
  for (const symbol of normalized) {
    if (!CROCKFORD_ALPHABET.includes(symbol)) {
      return null
    }
  }
  return normalized
}
