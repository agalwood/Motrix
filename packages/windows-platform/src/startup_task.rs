use serde::Serialize;

use crate::protocol::{ErrorCode, Operation};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupState {
    Disabled,
    DisabledByUser,
    Enabled,
    DisabledByPolicy,
    EnabledByPolicy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartupError {
    pub code: ErrorCode,
    pub hresult: Option<i32>,
}

impl StartupError {
    pub const fn new(code: ErrorCode) -> Self {
        Self {
            code,
            hresult: None,
        }
    }

    pub const fn with_hresult(code: ErrorCode, hresult: i32) -> Self {
        Self {
            code,
            hresult: Some(hresult),
        }
    }
}

impl TryFrom<i32> for StartupState {
    type Error = StartupError;

    fn try_from(value: i32) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Disabled),
            1 => Ok(Self::DisabledByUser),
            2 => Ok(Self::Enabled),
            3 => Ok(Self::DisabledByPolicy),
            4 => Ok(Self::EnabledByPolicy),
            _ => Err(StartupError::new(ErrorCode::UnknownState)),
        }
    }
}

pub trait StartupBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError>;
    fn state(&mut self) -> Result<i32, StartupError>;
    fn request_enable(&mut self) -> Result<i32, StartupError>;
    fn disable(&mut self) -> Result<(), StartupError>;
}

