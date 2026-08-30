//! Extracts the browser-supplied caller identity from Native Messaging argv
//! (`docs/bridge-pairing-protocol.md` §9.1): Chromium passes the calling
//! extension's origin in argv, Firefox passes its extension ID as an
//! argument.
//!
//! This module validates only the *shape* of what it finds — it never
//! consults an allowlist. Whether an id is trusted is resolved downstream by
//! the server (§5's tri-state); a caller ID that shapes correctly but is not
//! on the allowlist is a legitimate `attested-non-official` outcome, not
//! something this module should reject. `flatpak_companion::validate_browser_
//! caller` reads the same argv shapes but additionally gates on the
//! allowlist — that gate is deliberately not replicated here.
//!
//! `caller_id` is required to be ASCII (`is_plausible_gecko_id` and the
//! Chromium `[a-p]{32}` shape both enforce this) so that a caller identity
//! produced here can never make `ticket::ticket_canonical`'s ASCII
//! `.expect()` panic: a malformed caller id must surface as `None` here,
//! never reach ticket minting, and let the caller degrade to a ticketless
//! reply instead of killing the host process.

/// A browser caller identity extracted from Native Messaging argv, still
/// unverified against any allowlist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallerIdentity {
    pub browser: &'static str,
    pub caller_id: String,
}

const CHROMIUM_ORIGIN_PREFIX: &str = "chrome-extension://";
const CHROMIUM_ID_LEN: usize = 32;
const MAX_GECKO_ID_LEN: usize = 128;

/// The allowlist regex shape (`trusted-extension-registry.ts`'s
/// `CHROME_ID_RE`): exactly 32 lowercase `[a-p]` characters.
fn is_chromium_extension_id_shape(id: &str) -> bool {
    id.len() == CHROMIUM_ID_LEN && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// A plausible Gecko extension ID: non-empty, bounded, ASCII, and either
/// `left@right` (an email-like id) or a `{uuid}`-braced form.
fn is_plausible_gecko_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_GECKO_ID_LEN || !id.is_ascii() {
        return false;
    }
    id.contains('@') || (id.starts_with('{') && id.ends_with('}') && id.len() >= 2)
}

/// Scans post-argv0 Native Messaging arguments for a browser caller
/// identity. Returns `None` for anything that does not match one of the two
/// documented shapes — including a well-positioned but malformed Chromium
/// origin or Firefox ID — rather than guessing.
pub fn extract_caller_identity<I: IntoIterator<Item = String>>(args: I) -> Option<CallerIdentity> {
    let args: Vec<String> = args.into_iter().collect();

    if let Some(first) = args.first()
        && let Some(origin) = first.strip_prefix(CHROMIUM_ORIGIN_PREFIX)
    {
        let candidate = origin.strip_suffix('/').unwrap_or(origin);
        if candidate.contains('/') || !is_chromium_extension_id_shape(candidate) {
            return None;
        }
        return Some(CallerIdentity {
            browser: "chromium",
            caller_id: candidate.to_owned(),
        });
    }

    if let [_, second] = args.as_slice()
        && is_plausible_gecko_id(second)
    {
        return Some(CallerIdentity {
            browser: "firefox",
            caller_id: second.clone(),
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::extract_caller_identity;

    #[test]
    fn chromium_origin_arg_yields_32_char_id() {
        let id = extract_caller_identity(vec![
            "chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/".into(),
        ])
        .expect("identity");
        assert_eq!(id.browser, "chromium");
        assert_eq!(id.caller_id, "ibpkjhgpbidfmbmomagmldcdlpbmchgi");
        // Windows: --parent-window may accompany the origin
        assert!(
            extract_caller_identity(vec![
                "chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/".into(),
                "--parent-window=42".into(),
            ])
            .is_some()
        );
    }

    #[test]
    fn firefox_manifest_path_plus_gecko_id_yields_firefox_identity() {
        let id = extract_caller_identity(vec![
            "/usr/lib/mozilla/native-messaging-hosts/app.motrix.bridge.json".into(),
            "motrix-extension@motrix.app".into(),
        ])
        .expect("identity");
        assert_eq!(id.browser, "firefox");
        assert_eq!(id.caller_id, "motrix-extension@motrix.app");
    }

    #[test]
    fn malformed_or_absent_identity_yields_none() {
        assert!(extract_caller_identity(Vec::<String>::new()).is_none());
        assert!(extract_caller_identity(vec!["chrome-extension://SHOUTING/".into()]).is_none());
        assert!(extract_caller_identity(vec!["chrome-extension://short/".into()]).is_none());
        assert!(
            extract_caller_identity(vec!["one".into(), "two".into(), "three".into()]).is_none()
        );
        assert!(
            extract_caller_identity(vec!["/path/manifest.json".into(), "no-at-sign".into()])
                .is_none()
        );
    }
}
