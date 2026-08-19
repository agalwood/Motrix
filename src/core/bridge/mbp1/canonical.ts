// MBP1 canonical byte-level encoding primitives (docs/bridge-pairing-protocol.md §2).
//
// These are the shared building blocks every later mbp1 crypto module
// (scrypt-w, spake2-core, transcript, reconnect-mac, envelope, ticket-verify)
// composes into protocol structures. The same bytes are independently
// produced by a Rust and a browser-extension implementation, so every
// definition here must match §2 exactly — do not "improve" the encoding.

import { Buffer } from 'node:buffer'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { concatBytes }

export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolViolationError'
  }
}

/** Throws `ProtocolViolationError` unless every code unit of `s` is ASCII (§2). */
export function assertAscii(s: string, field: string): void {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      throw new ProtocolViolationError(`${field} must be ASCII-only`)
    }
  }
}

/**
 * `len64LE(n)` — encodes the already-computed length `n` (in bytes) as an
 * 8-byte little-endian integer (§2). `n` must be a non-negative integer
 * representable in 64 bits; anything else throws `ProtocolViolationError`
 * rather than silently wrapping, since a flipped-length field must change
 * the encoded bytes.
 */
export function len64LE(n: number | bigint): Uint8Array {
  const value = assertUint64Range(n, 'len64LE')
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, value, true)
  return new Uint8Array(view.buffer)
}

/** `enc(s)` — `len64LE(s) ‖ s` (§2). Strings are ASCII-checked, then UTF-8 encoded. */
export function enc(s: Uint8Array | string): Uint8Array {
  const bytes = typeof s === 'string' ? asciiStringToBytes(s) : s
  return concatBytes(len64LE(bytes.length), bytes)
}

function asciiStringToBytes(s: string): Uint8Array {
  assertAscii(s, 'enc(string)')
  return utf8ToBytes(s)
}

/**
 * `encU32BE(n)` — 4-byte big-endian unsigned integer (§2). `n` must be a
 * non-negative integer within uint32 range; out-of-range or non-integer
 * input throws `ProtocolViolationError` instead of silently wrapping.
 */
export function encU32BE(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 32) {
    throw new ProtocolViolationError(
      'encU32BE input must be a non-negative integer within uint32 range'
    )
  }
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, n, false)
  return new Uint8Array(view.buffer)
}

/**
 * `encU64BE(n)` — 8-byte big-endian unsigned integer (§2). `n` must be a
 * non-negative integer representable in 64 bits; out-of-range or
 * non-integer input throws `ProtocolViolationError` instead of silently
 * wrapping.
 */
export function encU64BE(n: number | bigint): Uint8Array {
  const value = assertUint64Range(n, 'encU64BE')
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, value, false)
  return new Uint8Array(view.buffer)
}

/**
 * Shared range/integer check for the two 64-bit integer encoders. Handles
 * both arms of the `number | bigint` union and returns the validated value
 * as a `bigint` ready for `DataView.setBigUint64`. `DataView` itself does
 * not throw on negative or overflowing input — it silently wraps — which
 * would break the protocol's requirement that any flipped wire field
 * changes the encoded (and later, MAC'd/digested) bytes.
 */
function assertUint64Range(n: number | bigint, field: string): bigint {
  if (typeof n === 'bigint') {
    if (n < 0n || n >= 2n ** 64n) {
      throw new ProtocolViolationError(
        `${field} input must be a non-negative integer within uint64 range`
      )
    }
    return n
  }
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 64) {
    throw new ProtocolViolationError(
      `${field} input must be a non-negative integer within uint64 range`
    )
  }
  return BigInt(n)
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/

/** Base64url without padding (§2, RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Strict base64url decoder (§2): rejects padding, rejects non-alphabet
 * characters, and rejects non-canonical trailing bits via a round-trip check.
 */
export function fromBase64Url(s: string): Uint8Array {
  if (!BASE64URL_ALPHABET.test(s)) {
    throw new ProtocolViolationError(
      'base64url input contains padding or non-alphabet characters'
    )
  }
  if (s.length % 4 === 1) {
    throw new ProtocolViolationError('base64url input has invalid length')
  }
  const decoded = new Uint8Array(Buffer.from(s, 'base64url'))
  if (toBase64Url(decoded) !== s) {
    throw new ProtocolViolationError(
      'base64url input has non-canonical trailing bits'
    )
  }
  return decoded
}
