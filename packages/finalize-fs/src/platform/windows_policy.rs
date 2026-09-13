//! Narrow Windows compatibility decisions, also tested on non-Windows hosts.

pub(super) fn unsupported_information(code: Option<i32>) -> bool {
    // INVALID_FUNCTION, NOT_SUPPORTED, INVALID_PARAMETER, CALL_NOT_IMPLEMENTED,
    // INVALID_LEVEL. Sharing, permissions, disconnection and I/O are not fallbacks.
    matches!(code, Some(1 | 50 | 87 | 120 | 124))
}

pub(super) fn remote_directory_acknowledged(code: Option<i32>, smb2: bool) -> bool {
    smb2 && matches!(code, Some(1 | 50))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
