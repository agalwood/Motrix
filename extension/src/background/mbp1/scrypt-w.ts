/**
 * MBP1 pairing code -> scalar `w` derivation (bridge-pairing-protocol.md
 * §6.2). Uses `@noble/hashes`'s scrypt rather than Node's `crypto.scryptSync`
 * — this module runs inside a browser extension background worker, where
 * Node's `crypto` module is unavailable.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { scrypt } from '@noble/hashes/scrypt.js'
import { assertAscii, concatBytes, utf8 } from '@/background/mbp1/canonical'

const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1, dkLen: 64 }

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let n = 0n
  for (const byte of bytes) {
    n = (n << 8n) | BigInt(byte)
  }
  return n
}

function bigIntToBytesBE(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let value = n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/**
 * Derive the SPAKE2 password scalar `w` from the normalized pairing code and
 * the session's `pairNonce`:
 *
 * ```
 * salt = "MBP1/w/v1" ‖ UTF8(pairNonce)
 * h    = scrypt(pw, salt, N=2^14, r=8, p=1, dkLen=64)
 * w    = OS2IP(h) mod ℓ
 * ```
 *
 * `pairNonce` makes `w` session-unique. Throws if `w = 0` (probability
 * ≈ 2^-252; §6.2 attaches no retry semantics to this case).
 */
export function deriveW(codeNormalized: string, pairNonce: string): Uint8Array {
  // The server asserts the same two, and the asymmetry mattered: it encodes
  // with `Buffer.from(s, 'ascii')`, which truncates each character to its low
  // byte, while this side uses UTF-8. A non-ASCII input would therefore derive
  // a *different* `w` on each side, and the only symptom would be key
  // confirmation failing against a real Motrix — the least diagnosable failure
  // in the protocol. Both sides refuse rather than encode differently.
  //
  // Neither argument should be able to arrive non-ASCII — `normalizePairingCode`
  // validates against the Crockford alphabet and `readNonce` filters the nonce
  // upstream — but relying on a caller's filter is what makes this the kind of
  // guard that quietly stops holding.
  const pw = assertAscii(codeNormalized, 'deriveW: codeNormalized')
  assertAscii(pairNonce, 'deriveW: pairNonce')
  const salt = concatBytes(utf8('MBP1/w/v1'), utf8(pairNonce))
  const h = scrypt(pw, salt, SCRYPT_PARAMS)
  const order = ed25519.Point.Fn.ORDER
  const w = bytesToBigIntBE(h) % order
  if (w === 0n) {
    throw new Error('deriveW: w reduced to 0 mod the group order')
  }
  return bigIntToBytesBE(w, 32)
}
