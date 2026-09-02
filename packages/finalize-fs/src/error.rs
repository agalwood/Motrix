use std::io;

pub(crate) fn classify_error(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::AlreadyExists => "target_exists",
        io::ErrorKind::NotFound => "not_found",
        io::ErrorKind::InvalidInput => "invalid_path",
        io::ErrorKind::PermissionDenied => "permission_denied",
        io::ErrorKind::Unsupported => "unsupported",
        _ => match error.raw_os_error() {
            Some(libc::EXDEV) => "cross_device",
            Some(libc::ENOSYS) | Some(libc::ENOTSUP) => "unsupported",
            Some(libc::ELOOP) => "symlink_rejected",
            _ => "io_error",
        },
    }
}
