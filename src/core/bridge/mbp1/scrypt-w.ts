// MBP1 pairing-code → SPAKE2 password scalar derivation
// (docs/bridge-pairing-protocol.md §6.2).
//
// The pairing code IS the PAKE password: never log `codeNormalized`, the
// scrypt output, or the derived scalar `w`.

import { Buffer } from 'node:buffer'
import { scryptSync } from 'node:crypto'
import { assertAscii, os2ip } from './canonical'

export class PairingFailedError extends Error {}

/**
 * `w = OS2IP(scrypt(pw, salt, N=2^14, r=8, p=1, dkLen=64)) mod order` (§6.2).
 * `pw` is the 8 ASCII bytes of `codeNormalized`; `salt = "MBP1/w/v1" ‖ pairNonce`.
 * `order` is the caller-supplied group order to reduce modulo. Throws
 * `PairingFailedError` if the reduced scalar is 0 (§6.2, probability ≈ 2^-252).
 */
export function deriveW(
  codeNormalized: string,
  pairNonce: string,
  order: bigint
): bigint {
  assertAscii(codeNormalized, 'codeNormalized')
  assertAscii(pairNonce, 'pairNonce')

  const pw = Buffer.from(codeNormalized, 'ascii')
  const salt = Buffer.concat([
    Buffer.from('MBP1/w/v1', 'ascii'),
    Buffer.from(pairNonce, 'ascii'),
  ])
  const h = scryptSync(pw, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })

  const w = os2ip(h) % order
  if (w === 0n) {
    throw new PairingFailedError('derived w is 0')
  }
  return w
}
