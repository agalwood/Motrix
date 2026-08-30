// MBP1 reconnect transcript, MACs, and traffic keys
// (docs/bridge-pairing-protocol.md §8).
//
// Reconnect binds a stored credential's `mutualKey` to the live connection's
// `browser`/`verifiedOrigin` through the challenge–response MAC: any
// disagreement between the stored principal and the live one changes the
// transcript and desynchronizes the MAC (misbinding property). The `"MBP1-R/c"`
// and `"MBP1-R/s"` MAC labels and the `"MBP1-traffic-c2s"`/`"-s2c"` HKDF info
// strings are distinct from §6.6's pair-session labels by design — reconnect
// key material must never collide with first-pair key material even if an
// implementation reused the same `mutualKey`/`Ke` accidentally.
//
// Everything here is secret-adjacent (`mutualKey`, the MACs, the traffic
// keys), so this module logs nothing at any level.

import { utf8ToBytes } from '@noble/hashes/utils.js'
import { concatBytes, enc, encU32BE, hkdf32, hmacSha256 } from './canonical'

const RT_LABEL = 'MBP1/reconnect/v1'
const MAC_CLIENT_LABEL = utf8ToBytes('MBP1-R/c')
const MAC_SERVER_LABEL = utf8ToBytes('MBP1-R/s')
const TRAFFIC_INFO_C2S = utf8ToBytes('MBP1-traffic-c2s')
const TRAFFIC_INFO_S2C = utf8ToBytes('MBP1-traffic-s2c')

/**
 * `RT = enc("MBP1/reconnect/v1") ‖ encU32BE(protocolVersion) ‖ enc(credentialId)
 *   ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(instanceId)` (§8).
 */
export function buildRT(f: {
  protocolVersion: number
  credentialId: string
  browser: string
  verifiedOrigin: string
  instanceId: string
}): Uint8Array {
  return concatBytes(
    enc(RT_LABEL),
    encU32BE(f.protocolVersion),
    enc(f.credentialId),
    enc(f.browser),
    enc(f.verifiedOrigin),
    enc(f.instanceId)
  )
}

/**
 * `macClient = HMAC-SHA-256(mutualKey, "MBP1-R/c" ‖ S ‖ C ‖ RT)` (§8). The
 * label is the raw ASCII bytes prepended directly, not `enc()`-wrapped.
 */
export function reconnectMacClient(
  mutualKey: Uint8Array,
  s: Uint8Array,
  c: Uint8Array,
  rt: Uint8Array
): Uint8Array {
  return hmacSha256(mutualKey, concatBytes(MAC_CLIENT_LABEL, s, c, rt))
}

/** `macServer = HMAC-SHA-256(mutualKey, "MBP1-R/s" ‖ S ‖ C ‖ RT)` (§8). */
export function reconnectMacServer(
  mutualKey: Uint8Array,
  s: Uint8Array,
  c: Uint8Array,
  rt: Uint8Array
): Uint8Array {
  return hmacSha256(mutualKey, concatBytes(MAC_SERVER_LABEL, s, c, rt))
}

/**
 * `kC2S = HKDF-SHA-256(ikm=mutualKey, salt=S‖C, info="MBP1-traffic-c2s", L=32)`
 * and `kS2C` the same with `"MBP1-traffic-s2c"` (§8).
 */
export function reconnectTrafficKeys(
  mutualKey: Uint8Array,
  s: Uint8Array,
  c: Uint8Array
): { kC2S: Uint8Array; kS2C: Uint8Array } {
  const salt = concatBytes(s, c)
  return {
    kC2S: hkdf32(mutualKey, salt, TRAFFIC_INFO_C2S),
    kS2C: hkdf32(mutualKey, salt, TRAFFIC_INFO_S2C),
  }
}