pub fn execute(
    backend: &mut impl StartupBackend,
    operation: Operation,
) -> Result<StartupState, StartupError> {
    backend.require_package_identity()?;
    let current = StartupState::try_from(backend.state()?)?;
    // Preserve user and policy choices. The state returned by RequestEnableAsync
    // is authoritative even if it differs from the requested Enabled state.
    // https://learn.microsoft.com/uwp/api/windows.applicationmodel.startuptaskstate
    // https://learn.microsoft.com/uwp/api/windows.applicationmodel.startuptask.requestenableasync
    match (operation, current) {
        (Operation::StartupEnable, StartupState::Disabled) => {
            StartupState::try_from(backend.request_enable()?)
        }
        (Operation::StartupDisable, StartupState::Enabled) => {
            backend.disable()?;
            StartupState::try_from(backend.state()?)
        }
        _ => Ok(current),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakeBackend {
        identity: Result<(), StartupError>,
        states: VecDeque<Result<i32, StartupError>>,
        enabled: Result<i32, StartupError>,
        disabled: Result<(), StartupError>,
        calls: Vec<&'static str>,
    }

    impl FakeBackend {
        fn new(state: i32) -> Self {
            Self {
                identity: Ok(()),
                states: VecDeque::from([Ok(state), Ok(0)]),
                enabled: Ok(2),
                disabled: Ok(()),
                calls: Vec::new(),
            }
        }
    }

    impl StartupBackend for FakeBackend {
        fn require_package_identity(&mut self) -> Result<(), StartupError> {
            self.calls.push("identity");
            self.identity
        }
        fn state(&mut self) -> Result<i32, StartupError> {
            self.calls.push("state");
            self.states
                .pop_front()
                .expect("unexpected extra state query")
        }
        fn request_enable(&mut self) -> Result<i32, StartupError> {
            self.calls.push("enable");
            self.enabled
        }
        fn disable(&mut self) -> Result<(), StartupError> {
            self.calls.push("disable");
            self.disabled
        }
    }

    #[test]
    fn query_reads_each_of_the_five_states_without_mutation() {
        for state in 0..=4 {
            let mut backend = FakeBackend::new(state);
            assert_eq!(
                execute(&mut backend, Operation::StartupQuery),
                StartupState::try_from(state)
            );
            assert_eq!(backend.calls, ["identity", "state"]);
        }
    }

    #[test]
    fn enable_calls_winrt_only_for_disabled() {
        for state in 0..=4 {
            let mut backend = FakeBackend::new(state);
            let actual = execute(&mut backend, Operation::StartupEnable);
            if state == 0 {
                assert_eq!(actual, Ok(StartupState::Enabled));
                assert_eq!(backend.calls, ["identity", "state", "enable"]);
            } else {
                assert_eq!(actual, StartupState::try_from(state));
                assert_eq!(backend.calls, ["identity", "state"]);
            }
        }
    }

    #[test]
    fn disable_calls_winrt_and_requeries_only_for_enabled() {
        for state in 0..=4 {
            let mut backend = FakeBackend::new(state);
            let actual = execute(&mut backend, Operation::StartupDisable);
            if state == 2 {
                assert_eq!(actual, Ok(StartupState::Disabled));
                assert_eq!(backend.calls, ["identity", "state", "disable", "state"]);
            } else {
                assert_eq!(actual, StartupState::try_from(state));
                assert_eq!(backend.calls, ["identity", "state"]);
            }
        }
    }

    #[test]
    fn enable_returns_the_actual_result_including_user_or_policy_denial() {
        for final_state in 0..=4 {
            let mut backend = FakeBackend::new(0);
            backend.enabled = Ok(final_state);
            assert_eq!(
                execute(&mut backend, Operation::StartupEnable),
                StartupState::try_from(final_state)
            );
        }
    }

    #[test]
    fn disable_returns_the_actual_requeried_state_not_an_assumed_disabled_state() {
        let mut backend = FakeBackend::new(2);
        backend.states = VecDeque::from([Ok(2), Ok(4)]);
        assert_eq!(
            execute(&mut backend, Operation::StartupDisable),
            Ok(StartupState::EnabledByPolicy)
        );
    }

    #[test]
    fn missing_identity_stops_before_any_winrt_task_access() {
        let mut backend = FakeBackend::new(0);
        backend.identity = Err(StartupError::new(ErrorCode::NoPackageIdentity));
        assert_eq!(
            execute(&mut backend, Operation::StartupEnable)
                .unwrap_err()
                .code,
            ErrorCode::NoPackageIdentity
        );
        assert_eq!(backend.calls, ["identity"]);
    }

    #[test]
    fn task_and_state_failures_are_not_reinterpreted_as_disabled() {
        for code in [ErrorCode::TaskUnavailable, ErrorCode::WinrtFailed] {
            let error = StartupError::with_hresult(code, 0x80070005u32 as i32);
            let mut backend = FakeBackend::new(0);
            backend.states = VecDeque::from([Err(error)]);
            assert_eq!(execute(&mut backend, Operation::StartupEnable), Err(error));
            assert_eq!(backend.calls, ["identity", "state"]);
        }
    }

    #[test]
    fn mutation_errors_propagate_without_followup_mutations() {
        let error = StartupError::with_hresult(ErrorCode::WinrtFailed, -1);
        let mut backend = FakeBackend::new(0);
        backend.enabled = Err(error);
        assert_eq!(execute(&mut backend, Operation::StartupEnable), Err(error));
        assert_eq!(backend.calls, ["identity", "state", "enable"]);
        let mut backend = FakeBackend::new(2);
        backend.disabled = Err(error);
        assert_eq!(execute(&mut backend, Operation::StartupDisable), Err(error));
        assert_eq!(backend.calls, ["identity", "state", "disable"]);
        let mut backend = FakeBackend::new(2);
        backend.states = VecDeque::from([Ok(2), Err(error)]);
        assert_eq!(execute(&mut backend, Operation::StartupDisable), Err(error));
    }

    #[test]
    fn unknown_states_fail_before_mutation_or_after_the_final_result() {
        for state in [-1, 5, i32::MAX] {
            let mut backend = FakeBackend::new(state);
            assert_eq!(
                execute(&mut backend, Operation::StartupEnable)
                    .unwrap_err()
                    .code,
                ErrorCode::UnknownState
            );
            assert_eq!(backend.calls, ["identity", "state"]);
            let mut backend = FakeBackend::new(0);
            backend.enabled = Ok(state);
            assert_eq!(
                execute(&mut backend, Operation::StartupEnable)
                    .unwrap_err()
                    .code,
                ErrorCode::UnknownState
            );
            let mut backend = FakeBackend::new(2);
            backend.states = VecDeque::from([Ok(2), Ok(state)]);
            assert_eq!(
                execute(&mut backend, Operation::StartupDisable)
                    .unwrap_err()
                    .code,
                ErrorCode::UnknownState
            );
        }
    }
}
