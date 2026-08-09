const RPC_SECRET_ALPHABET =
  'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/**
 * Cross-runtime random RPC secret using WebCrypto.
 * Available in Node 19+, modern browsers, and Electron renderer.
 *
 * 8 chars from a 55-character alphabet ≈ 46 bits of entropy. Sufficient
 * to keep a local-loopback aria2 RPC opaque to casual probes.
 */
export function generateRpcSecret(length = 8): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(
    bytes,
    (b) => RPC_SECRET_ALPHABET[b % RPC_SECRET_ALPHABET.length]
  ).join('')
}
