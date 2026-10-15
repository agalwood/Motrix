use serde::Serialize;

use crate::protocol::ErrorCode;
use crate::startup_task::StartupError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIdentity {
    pub name: String,
    pub publisher: String,
    pub publisher_id: String,
    pub family_name: String,
    pub full_name: String,
    pub version: String,
    pub architecture: String,
    pub resource_id: String,
}

pub trait PackageIdentityBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError>;
    fn package_identity(&mut self) -> Result<PackageIdentity, StartupError>;
}

pub fn execute(backend: &mut impl PackageIdentityBackend) -> Result<PackageIdentity, StartupError> {
    backend.require_package_identity()?;
    let identity = backend.package_identity()?;
    validate(&identity)?;
    Ok(identity)
}

fn text(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty())
        && value.encode_utf16().count() <= maximum
        && !value.chars().any(char::is_control)
}

fn validate(identity: &PackageIdentity) -> Result<(), StartupError> {
    let valid = text(&identity.name, 50, false)
        && identity.name.len() >= 3
        && identity
            .name
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b".-".contains(&value))
        && text(&identity.publisher, 8192, false)
        && text(&identity.publisher_id, 13, false)
        && identity.publisher_id.len() == 13
        && identity
            .publisher_id
            .bytes()
            .all(|value| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&value.to_ascii_lowercase()))
        && text(&identity.family_name, 64, false)
        && text(&identity.full_name, 256, false)
        && text(&identity.resource_id, 30, true)
        && identity
            .resource_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || b".-".contains(&value))
        && matches!(
            identity.architecture.as_str(),
            "x86" | "x64" | "arm" | "arm64" | "neutral" | "x86a64"
        )
        && identity
            .family_name
            .eq_ignore_ascii_case(&format!("{}_{}", identity.name, identity.publisher_id))
        && identity.full_name.eq_ignore_ascii_case(&format!(
            "{}_{}_{}_{}_{}",
            identity.name,
            identity.version,
            identity.architecture,
            identity.resource_id,
            identity.publisher_id
        ))
        && {
            let parts: Vec<_> = identity.version.split('.').collect();
            parts.len() == 4
                && parts.iter().all(|part| {
                    part.parse::<u16>()
                        .is_ok_and(|value| value.to_string() == *part)
                })
        };
    if valid {
        Ok(())
    } else {
        Err(StartupError::new(ErrorCode::PackageIdentityUnavailable))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Backend {
        present: bool,
        queried: bool,
        identity: Option<PackageIdentity>,
    }

    impl PackageIdentityBackend for Backend {
        fn require_package_identity(&mut self) -> Result<(), StartupError> {
            if self.present {
                Ok(())
            } else {
                Err(StartupError::new(ErrorCode::NoPackageIdentity))
            }
        }
        fn package_identity(&mut self) -> Result<PackageIdentity, StartupError> {
            self.queried = true;
            Ok(self.identity.take().unwrap())
        }
    }

    fn fixture() -> PackageIdentity {
        PackageIdentity {
            name: "Example.Package".into(),
            publisher: "CN=Example".into(),
            publisher_id: "123456789abcd".into(),
            family_name: "Example.Package_123456789abcd".into(),
            full_name: "Example.Package_1.0.0.0_x64__123456789abcd".into(),
            version: "1.0.0.0".into(),
            architecture: "x64".into(),
            resource_id: "".into(),
        }
    }

    #[test]
    fn queries_only_after_os_identity_preflight() {
        let mut backend = Backend {
            present: false,
            queried: false,
            identity: Some(fixture()),
        };
        assert_eq!(
            execute(&mut backend).unwrap_err().code,
            ErrorCode::NoPackageIdentity
        );
        assert!(!backend.queried);
        backend.present = true;
        assert_eq!(
            execute(&mut backend).unwrap().family_name,
            "Example.Package_123456789abcd"
        );
        assert!(backend.queried);
    }

    #[test]
    fn rejects_inconsistent_identifiers_and_unbounded_os_text() {
        for field in [
            "family",
            "full",
            "publisher",
            "version",
            "architecture",
            "resource",
        ] {
            let mut identity = fixture();
            match field {
                "family" => identity.family_name = "Other_123456789abcd".into(),
                "full" => identity.full_name = "Other_1.0.0.0_x64__123456789abcd".into(),
                "publisher" => identity.publisher = "x".repeat(8193),
                "version" => identity.version = "1.0.0.65536".into(),
                "architecture" => identity.architecture = "unknown".into(),
                "resource" => identity.resource_id = "\0".into(),
                _ => unreachable!(),
            }
            assert_eq!(
                validate(&identity).unwrap_err().code,
                ErrorCode::PackageIdentityUnavailable
            );
        }
    }

    #[test]
    fn serializes_only_the_identity_query_contract() {
        let response = crate::protocol::Response::from_operation_result(Ok(
            crate::protocol::OperationResult::PackageIdentity(fixture()),
        ));
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "version": 1, "ok": true, "packageIdentityPresent": true,
                "identity": {
                    "name": "Example.Package", "publisher": "CN=Example", "publisherId": "123456789abcd",
                    "familyName": "Example.Package_123456789abcd", "fullName": "Example.Package_1.0.0.0_x64__123456789abcd",
                    "version": "1.0.0.0", "architecture": "x64", "resourceId": ""
                }
            })
        );
    }

    #[test]
    fn identifier_case_is_preserved_but_compared_using_ascii_rules() {
        let mut identity = fixture();
        identity.family_name.make_ascii_uppercase();
        identity.full_name.make_ascii_uppercase();
        validate(&identity).unwrap();
        identity.publisher_id = "123456789abcu".into();
        assert_eq!(
            validate(&identity).unwrap_err().code,
            ErrorCode::PackageIdentityUnavailable
        );
    }
}
