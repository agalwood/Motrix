use std::io;

pub(crate) fn classify_error(error: &io::Error) -> &'static str {
    if let Some(code) = error
        .get_ref()
        .and_then(|e| e.downcast_ref::<NativeError>())
        .and_then(|e| e.code)
    {
        return code;
    }
    #[cfg(windows)]
    match os_code(error) {
        Some(17) => return "cross_device",
        Some(1 | 50 | 120 | 124) => return "unsupported",
        _ => {}
    }
    match error.kind() {
        io::ErrorKind::AlreadyExists => "target_exists",
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::InvalidInput => "invalid_path",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::Unsupported => "unsupported",
        #[cfg(windows)]
        _ => "io_error",
        #[cfg(not(windows))]
        _ => match os_code(error) {
            Some(libc::EXDEV) => "cross_device",
            Some(libc::ENOSYS) | Some(libc::ENOTSUP) => "unsupported",
            Some(libc::ELOOP) => "symlink_rejected",
            _ => "io_error",
        },
    }
}

#[derive(Debug)]
struct NativeError {
    code: Option<&'static str>,
    operation: String,
    source: io::Error,
    nt_status: Option<i32>,
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(output, "{}: {}", self.operation, self.source)?;
        if let Some(status) = self.nt_status {
            write!(output, " [NTSTATUS 0x{:08x}]", status as u32)?;
        }
        Ok(())
    }
}
impl std::error::Error for NativeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

pub(crate) fn native_error(
    error: io::Error,
    operation: impl Into<String>,
    nt_status: Option<i32>,
) -> io::Error {
    io::Error::new(
        error.kind(),
        NativeError {
            code: None,
            operation: operation.into(),
            source: error,
            nt_status,
        },
    )
}

pub(crate) fn os_code(error: &io::Error) -> Option<i32> {
    error.raw_os_error().or_else(|| {
        error
            .get_ref()?
            .downcast_ref::<NativeError>()?
            .source
            .raw_os_error()
    })
}

pub(crate) fn nt_status(error: &io::Error) -> Option<String> {
    error
        .get_ref()?
        .downcast_ref::<NativeError>()?
        .nt_status
        .map(|status| format!("0x{:08x}", status as u32))
}

#[cfg(unix)]
pub(crate) fn rename_error(error: io::Error, regular_file: bool) -> io::Error {
    let unsupported = matches!(
        error.raw_os_error(),
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP)
    );
    let code = (unsupported && regular_file).then_some("rename_unsupported");
    io::Error::new(
        error.kind(),
        NativeError {
            code,
            operation: "renameat_with(NOREPLACE)".into(),
            source: error,
            nt_status: None,
        },
    )
}

#[cfg(all(test, unix))]
mod rename_tests {
    use super::*;

    #[test]
    fn rename_capability_errors_keep_the_original_errno() {
        for code in [libc::EINVAL, libc::ENOSYS, libc::EOPNOTSUPP] {
            let error = rename_error(io::Error::from_raw_os_error(code), true);
            assert_eq!(classify_error(&error), "rename_unsupported");
            assert_eq!(os_code(&error), Some(code));
        }
        for code in [libc::EACCES, libc::ENOSPC, libc::EIO, libc::EROFS] {
            assert_ne!(
                classify_error(&rename_error(io::Error::from_raw_os_error(code), true)),
                "rename_unsupported"
            );
        }
        assert_eq!(
            classify_error(&io::Error::from_raw_os_error(libc::EINVAL)),
            "invalid_path"
        );
        assert_ne!(
            classify_error(&rename_error(
                io::Error::from_raw_os_error(libc::EINVAL),
                false
            )),
            "rename_unsupported"
        );
    }
}
