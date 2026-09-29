//! Narrow Windows compatibility decisions, also tested on non-Windows hosts.

pub(super) fn unsupported_information(code: Option<i32>) -> bool {
    // INVALID_FUNCTION, NOT_SUPPORTED, INVALID_PARAMETER, CALL_NOT_IMPLEMENTED,
    // INVALID_LEVEL. Sharing, permissions, disconnection and I/O are not fallbacks.
    matches!(code, Some(1 | 50 | 87 | 120 | 124))
}

pub(super) fn remote_directory_acknowledged(code: Option<i32>, smb2: bool) -> bool {
    smb2 && matches!(code, Some(1 | 50))
}

pub(super) fn is_online_smb2(protocol: u32, major: u16, flags: u32) -> bool {
    // WNNC_NET_SMB and REMOTE_PROTOCOL_INFO_FLAG_OFFLINE. A client-side
    // offline cache cannot attest that a remote server acknowledged a mutation.
    protocol == 0x0002_0000 && major >= 2 && flags & 0x2 == 0
}

/// Sharing/lock violations can be transient. ACCESS_DENIED is ambiguous: it
/// can mean either temporary interference or a permanent ACL denial. All three
/// receive bounded retries; no retry changes permissions or sharing policy.
pub(super) fn is_transient_rename_conflict(code: Option<i32>) -> bool {
    matches!(code, Some(5 | 32 | 33))
}

/// Exponential backoff between rename attempts, following surge's
/// `retryRename` (5 attempts, 50 ms base doubling). `attempt` is the zero-based
/// index of the attempt that just failed; `None` means the fifth attempt was
/// the last and the error must be reported to the journal recovery path.
pub(super) fn rename_retry_delay_ms(attempt: usize) -> Option<u64> {
    match attempt {
        0 => Some(50),
        1 => Some(100),
        2 => Some(200),
        3 => Some(400),
        _ => None,
    }
}

/// One wait budget follows a rename-only handle from admission through rename.
/// Successful opens do not reset the budget. Total deliberate waiting is at
/// most 750 ms; this does not impose a timeout on a blocking filesystem call.
#[derive(Default)]
pub(super) struct RenameRetryBudget(std::cell::Cell<usize>);

impl RenameRetryBudget {
    pub(super) fn run<T>(
        &self,
        stage: &'static str,
        mutation: &'static str,
        operation: impl FnMut() -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        self.run_with_sleep(stage, mutation, operation, |ms| {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        })
    }

