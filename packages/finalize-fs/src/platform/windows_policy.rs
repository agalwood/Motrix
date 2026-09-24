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

/// Rename errors that are transient in practice: antivirus scanners, search
/// indexers and recently closed handles hold the artifact or target name for a
/// few milliseconds. ACCESS_DENIED (5), SHARING_VIOLATION (32) and
/// LOCK_VIOLATION (33) only — real permission settings, invalid paths,
/// missing parents and cross-device moves are reported immediately.
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

#[cfg(test)]
mod tests {
    use super::*;

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
