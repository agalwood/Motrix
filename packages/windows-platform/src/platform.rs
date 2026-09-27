use crate::protocol::{Operation, OperationResult};
use crate::startup_task::StartupError;

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub fn execute(operation: Operation) -> Result<OperationResult, StartupError> {
    let mut backend = windows::WindowsBackend::default();
    match operation {
        Operation::AssociationsQuery => {
            crate::associations::execute(&mut backend).map(OperationResult::Associations)
        }
        _ => crate::startup_task::execute(&mut backend, operation).map(OperationResult::Startup),
    }
}

#[cfg(not(windows))]
pub fn execute(_: Operation) -> Result<OperationResult, StartupError> {
    // Non-Windows builds exist only for protocol/state-machine tests. Never
    // simulate a package identity or modify this host's startup configuration.
    Err(StartupError::new(
        crate::protocol::ErrorCode::NoPackageIdentity,
    ))
}
