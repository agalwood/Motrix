//! MBP1 NM attestation ticket minting (`docs/bridge-pairing-protocol.md` §9.2).
//!
//! The host mints a one-shot ticket per bootstrap request so the server can
//! resolve the extension identity tri-state (§5). Every byte produced here
//! must match the server's verification exactly — see the `nmTicket` vector
//! group in `docs/bridge-pairing-protocol-vectors.json` (§13).
//!
//! Binding-key validation (curve arithmetic, small-order/torsion checks,
//! `ticketProof` verification) is entirely server-side (§9.1); this module
//! only echoes the caller-supplied `bindingPub` bytes into the MAC.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::canonical::{base64url_encode, enc, enc_ascii, enc_u32_be, enc_u64_be};

/// Ticket format version (§9.2 wire field `v`).
pub const TICKET_V: u32 = 1;

/// Protocol version this host implements (§9.2 wire field `protocolVersion`).
pub const TICKET_PROTOCOL_VERSION: u32 = 1;

/// The ticket's fixed purpose string. This constant serves two *distinct*
/// roles that must never be conflated: it is written verbatim as the wire
/// `purpose` field below, and — separately — [`ticket_canonical`] feeds it
/// into the MAC as a hardcoded domain-separation tag (§9.2: "The MAC's
/// leading `enc(\"mbp1-attestation\")` is a fixed domain tag, not the wire
/// `purpose`"). Both happen to hold the same literal value in protocol v1,
/// but the MAC input always uses this constant directly — never a value
/// read back off any parsed or wire structure — so the two uses cannot
/// silently drift apart.
pub const TICKET_PURPOSE: &str = "mbp1-attestation";

/// Remaining-lifetime bound for a minted ticket (§9.2): the server rejects
/// any ticket whose `exp` is more than 60 seconds in the future, so the
/// caller must mint with `exp <= now + TICKET_LIFETIME_SECONDS`.
pub const TICKET_LIFETIME_SECONDS: u64 = 60;

/// Fixed HKDF salt for ticket-key derivation (§9.2).
const TICKET_KEY_SALT: &[u8] = b"MBP1/nm-ticket/v1";

/// Fixed HKDF info label for ticket-key derivation (§9.2).
const TICKET_KEY_INFO: &[u8] = b"mac";

/// Inputs the caller has already resolved and trusts: the browser-supplied
/// caller identity, the live server's `generation`, and the extension's
/// binding key. This module never validates provenance — a missing or
/// unverified input is the caller's signal to reply ticketless, not to
/// mint a placeholder.
pub struct TicketInputs<'a> {
    pub server_generation: &'a str,
    pub browser: &'a str,
    pub caller_id: &'a str,
    /// Unix seconds; the caller computes `now + TICKET_LIFETIME_SECONDS` (or
    /// less) so the server's remaining-lifetime check passes.
    pub exp: u64,
    pub binding_pub: &'a [u8; 32],
}

/// `ticketKey = HKDF-SHA-256(ikm=UTF8(localToken), salt="MBP1/nm-ticket/v1",
/// info="mac", L=32)` (§9.2).
pub fn derive_ticket_key(local_token: &str) -> [u8; 32] {
    let hkdf = Hkdf::<Sha256>::new(Some(TICKET_KEY_SALT), local_token.as_bytes());
    let mut ticket_key = [0_u8; 32];
    hkdf.expand(TICKET_KEY_INFO, &mut ticket_key)
        .expect("32 bytes is a valid HKDF-SHA-256 output length");
    ticket_key
}

/// The canonical MAC input (§9.2, field order fixed, independent of JSON key
/// order): the leading element is the fixed domain tag
/// `enc("mbp1-attestation")`, never the wire `purpose`.
pub fn ticket_canonical(inputs: &TicketInputs) -> Vec<u8> {
    let mut canonical =
        enc_ascii(TICKET_PURPOSE).expect("ticket domain tag is a static ASCII literal");
    canonical.extend(enc_u32_be(TICKET_V));
    canonical.extend(enc_u32_be(TICKET_PROTOCOL_VERSION));
    canonical.extend(
        enc_ascii(inputs.server_generation)
            .expect("server generation must be ASCII (endpoint.json invariant)"),
    );
    canonical.extend(
        enc_ascii(inputs.browser).expect("browser must be ASCII (caller identity invariant)"),
    );
    canonical.extend(
        enc_ascii(inputs.caller_id).expect("caller id must be ASCII (caller identity invariant)"),
    );
    canonical.extend(enc_u64_be(inputs.exp));
    canonical.extend(enc(inputs.binding_pub));
    canonical
}

