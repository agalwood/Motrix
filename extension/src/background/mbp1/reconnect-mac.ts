/**
 * MBP1 reconnect transcript, confirmation MACs, and traffic key derivation
 * (bridge-pairing-protocol.md §8, the challenge-response run on `/v1`).
 *
 * The MAC labels `"MBP1-R/c"` / `"MBP1-R/s"` are prepended to the HMAC
 * message as their raw UTF-8 bytes, deliberately NOT `enc()`-wrapped — every
 * other canonical structure in this protocol length-prefixes its fields,
 * but §8's vector is authoritative here and only agrees with the raw form.
 *
 * Every HKDF/HMAC label in MBP1 is globally unique so key separation never
 * rests on an incidental difference in IKM or salt alone. In particular,
 * these traffic-key labels (`"MBP1-traffic-c2s"` / `"MBP1-traffic-s2c"`) are
 * distinct from §6.6's pair-session traffic labels
 * (`"MBP1-pair-traffic-c2s"` / `"MBP1-pair-traffic-s2c"`, salt
 * `"MBP1/pair/v1"`) even though both key schedules ultimately derive from a
 * shared secret — do not unify or reuse either family's labels.
 *
 * `mutualKey`, both MACs, and both traffic keys feed or gate session
 * authentication and MUST NOT be logged at any level (§11).
 */

import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, enc, encU32BE, utf8 } from '@/background/mbp1/canonical'

const MAC_CLIENT_LABEL = utf8('MBP1-R/c')
const MAC_SERVER_LABEL = utf8('MBP1-R/s')
const TRAFFIC_C2S_INFO = utf8('MBP1-traffic-c2s')
const TRAFFIC_S2C_INFO = utf8('MBP1-traffic-s2c')
const TRAFFIC_KEY_LENGTH = 32

/**
 * `RT = enc("MBP1/reconnect/v1") ‖ encU32BE(protocolVersion) ‖ enc(credentialId) ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(instanceId)` (§8).
 *
 * `browser`/`verifiedOrigin` MUST be the stored credential principal's
 * values on the client side and the live connection's values on the server
 * side (§8) — a mismatch desynchronizes the MAC by construction.
 */
export function reconnectTranscript(a: {
  protocolVersion: number
  credentialId: string
  browser: string
  verifiedOrigin: string
  instanceId: string
}): Uint8Array {
  return concatBytes(
    enc('MBP1/reconnect/v1'),
    encU32BE(a.protocolVersion),
    enc(a.credentialId),
    enc(a.browser),
    enc(a.verifiedOrigin),
    enc(a.instanceId)
  )
}

/**
 * `client = HMAC-SHA-256(mutualKey, "MBP1-R/c" ‖ S ‖ C ‖ RT)`,
 * `server = HMAC-SHA-256(mutualKey, "MBP1-R/s" ‖ S ‖ C ‖ RT)` (§8).
 */
export function reconnectMacs(
  mutualKey: Uint8Array,
  S: Uint8Array,
  C: Uint8Array,
  RT: Uint8Array
): { client: Uint8Array; server: Uint8Array } {
  return {
    client: hmac(sha256, mutualKey, concatBytes(MAC_CLIENT_LABEL, S, C, RT)),
    server: hmac(sha256, mutualKey, concatBytes(MAC_SERVER_LABEL, S, C, RT)),
  }
}

/**
 * `c2s = HKDF-SHA-256(ikm=mutualKey, salt=S‖C, info="MBP1-traffic-c2s", L=32)`,
 * `s2c` likewise with `"MBP1-traffic-s2c"` (§8).
 */
export function reconnectTrafficKeys(
  mutualKey: Uint8Array,
  S: Uint8Array,
  C: Uint8Array
): { c2s: Uint8Array; s2c: Uint8Array } {
  const salt = concatBytes(S, C)
  return {
    c2s: hkdf(sha256, mutualKey, salt, TRAFFIC_C2S_INFO, TRAFFIC_KEY_LENGTH),
    s2c: hkdf(sha256, mutualKey, salt, TRAFFIC_S2C_INFO, TRAFFIC_KEY_LENGTH),
  }
}
