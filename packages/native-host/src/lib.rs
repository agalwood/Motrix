pub mod broker_protocol;
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_allow_launch;

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
}