/// `HMAC-SHA-256(ticketKey, canonical)` (§9.2).
pub fn ticket_mac(ticket_key: &[u8; 32], canonical: &[u8]) -> [u8; 32] {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(ticket_key).expect("HMAC-SHA-256 accepts a 32-byte key");
    mac.update(canonical);
    mac.finalize()
        .into_bytes()
        .as_slice()
        .try_into()
        .expect("HMAC-SHA-256 output is 32 bytes")
}

/// The wire form of an NM attestation ticket (§9.2), ready to embed in a
/// `requestPair` reply's `nmTicket` field. Never log or print this: `mac`
/// and `bindingPub` are ticket material (§11).
#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct NmTicket {
    pub v: u32,
    pub purpose: &'static str,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "serverGeneration")]
    pub server_generation: String,
    pub browser: String,
    #[serde(rename = "callerId")]
    pub caller_id: String,
    pub exp: u64,
    #[serde(rename = "bindingPub")]
    pub binding_pub: String,
    pub mac: String,
}

/// Mint a ticket: derive the key, build the canonical MAC input, MAC it, and
/// encode the wire form. `local_token` and every field of `inputs` must
/// already be trustworthy — this function only encodes, it never validates
/// provenance.
pub fn mint_ticket(local_token: &str, inputs: &TicketInputs) -> NmTicket {
    let ticket_key = derive_ticket_key(local_token);
    let canonical = ticket_canonical(inputs);
    let mac = ticket_mac(&ticket_key, &canonical);
    NmTicket {
        v: TICKET_V,
        purpose: TICKET_PURPOSE,
        protocol_version: TICKET_PROTOCOL_VERSION,
        server_generation: inputs.server_generation.to_owned(),
        browser: inputs.browser.to_owned(),
        caller_id: inputs.caller_id.to_owned(),
        exp: inputs.exp,
        binding_pub: base64url_encode(inputs.binding_pub),
        mac: base64url_encode(&mac),
    }
}

#[cfg(test)]
mod tests {
    use super::{TicketInputs, derive_ticket_key, mint_ticket, ticket_canonical, ticket_mac};
    use crate::canonical::base64url_encode;
    use crate::test_vectors::{hex, unhex, vectors};

    #[test]
    fn matches_normative_nm_ticket_vector() {
        let doc = vectors();
        let group = &doc["nmTicket"];
        let inputs = &group["inputs"];
        let expected = &group["expected"];

        let binding_pub_bytes = unhex(inputs["bindingPub"].as_str().expect("bindingPub"));
        let binding_pub: [u8; 32] = binding_pub_bytes.as_slice().try_into().expect("32 bytes");
        let local_token = inputs["localToken"].as_str().expect("localToken");
        let ticket_inputs = TicketInputs {
            server_generation: inputs["serverGeneration"]
                .as_str()
                .expect("serverGeneration"),
            browser: inputs["browser"].as_str().expect("browser"),
            caller_id: inputs["callerId"].as_str().expect("callerId"),
            exp: inputs["exp"].as_u64().expect("exp"),
            binding_pub: &binding_pub,
        };

        let key = derive_ticket_key(local_token);
        assert_eq!(
            hex(&key),
            expected["ticketKey"].as_str().expect("ticketKey")
        );

        let canonical = ticket_canonical(&ticket_inputs);
        assert_eq!(
            hex(&canonical),
            expected["canonical"].as_str().expect("canonical")
        );

        let mac = ticket_mac(&key, &canonical);
        assert_eq!(hex(&mac), expected["mac"].as_str().expect("mac"));

        let ticket = mint_ticket(local_token, &ticket_inputs);
        assert_eq!(ticket.v, 1);
        assert_eq!(ticket.purpose, "mbp1-attestation");
        assert_eq!(ticket.protocol_version, 1);
        assert_eq!(
            ticket.server_generation,
            inputs["serverGeneration"]
                .as_str()
                .expect("serverGeneration")
        );
        assert_eq!(ticket.browser, "chromium");
        assert_eq!(
            ticket.caller_id,
            inputs["callerId"].as_str().expect("callerId")
        );
        assert_eq!(ticket.exp, ticket_inputs.exp);
        // wire fields are base64url no-pad of the raw bytes
        assert_eq!(ticket.binding_pub, base64url_encode(&binding_pub));
        assert_eq!(ticket.mac, base64url_encode(&mac));
    }
}
