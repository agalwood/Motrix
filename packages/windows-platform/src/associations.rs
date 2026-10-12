use crate::protocol::ErrorCode;
use crate::startup_task::StartupError;

pub const MAIN_APP_ID: &str = "Motrix";
// The Windows SDK's APPLICATION_USER_MODEL_ID_MAX_LENGTH is 130 including
// the UTF-16 terminator. Packaged identifiers can exceed the separate
// 128-character guidance for application-defined desktop identifiers.
pub const MAX_AUMID_UNITS: usize = 129;
pub const MAX_PACKAGE_APPLICATIONS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Association {
    Torrent,
    Magnet,
}

impl Association {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Torrent => ".torrent",
            Self::Magnet => "magnet",
        }
    }

    pub const fn is_protocol(self) -> bool {
        matches!(self, Self::Magnet)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct PackageApplications {
    pub family_name: String,
    pub app_user_model_ids: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct AssociationStatus {
    pub main_app_aumid: String,
    pub torrent: Option<bool>,
    pub magnet: Option<bool>,
}

pub trait AssociationsBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError>;
    fn package_applications(&mut self) -> Result<PackageApplications, StartupError>;
    fn default_aumid(&mut self, association: Association) -> Option<String>;
}

fn valid_aumid(value: &str) -> bool {
    // AUMIDs are bounded identifiers, not paths or commands. Treat malformed
    // shell output as unknown rather than reporting a different default app.
    !value.is_empty()
        && value.encode_utf16().count() <= MAX_AUMID_UNITS
        && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

pub fn verified_main_aumid(applications: &PackageApplications) -> Result<String, StartupError> {
    let family = &applications.family_name;
    let valid_family = family.split_once('_').is_some_and(|(name, publisher)| {
        (3..=50).contains(&name.len())
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
            && publisher.len() == 13
            && publisher
                .bytes()
                .all(|c| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&c.to_ascii_lowercase()))
    });
    if !valid_family || applications.app_user_model_ids.len() > MAX_PACKAGE_APPLICATIONS {
        return Err(StartupError::new(ErrorCode::MainAppUnavailable));
    }
    let candidate = format!("{family}!{MAIN_APP_ID}");
    if !valid_aumid(&candidate)
        || applications
            .app_user_model_ids
            .iter()
            .filter(|aumid| **aumid == candidate)
            .count()
            != 1
    {
        return Err(StartupError::new(ErrorCode::MainAppUnavailable));
    }
    // AppListEntry verifies the main app's identity only. It does not establish
    // that .torrent or magnet extensions are registered for this application.
    Ok(candidate)
}

pub fn execute(backend: &mut impl AssociationsBackend) -> Result<AssociationStatus, StartupError> {
    backend.require_package_identity()?;
    let main_app_aumid = verified_main_aumid(&backend.package_applications()?)?;
    let mut is_default = |association| {
        backend
            .default_aumid(association)
            .filter(|value| valid_aumid(value))
            .map(|value| value == main_app_aumid)
    };
    let torrent = is_default(Association::Torrent);
    let magnet = is_default(Association::Magnet);
    Ok(AssociationStatus {
        main_app_aumid,
        torrent,
        magnet,
    })
}

/// Execute the documented two-call AssocQueryStringW contract. An unavailable
/// association, legacy default without an AUMID, API failure, or concurrent
/// default change yields None; none of those establishes a different default.
pub fn query_aumid(mut query: impl FnMut(Option<&mut [u16]>, &mut u32) -> i32) -> Option<String> {
    let mut length = 0;
    // S_FALSE is required for the NULL-buffer sizing call, then S_OK for data.
    // https://learn.microsoft.com/windows/win32/api/shlwapi/nf-shlwapi-assocquerystringw
    if query(None, &mut length) != 1 || !(2..=MAX_AUMID_UNITS as u32 + 1).contains(&length) {
        return None;
    }
    // Nonzero initialization prevents an unwritten terminator from appearing
    // valid merely because Rust initialized the allocation with zeros.
    let mut buffer = vec![0xffff; length as usize];
    if query(Some(&mut buffer), &mut length) != 0 || length < 2 || length as usize > buffer.len() {
        return None;
    }
    let value = &buffer[..length as usize - 1];
    if buffer[length as usize - 1] != 0 || value.contains(&0) {
        return None;
    }
    let value = String::from_utf16(value).ok()?;
    valid_aumid(&value).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = "Motrix.Store.Test_123456789abcd";
    const MAIN: &str = "Motrix.Store.Test_123456789abcd!Motrix";

    struct FakeBackend {
        identity: Result<(), StartupError>,
        applications: Result<PackageApplications, StartupError>,
        defaults: [Option<String>; 2],
        calls: Vec<&'static str>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                identity: Ok(()),
                applications: Ok(PackageApplications {
                    family_name: FAMILY.into(),
                    app_user_model_ids: vec![format!("{FAMILY}!Helper"), MAIN.into()],
                }),
                defaults: [Some(MAIN.into()), None],
                calls: vec![],
            }
        }
    }

    impl AssociationsBackend for FakeBackend {
        fn require_package_identity(&mut self) -> Result<(), StartupError> {
            self.calls.push("identity");
            self.identity
        }
        fn package_applications(&mut self) -> Result<PackageApplications, StartupError> {
            self.calls.push("applications");
            std::mem::replace(
                &mut self.applications,
                Err(StartupError::new(ErrorCode::MainAppUnavailable)),
            )
        }
        fn default_aumid(&mut self, association: Association) -> Option<String> {
            self.calls.push(association.name());
            self.defaults[usize::from(association.is_protocol())].take()
        }
    }

    #[test]
    fn verifies_main_identity_before_independent_default_queries() {
        let mut backend = FakeBackend::new();
        assert_eq!(
            execute(&mut backend).unwrap(),
            AssociationStatus {
                main_app_aumid: MAIN.into(),
                torrent: Some(true),
                magnet: None,
            }
        );
        assert_eq!(
            backend.calls,
            ["identity", "applications", ".torrent", "magnet"]
        );
    }

    #[test]
    fn unknown_values_stay_unknown_and_other_valid_aumids_are_false() {
        for value in [
            None,
            Some(String::new()),
            Some("bad\0aumid".into()),
            Some("bad id".into()),
        ] {
            let mut backend = FakeBackend::new();
            backend.defaults = [value, Some("Another.Desktop.App".into())];
            let result = execute(&mut backend).unwrap();
            assert_eq!(result.torrent, None);
            assert_eq!(result.magnet, Some(false));
        }
    }

    #[test]
    fn requires_exact_main_entry_not_helper_or_other_package_or_case() {
        for entries in [
            vec![],
            vec![format!("{FAMILY}!Helper")],
            vec!["Other.Package_123456789abcd!Motrix".into()],
            vec![MAIN.to_lowercase()],
            vec![MAIN.into(), MAIN.into()],
            vec![MAIN.into(); MAX_PACKAGE_APPLICATIONS + 1],
        ] {
            let mut backend = FakeBackend::new();
            backend.applications.as_mut().unwrap().app_user_model_ids = entries;
            assert_eq!(
                execute(&mut backend).unwrap_err().code,
                ErrorCode::MainAppUnavailable
            );
            assert_eq!(backend.calls, ["identity", "applications"]);
        }
    }

    #[test]
    fn rejects_empty_oversized_or_injected_package_family() {
        for family in [
            "".into(),
            "x".repeat(128),
            "Bad!Motrix".into(),
            "Bad\0Family".into(),
            "Bad Family".into(),
            "a_123456789abcd".into(),
            "Example_123456789abci".into(),
            "Example_123456789abc".into(),
            "Example_extra_123456789abcd".into(),
        ] {
            assert_eq!(
                verified_main_aumid(&PackageApplications {
                    app_user_model_ids: vec![format!("{family}!Motrix")],
                    family_name: family,
                })
                .unwrap_err()
                .code,
                ErrorCode::MainAppUnavailable
            );
        }
    }

    #[test]
    fn valid_package_name_boundaries_and_uppercase_publisher_are_preserved() {
        for name in ["App".into(), "a".repeat(50)] {
            let family = format!("{name}_123456789ABCD");
            let main = format!("{family}!Motrix");
            assert_eq!(
                verified_main_aumid(&PackageApplications {
                    family_name: family,
                    app_user_model_ids: vec![main.clone()],
                }),
                Ok(main)
            );
        }
    }

    #[test]
    fn identity_and_winrt_failures_stop_before_shell_queries() {
        let mut backend = FakeBackend::new();
        backend.identity = Err(StartupError::new(ErrorCode::NoPackageIdentity));
        assert_eq!(
            execute(&mut backend).unwrap_err().code,
            ErrorCode::NoPackageIdentity
        );
        assert_eq!(backend.calls, ["identity"]);
        let mut backend = FakeBackend::new();
        let error = StartupError::with_hresult(ErrorCode::WinrtFailed, 0x80070005u32 as i32);
        backend.applications = Err(error);
        assert_eq!(execute(&mut backend), Err(error));
        assert_eq!(backend.calls, ["identity", "applications"]);
    }

    fn query_fixture(
        sizing_status: i32,
        capacity: u32,
        read_status: i32,
        written: u32,
        bytes: &[u16],
    ) -> (Option<String>, usize) {
        let mut calls = 0;
        let result = query_aumid(|buffer, length| {
            calls += 1;
            if let Some(buffer) = buffer {
                assert_eq!(*length, capacity);
                for (target, value) in buffer.iter_mut().zip(bytes) {
                    *target = *value;
                }
                *length = written;
                read_status
            } else {
                assert_eq!(*length, 0);
                *length = capacity;
                sizing_status
            }
        });
        (result, calls)
    }

    #[test]
    fn bounded_query_accepts_only_terminated_complete_utf16() {
        let bytes: Vec<_> = MAIN.encode_utf16().chain([0]).collect();
        assert_eq!(
            query_fixture(1, bytes.len() as u32, 0, bytes.len() as u32, &bytes),
            (Some(MAIN.into()), 2)
        );
        let maximum: Vec<_> = "x"
            .repeat(MAX_AUMID_UNITS)
            .encode_utf16()
            .chain([0])
            .collect();
        assert_eq!(
            query_fixture(1, 130, 0, 130, &maximum),
            (Some("x".repeat(MAX_AUMID_UNITS)), 2)
        );
    }

    #[test]
    fn failed_sizing_and_unbounded_lengths_never_allocate_or_read() {
        for status in [0, -1, 2, 0x80004005u32 as i32] {
            assert_eq!(query_fixture(status, 10, 0, 2, &[65, 0]), (None, 1));
        }
        for length in [0, 1, 131, 4096, u32::MAX] {
            assert_eq!(query_fixture(1, length, 0, 2, &[65, 0]), (None, 1));
        }
    }

    #[test]
    fn failures_races_empty_truncated_or_invalid_utf16_never_mean_false() {
        for (status, length, bytes) in [
            (-1, 2, vec![65, 0]),
            (1, 2, vec![65, 0]),
            (0, 0, vec![]),
            (0, 1, vec![0]),
            (0, 5, vec![65, 66, 67, 0]),
            (0, 2, vec![65]),
            (0, 4, vec![65, 0, 66, 0]),
            (0, 2, vec![0xd800, 0]),
            (0, 2, vec![0xdc00, 0]),
            (0, 2, vec![10, 0]),
            (0, 2, vec![32, 0]),
        ] {
            assert_eq!(query_fixture(1, 4, status, length, &bytes), (None, 2));
        }
    }
}
