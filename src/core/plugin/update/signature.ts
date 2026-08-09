import { createPublicKey, verify } from 'node:crypto'
import { BUILTIN_SIGNING_PUBKEYS } from '@shared/builtin-signing'

/**
 * THE trust boundary for builtin hot updates. Any decode/verify error is a
 * plain false — callers hard-fail closed (same contract as
 * scripts/fetch-builtins.mjs verifySignature).
 */
export function verifyBuiltinSignature(
  bytes: Buffer,
  signatureBase64: string,
  pubkeys: ReadonlyArray<string> = BUILTIN_SIGNING_PUBKEYS
): boolean {
  let sig: Buffer
  try {
    sig = Buffer.from(signatureBase64, 'base64')
  } catch {
    return false
  }
  if (sig.length === 0) return false
  for (const pem of pubkeys) {
    try {
      if (verify(null, bytes, createPublicKey(pem), sig)) return true
    } catch {
      // bad key/sig shape — try the next pinned key
    }
  }
  return false
}
