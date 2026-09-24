use serde::Deserialize;

use super::CompanionError;

const EMBEDDED_ALLOWLIST: &str =
    include_str!("../../../../src/shared/config/native-messaging-extensions.json");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeMessagingAllowlist {
    pub chromium: Vec<String>,
    pub firefox: Vec<String>,
}

pub fn embedded_allowlist() -> Result<NativeMessagingAllowlist, CompanionError> {
    let allowlist: NativeMessagingAllowlist = serde_json::from_str(EMBEDDED_ALLOWLIST)
        .map_err(|error| CompanionError::new(format!("invalid embedded allowlist: {error}")))?;
    if allowlist.chromium.is_empty() || allowlist.firefox.is_empty() {
        return Err(CompanionError::new("embedded allowlist must not be empty"));
    }
    for id in &allowlist.chromium {
        if !is_chromium_extension_id(id) {
            return Err(CompanionError::new(format!(
                "invalid embedded Chromium extension ID: {id}"
            )));
        }
    }
    for id in &allowlist.firefox {
        if !is_firefox_extension_id(id) {
            return Err(CompanionError::new(format!(
                "invalid embedded Firefox extension ID: {id}"
            )));
        }
    }
    Ok(allowlist)
}

pub(super) fn is_chromium_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

pub(super) fn is_firefox_extension_id(id: &str) -> bool {
    let mut parts = id.split('@');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(left), Some(right), None) if !left.is_empty() && !right.is_empty()
            && !id.bytes().any(|byte| byte.is_ascii_whitespace())
    ) || (id.starts_with('{')
        && id.ends_with('}')
        && id.len() == 38
        && id[1..id.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
}
