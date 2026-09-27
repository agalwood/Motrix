use crate::protocol::Operation;
use crate::startup_task::{StartupError, StartupState};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub fn execute(operation: Operation) -> Result<StartupState, StartupError> {
    crate::startup_task::execute(&mut windows::WindowsBackend::default(), operation)
}

#[cfg(not(windows))]
pub fn execute(_: Operation) -> Result<StartupState, StartupError> {
    // Non-Windows builds exist only for protocol/state-machine tests. Never
    // simulate a package identity or modify this host's startup configuration.
    Err(StartupError::new(
        crate::protocol::ErrorCode::NoPackageIdentity,
    ))
}
