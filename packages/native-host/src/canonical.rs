//! MBP1 canonical byte-level encoding primitives (`docs/bridge-pairing-protocol.md` §2).
//!
//! These bytes are independently produced by a TypeScript implementation
//! (`src/core/bridge/mbp1/canonical.ts`) and this Rust host; every definition
//! here must match §2 exactly, byte for byte.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// `len64LE(n)` — the length of a byte string as an 8-byte little-endian
/// integer (§2).
pub fn len64_le(len: u64) -> [u8; 8] {
    len.to_le_bytes()
}

/// `enc(s)` — `len64LE(s) ‖ s` (§2) over a raw byte string. Use this for
/// non-textual fields (for example a raw binding key); canonical *string*
/// fields go through [`enc_ascii`] instead, which enforces §2's ASCII-only
/// rule before delegating here.
pub fn enc(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&len64_le(bytes.len() as u64));
    out.extend_from_slice(bytes);
    out
}

/// `enc(s)` for a canonical *string* field (§2): "every string field in a
/// canonical structure MUST be ASCII-only, and implementations MUST reject
/// non-ASCII input in those fields." Returns `None` on any non-ASCII byte
/// instead of silently encoding it.
pub fn enc_ascii(s: &str) -> Option<Vec<u8>> {
    s.is_ascii().then(|| enc(s.as_bytes()))
}

/// `encU32BE(n)` — 4-byte big-endian unsigned integer (§2).
pub fn enc_u32_be(n: u32) -> [u8; 4] {
    n.to_be_bytes()
}

/// `encU64BE(n)` — 8-byte big-endian unsigned integer (§2).
pub fn enc_u64_be(n: u64) -> [u8; 8] {
    n.to_be_bytes()
}

/// Base64url without padding (§2, RFC 4648 §5).
pub fn base64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict base64url decode (§2: "Decoders MUST reject padded or
/// non-canonical input"). `URL_SAFE_NO_PAD`'s default decode config already
/// requires no padding and rejects non-zero trailing bits, so any decode
/// error — padding, an out-of-alphabet byte, or a non-canonical tail —
/// collapses to `None`.
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

#[cfg(test)]
mod tests {
    use super::{base64url_decode, base64url_encode, enc, enc_ascii, enc_u32_be, enc_u64_be};
    use crate::test_vectors::hex;

    #[test]
    fn enc_prefixes_eight_byte_le_length() {
        // enc("chromium") as it appears inside nmTicket.expected.canonical
        assert_eq!(hex(&enc(b"chromium")), "08000000000000006368726f6d69756d");
        assert_eq!(hex(&enc(b"")), "0000000000000000");
    }

    #[test]
    fn big_endian_ints_match_vector_fields() {
        assert_eq!(hex(&enc_u32_be(1)), "00000001");
        // exp = 1755600000 from the nmTicket vector
        assert_eq!(hex(&enc_u64_be(1_755_600_000)), "0000000068a45480");
    }

    #[test]
    fn enc_ascii_matches_raw_enc_for_ascii_input() {
        assert_eq!(enc_ascii("chromium"), Some(enc(b"chromium")));
        assert_eq!(enc_ascii(""), Some(enc(b"")));
    }

    #[test]
    fn enc_ascii_rejects_non_ascii_input() {
        assert_eq!(enc_ascii("café"), None);
        assert_eq!(enc_ascii("\u{1f4a9}"), None);
    }

    #[test]
    fn base64url_round_trips_without_padding_and_rejects_padded_input() {
        let raw: Vec<u8> = (0_u8..32).collect();
        let encoded = base64url_encode(&raw);
        assert!(!encoded.contains('='));
        assert_eq!(base64url_decode(&encoded), Some(raw));
        assert_eq!(base64url_decode("AA=="), None);
        assert_eq!(base64url_decode("A+B/"), None);
    }
}
