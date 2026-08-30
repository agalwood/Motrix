//! Shared test-only access to the normative MBP1 vectors.
//!
//! `canonical.rs` and `ticket.rs` assert byte-exact encoding and MAC output
//! against `docs/bridge-pairing-protocol-vectors.json` (spec §13); this
//! module is the single place that locates and parses that file so every
//! consumer stays pointed at the same fixture instead of duplicating the
//! `include_str!` path and hex helpers per module.

const VECTORS_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/bridge-pairing-protocol-vectors.json"
));

/// Parse the normative vector file.
pub(crate) fn vectors() -> serde_json::Value {
    serde_json::from_str(VECTORS_JSON).expect("bridge-pairing-protocol-vectors.json is valid json")
}

/// Render bytes as lowercase hex, matching the vector file's encoding.
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode a lowercase hex string produced by [`hex`] or found in the vector file.
pub(crate) fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("valid hex byte"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{hex, unhex, vectors};

    #[test]
    fn loads_the_nm_ticket_vector_group() {
        let doc = vectors();
        let group = &doc["nmTicket"];
        assert!(group["inputs"]["localToken"].is_string());
        assert!(group["inputs"]["bindingPub"].is_string());
        assert!(group["expected"]["canonical"].is_string());
        assert!(group["expected"]["mac"].is_string());
    }

    #[test]
    fn hex_and_unhex_round_trip() {
        let bytes = [0x00, 0x01, 0x7f, 0x80, 0xab, 0xff];
        assert_eq!(hex(&bytes), "00017f80abff");
        assert_eq!(unhex(&hex(&bytes)), bytes);
    }
}
