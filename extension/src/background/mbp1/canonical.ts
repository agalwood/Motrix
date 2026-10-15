/**
 * MBP1 canonical encoding primitives (bridge-pairing-protocol.md §2).
 *
 * `len64LE` / `enc` / `encU32BE` / `encU64BE` are the wire's length-prefixed
 * and fixed-width integer encodings; every canonical structure in the
 * protocol (identity strings in §6.4's `TT`, the §9.2 ticket MAC input, ...)
 * composes from these.
 *
 * The integer encoders throw on out-of-range input rather than silently
 * wrapping. `DataView.setUint32`/`setBigUint64` wrap modulo their width
 * instead of throwing, which would let two distinct field values (e.g.
 * `exp = 0` and `exp = 2**64`) collide on the wire and defeat §6.4's
 * guarantee that flipping any ticket field changes the resulting digest.
 */

const textEncoder = new TextEncoder()

/** UTF-8 encode a string. Does not enforce ASCII-only (see `enc`). */
export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s)
}

function assertNonNegativeSafeInteger(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(
      `${label}: expected a safe non-negative integer, got ${n}`
    )
  }
}

/** The length of `n` as an 8-byte little-endian integer (RFC 9382 §3.2). */
export function len64LE(n: number): Uint8Array {
  assertNonNegativeSafeInteger(n, 'len64LE')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}

/**
 * Rejects any non-ASCII byte in `s`, returning its UTF-8 bytes — which, for an
 * ASCII string, are the ASCII bytes.
 *
 * Exported because §2's ASCII rule binds more than `enc`. The server asserts it
 * separately in `deriveW` and it matters there for a reason beyond hygiene:
 * that side encodes with `Buffer.from(s, 'ascii')`, which truncates each
 * character to its low byte, while this side uses UTF-8. For any non-ASCII
 * input the two would derive **different** `w` values, and the only symptom
 * would be key confirmation failing against a real Motrix — so both sides
 * refuse the input instead of encoding it differently.
 */
export function assertAscii(s: string, field: string): Uint8Array {
  const bytes = utf8(s)
  for (const byte of bytes) {
    if (byte >= 0x80) {
      throw new Error(`${field} must be ASCII-only`)
    }
  }
  return bytes
}

/**
 * `len64LE(len) ‖ bytes`. Strings are UTF-8 encoded; every string field in a
 * canonical structure MUST be ASCII-only, so non-ASCII input is rejected.
 * Raw byte strings (point/scalar encodings) pass through unchecked.
 */
export function enc(s: Uint8Array | string): Uint8Array {
  if (typeof s === 'string') {
    const bytes = assertAscii(s, 'enc: string field')
    return concatBytes(len64LE(bytes.length), bytes)
  }
  return concatBytes(len64LE(s.length), s)
}

/** `n` as a 4-byte big-endian unsigned integer. */
export function encU32BE(n: number): Uint8Array {
  assertNonNegativeSafeInteger(n, 'encU32BE')
  if (n > 0xffffffff) {
    throw new RangeError(`encU32BE: ${n} exceeds the 32-bit unsigned range`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

/** `n` as an 8-byte big-endian unsigned integer. */
export function encU64BE(n: number): Uint8Array {
  assertNonNegativeSafeInteger(n, 'encU64BE')
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)
  return out
}

/** Concatenate byte strings in order, without mutating any input. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const B64U_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const B64U_REVERSE: ReadonlyMap<string, number> = new Map(
  [...B64U_ALPHABET].map((char, index) => [char, index])
)

function alphabetChar(index: number): string {
  const char = B64U_ALPHABET[index]
  if (char === undefined) {
    throw new RangeError(`b64u: alphabet index ${index} out of range`)
  }
  return char
}

/** base64url, no padding (RFC 4648 §5). */
export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += alphabetChar((buffer >> bits) & 0x3f)
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    out += alphabetChar((buffer << (6 - bits)) & 0x3f)
  }
  return out
}

/**
 * Decode base64url, no padding. Rejects padding characters, characters
 * outside the alphabet, an impossible length (`len % 4 === 1`), and
 * non-canonical input whose unused trailing bits are nonzero.
 */
export function b64uDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) {
    throw new Error(`b64uDecode: invalid base64url length ${s.length}`)
  }
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of s) {
    const value = B64U_REVERSE.get(char)
    if (value === undefined) {
      throw new Error(
        `b64uDecode: invalid base64url character ${JSON.stringify(char)}`
      )
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  // Whatever is left in `buffer` is exactly the unused trailing bits of the
  // final character group (masked down on every extraction above); a
  // canonical encoding always leaves them zero.
  if (buffer !== 0) {
    throw new Error('b64uDecode: non-canonical encoding (nonzero padding bits)')
  }
  return Uint8Array.from(bytes)
}

/**
 * Constant-time byte-string comparison: the running time depends only on
 * `max(a.length, b.length)`, never on the position of the first differing
 * byte or on whether the lengths match.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}