    fn run_with_sleep<T>(
        &self,
        stage: &'static str,
        mutation: &'static str,
        mut operation: impl FnMut() -> std::io::Result<T>,
        mut sleep: impl FnMut(u64),
    ) -> std::io::Result<T> {
        let mut attempts = 0;
        loop {
            attempts += 1;
            let error = match operation() {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            let delay = is_transient_rename_conflict(crate::error::os_code(&error))
                .then(|| rename_retry_delay_ms(self.0.get()))
                .flatten();
            match delay {
                Some(ms) => {
                    self.0.set(self.0.get() + 1);
                    sleep(ms);
                }
                None => {
                    return Err(crate::error::operation_error(
                        error,
                        stage,
                        mutation,
                        Some(attempts),
                    ));
                }
            }
        }
    }
}

/// A failed capability query must not turn an operational error into a change
/// in path lookup semantics. Only known unsupported-information errors fall back.
pub(super) fn case_sensitive_query(result: std::io::Result<bool>) -> std::io::Result<bool> {
    match result {
        Err(error) if unsupported_information(crate::error::os_code(&error)) => Ok(false),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_query_only_falls_back_for_capability_errors() {
        assert!(case_sensitive_query(Ok(true)).unwrap());
        assert!(!case_sensitive_query(Ok(false)).unwrap());
        for code in [1, 50, 87, 120, 124] {
            assert!(!case_sensitive_query(Err(std::io::Error::from_raw_os_error(code))).unwrap());
        }
        for code in [5, 32, 53, 64, 1117] {
            assert_eq!(
                case_sensitive_query(Err(std::io::Error::from_raw_os_error(code)))
                    .unwrap_err()
                    .raw_os_error(),
                Some(code)
            );
        }
    }

    #[test]
    fn admission_and_rename_share_one_retry_budget() {
        let budget = RenameRetryBudget::default();
        let mut waits = Vec::new();
        let mut opens = 0;
        budget
            .run_with_sleep(
                "open_source",
                "not_attempted",
                || {
                    opens += 1;
                    if opens <= 2 {
                        Err(std::io::Error::from_raw_os_error(32))
                    } else {
                        Ok(())
                    }
                },
                |ms| waits.push(ms),
            )
            .unwrap();
        let error = budget
            .run_with_sleep::<()>(
                "rename",
                "unknown",
                || Err(std::io::Error::from_raw_os_error(5)),
                |ms| waits.push(ms),
            )
            .unwrap_err();
        assert_eq!(waits, vec![50, 100, 200, 400]);
        let context = crate::error::operation_context(&error).unwrap();
        assert_eq!(context.stage, "rename");
        assert_eq!(context.attempts, Some(3));
        assert_eq!(crate::error::os_code(&error), Some(5));
    }

    #[test]
    fn successful_mutations_and_non_conflict_errors_are_never_replayed() {
        let budget = RenameRetryBudget::default();
        budget.run("rename", "unknown", || Ok(())).unwrap();
        for code in [17, 87, 112, 183, 64] {
            let error = budget
                .run_with_sleep::<()>(
                    "rename",
                    "unknown",
                    || Err(std::io::Error::from_raw_os_error(code)),
                    |_| panic!("permanent or ambiguous transport errors must not retry"),
                )
                .unwrap_err();
            assert_eq!(
                crate::error::operation_context(&error).unwrap().attempts,
                Some(1)
            );
        }
    }

    #[test]
    fn remote_acknowledgement_requires_online_smb2_or_newer() {
        assert!(is_online_smb2(0x0002_0000, 2, 0));
        assert!(is_online_smb2(0x0002_0000, 3, 0x11));
        assert!(!is_online_smb2(0x0002_0000, 3, 0x2));
        assert!(!is_online_smb2(0x0002_0000, 1, 0));
        assert!(!is_online_smb2(0x0007_0000, 3, 0));
    }

    #[test]
    fn only_smb_directory_unsupported_errors_allow_server_acknowledgement() {
        for code in [1, 50] {
            assert!(remote_directory_acknowledged(Some(code), true));
            assert!(!remote_directory_acknowledged(Some(code), false));
        }
        for code in [5, 32, 53, 64, 87, 112, 121, 995, 1117] {
            assert!(!remote_directory_acknowledged(Some(code), true));
        }
        assert!(!remote_directory_acknowledged(None, true));
    }

    #[test]
    fn metadata_fallback_does_not_mask_operational_errors() {
        for code in [1, 50, 87, 120, 124] {
            assert!(unsupported_information(Some(code)));
        }
        for code in [5, 32, 53, 64, 112, 121, 995, 1117] {
            assert!(!unsupported_information(Some(code)));
        }
        assert!(!unsupported_information(None));
    }

    #[test]
    fn only_the_sharing_conflict_family_retries_windows_rename() {
        for code in [5, 32, 33] {
            assert!(is_transient_rename_conflict(Some(code)));
        }
        // FILE_NOT_FOUND, PATH_NOT_FOUND, NOT_SAME_DEVICE, INVALID_PARAMETER,
        // DISK_FULL, ALREADY_EXISTS report immediately.
        for code in [2, 3, 17, 87, 112, 183] {
            assert!(!is_transient_rename_conflict(Some(code)));
        }
        assert!(!is_transient_rename_conflict(None));
    }

    #[test]
    fn rename_backoff_follows_the_surge_retryrename_schedule() {
        // Five attempts total, so four doubling waits of 50 ms base between
        // them; the fifth failure is final and returns the error instead of
        // sleeping again.
        let schedule: &[(usize, Option<u64>)] = &[
            (0, Some(50)),
            (1, Some(100)),
            (2, Some(200)),
            (3, Some(400)),
            (4, None),
            (usize::MAX, None),
        ];
        for (attempt, expected) in schedule {
            assert_eq!(rename_retry_delay_ms(*attempt), *expected);
        }
        // Attempt exhaustion is independent of the error code: even a retryable
        // code stops after the fifth failure.
        for attempt in 4..=9 {
            assert!(is_transient_rename_conflict(Some(32)));
            assert_eq!(rename_retry_delay_ms(attempt), None);
        }
    }
}
