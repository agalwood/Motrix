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
}
