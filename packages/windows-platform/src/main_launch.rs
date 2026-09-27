use std::thread;
use std::time::{Duration, Instant};

use crate::associations::{PackageApplications, verified_main_aumid};
use crate::protocol::ErrorCode;
use crate::startup_task::StartupError;

pub const LAUNCH_OPERATION_TIMEOUT: Duration = Duration::from_secs(4);

pub trait MainLaunchBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError>;
    fn applications_for_launch(&mut self) -> Result<PackageApplications, StartupError>;
    fn launch_main(&mut self, aumid: &str) -> Result<bool, StartupError>;
}

/// The caller cannot supply a target or arguments. Only the unique main entry
/// enumerated from the current OS package can reach the activation operation.
pub fn execute(backend: &mut impl MainLaunchBackend) -> Result<(), StartupError> {
    backend.require_package_identity()?;
    let aumid = verified_main_aumid(&backend.applications_for_launch()?)?;
    if !backend.launch_main(&aumid)? {
        return Err(StartupError::new(ErrorCode::LaunchRejected));
    }
    Ok(())
}

/// Both package enumeration and activation share one absolute deadline. This
/// supplements, rather than replaces, the caller's bounded helper process.
pub fn wait_for_operation<T>(
    deadline: Instant,
    mut poll: impl FnMut() -> Result<Option<T>, StartupError>,
    cancel: impl FnOnce(),
) -> Result<T, StartupError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            cancel();
            return Err(StartupError::new(ErrorCode::OperationTimedOut));
        }
        if let Some(value) = poll()? {
            if Instant::now() >= deadline {
                cancel();
                return Err(StartupError::new(ErrorCode::OperationTimedOut));
            }
            return Ok(value);
        }
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Backend {
        identity: bool,
        entries: Vec<String>,
        accepted: bool,
        calls: Vec<String>,
    }
    impl MainLaunchBackend for Backend {
        fn require_package_identity(&mut self) -> Result<(), StartupError> {
            self.calls.push("identity".into());
            self.identity
                .then_some(())
                .ok_or(StartupError::new(ErrorCode::NoPackageIdentity))
        }
        fn applications_for_launch(&mut self) -> Result<PackageApplications, StartupError> {
            self.calls.push("enumerate".into());
            Ok(PackageApplications {
                family_name: "Motrix.Store.Test_123456789abcd".into(),
                app_user_model_ids: self.entries.clone(),
            })
        }
        fn launch_main(&mut self, aumid: &str) -> Result<bool, StartupError> {
            self.calls.push(aumid.into());
            Ok(self.accepted)
        }
    }
    fn backend() -> Backend {
        Backend {
            identity: true,
            entries: vec!["Motrix.Store.Test_123456789abcd!Motrix".into()],
            accepted: true,
            calls: vec![],
        }
    }
    #[test]
    fn launches_only_verified_current_package_main() {
        let mut backend = backend();
        execute(&mut backend).unwrap();
        assert_eq!(
            backend.calls,
            [
                "identity",
                "enumerate",
                "Motrix.Store.Test_123456789abcd!Motrix"
            ]
        );
    }
    #[test]
    fn missing_identity_never_enumerates_or_launches() {
        let mut backend = backend();
        backend.identity = false;
        assert_eq!(
            execute(&mut backend).unwrap_err().code,
            ErrorCode::NoPackageIdentity
        );
        assert_eq!(backend.calls, ["identity"]);
    }
    #[test]
    fn missing_duplicate_or_foreign_main_never_activates() {
        for entries in [
            vec![],
            vec!["Other.Package_123456789abcd!Motrix".into()],
            vec!["Motrix.Store.Test_123456789abcd!MotrixNativeHost".into()],
            vec!["Motrix.Store.Test_123456789abcd!Motrix".into(); 2],
        ] {
            let mut backend = backend();
            backend.entries = entries;
            assert_eq!(
                execute(&mut backend).unwrap_err().code,
                ErrorCode::MainAppUnavailable
            );
            assert_eq!(backend.calls, ["identity", "enumerate"]);
        }
    }
    #[test]
    fn os_refusal_is_not_success() {
        let mut backend = backend();
        backend.accepted = false;
        assert_eq!(
            execute(&mut backend).unwrap_err().code,
            ErrorCode::LaunchRejected
        );
    }
    #[test]
    fn expired_deadline_cancels_without_polling() {
        let cancelled = Cell::new(false);
        assert_eq!(
            wait_for_operation::<()>(
                Instant::now(),
                || panic!("deadline already expired"),
                || cancelled.set(true)
            )
            .unwrap_err()
            .code,
            ErrorCode::OperationTimedOut
        );
        assert!(cancelled.get());
    }
    #[test]
    fn completed_or_failed_operation_does_not_wait_for_deadline() {
        assert_eq!(
            wait_for_operation(
                Instant::now() + Duration::from_secs(1),
                || Ok(Some(42)),
                || panic!("completed")
            )
            .unwrap(),
            42
        );
        assert_eq!(
            wait_for_operation::<()>(
                Instant::now() + Duration::from_secs(1),
                || Err(StartupError::new(ErrorCode::WinrtFailed)),
                || panic!("failed")
            )
            .unwrap_err()
            .code,
            ErrorCode::WinrtFailed
        );
    }
    #[test]
    fn pending_operation_is_cancelled_at_deadline() {
        let cancelled = Cell::new(false);
        assert_eq!(
            wait_for_operation::<()>(
                Instant::now() + Duration::from_millis(10),
                || Ok(None),
                || cancelled.set(true)
            )
            .unwrap_err()
            .code,
            ErrorCode::OperationTimedOut
        );
        assert!(cancelled.get());
    }
}
