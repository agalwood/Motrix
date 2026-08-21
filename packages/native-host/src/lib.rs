pub mod broker_protocol;
pub mod caller;
pub mod canonical;
pub mod endpoint;
pub mod flatpak_companion;
pub mod launcher;
pub mod log;
pub mod probe;
pub mod protocol;
pub mod resolve;
pub mod runtime;
#[cfg(test)]
pub(crate) mod test_vectors;
pub mod ticket;
pub mod user_data;

use serde_json::Value;

pub const MOTRIX_FLATPAK_ID: &str = "app.motrix.native";

/// Preserve the v1 input semantics: any JSON object or array is accepted,
/// `action` is ignored, and only the literal boolean `true` enables launch.
pub fn parse_allow_launch(value: &Value) -> Option<bool> {
    match value {
        Value::Object(object) => Some(
            object
                .get("allowLaunch")
                .and_then(Value::as_bool)
                .is_some_and(|value| value),
        ),
        Value::Array(_) => Some(false),
        _ => None,
    }
}

/// A parsed Native Messaging request: either the v1 shape (`action` is
/// ignored beyond checking for the literal `allowLaunch: true`) or a
/// `bootstrap` request (`docs/bridge-pairing-protocol.md` §9.1) carrying an
/// extension's ephemeral binding key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostRequest {
    Legacy {
        allow_launch: bool,
    },
    Bootstrap {
        protocol_version: u32,
        binding_pub: [u8; 32],
        allow_launch: bool,
    },
}

/// Parses `{ action: "bootstrap", protocolVersion: 1, bindingPub, allowLaunch?
/// }` (§9.1) while preserving the v1 `parse_allow_launch` semantics for
/// anything else. A `bootstrap` object whose `protocolVersion` is not the
/// integer `1` or whose `bindingPub` does not base64url-decode to exactly 32
/// bytes is malformed input — handled exactly like any other malformed
/// input (`None`), never falling back to v1 semantics. `allowLaunch` keeps
/// the same literal-`true` rule as v1: an absent or non-boolean value means
/// `false`, so a bootstrap request that omits it never wakes Motrix.
pub fn parse_host_request(value: &Value) -> Option<HostRequest> {
    if let Value::Object(object) = value
        && object
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| action == "bootstrap")
    {
        let protocol_version = object.get("protocolVersion").and_then(Value::as_u64)?;
        if protocol_version != 1 {
            return None;
        }
        let binding_pub_text = object.get("bindingPub").and_then(Value::as_str)?;
        let binding_pub_bytes = canonical::base64url_decode(binding_pub_text)?;
        let binding_pub: [u8; 32] = binding_pub_bytes.try_into().ok()?;
        let allow_launch = parse_allow_launch(value)?;
        return Some(HostRequest::Bootstrap {
            protocol_version: 1,
            binding_pub,
            allow_launch,
        });
    }

    parse_allow_launch(value).map(|allow_launch| HostRequest::Legacy { allow_launch })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HostRequest, parse_allow_launch, parse_host_request};

    #[test]
    fn accepts_objects_and_only_literal_true_enables_launch() {
        assert_eq!(
            parse_allow_launch(&json!({ "allowLaunch": true })),
            Some(true)
        );
        assert_eq!(
            parse_allow_launch(&json!({ "allowLaunch": "true" })),
            Some(false)
        );
        assert_eq!(
            parse_allow_launch(&json!({ "action": "anything" })),
            Some(false)
        );
    }

    #[test]
    fn accepts_arrays_but_rejects_json_primitives() {
        assert_eq!(parse_allow_launch(&json!([])), Some(false));
        assert_eq!(parse_allow_launch(&json!(null)), None);
        assert_eq!(parse_allow_launch(&json!("start")), None);
        assert_eq!(parse_allow_launch(&json!(1)), None);
    }

    #[test]
    fn bootstrap_action_with_valid_binding_pub_parses() {
        let pub32 = crate::canonical::base64url_encode(&[7_u8; 32]);
        let parsed = parse_host_request(&json!({
            "action": "bootstrap",
            "protocolVersion": 1,
            "bindingPub": pub32,
            "allowLaunch": true
        }));
        assert!(matches!(
            parsed,
            Some(HostRequest::Bootstrap {
                protocol_version: 1,
                binding_pub,
                allow_launch: true
            }) if binding_pub == [7_u8; 32]
        ));
    }

    #[test]
    fn bootstrap_with_bad_version_or_binding_pub_is_malformed() {
        let pub32 = crate::canonical::base64url_encode(&[7_u8; 32]);
        assert!(
            parse_host_request(&json!({
                "action": "bootstrap",
                "protocolVersion": 2,
                "bindingPub": pub32
            }))
            .is_none()
        );
        assert!(
            parse_host_request(&json!({
                "action": "bootstrap",
                "protocolVersion": 1,
                "bindingPub": "AAAA"
            }))
            .is_none()
        );
        assert!(
            parse_host_request(&json!({ "action": "bootstrap", "protocolVersion": 1 })).is_none()
        );
    }

    #[test]
    fn non_bootstrap_inputs_keep_v1_semantics() {
        assert!(matches!(
            parse_host_request(&json!({ "action": "start", "allowLaunch": true })),
            Some(HostRequest::Legacy { allow_launch: true })
        ));
        assert!(matches!(
            parse_host_request(&json!([])),
            Some(HostRequest::Legacy {
                allow_launch: false
            })
        ));
        assert!(parse_host_request(&json!("start")).is_none());
    }
}
