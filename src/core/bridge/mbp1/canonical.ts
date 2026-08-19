// MBP1 canonical byte-level encoding primitives (docs/bridge-pairing-protocol.md §2).
//
// These are the shared building blocks every later mbp1 crypto module
// (scrypt-w, spake2-core, transcript, reconnect-mac, envelope, ticket-verify)
// composes into protocol structures. The same bytes are independently
// produced by a Rust and a browser-extension implementation, so every
// definition here must match §2 exactly — do not "improve" the encoding.

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

/** `len64LE(s)` — length of `s` in bytes as an 8-byte little-endian integer (§2). */
export function len64LE(n: number | bigint): Uint8Array {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(n), true)
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

/** `encU32BE(n)` — 4-byte big-endian unsigned integer (§2). */
export function encU32BE(n: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4))
  view.setUint32(0, n, false)
  return new Uint8Array(view.buffer)
}

/** `encU64BE(n)` — 8-byte big-endian unsigned integer (§2). */
export function encU64BE(n: number | bigint): Uint8Array {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(n), false)
  return new Uint8Array(view.buffer)
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
