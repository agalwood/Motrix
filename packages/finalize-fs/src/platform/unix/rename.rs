use super::{ArtifactHandle, RootHandle, assert_opened_artifact, open_parent};
use crate::path::validate_relative;
use std::ffi::CString;
use std::io;
use std::os::fd::AsRawFd;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn rename_opened_no_replace(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    let target_parts = validate_relative(target_relative)?;
    let target_parent = open_parent(target.0.as_raw_fd(), &target_parts)?;
    let target_name =
        CString::new(*target_parts.last().expect("nonempty")).expect("validated component");
    assert_opened_artifact(artifact, artifact.parent.as_raw_fd(), &artifact.name)?;

    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            artifact.parent.as_raw_fd(),
            artifact.name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            artifact.parent.as_raw_fd(),
            artifact.name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        ) as i32
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    assert_opened_artifact(artifact, target_parent.as_raw_fd(), &target_name)?;
    if unsafe { libc::fsync(target_parent.as_raw_fd()) } < 0
        || unsafe { libc::fsync(artifact.parent.as_raw_fd()) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn rename_opened_no_replace(
    _artifact: &ArtifactHandle,
    _target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    validate_relative(target_relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opened no-replace rename is not implemented on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn rename_no_replace(
    source: &RootHandle,
    source_relative: &str,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    let source_parts = validate_relative(source_relative)?;
    let target_parts = validate_relative(target_relative)?;
    let source_parent = open_parent(source.0.as_raw_fd(), &source_parts)?;
    let target_parent = open_parent(target.0.as_raw_fd(), &target_parts)?;
    let source_name =
        CString::new(*source_parts.last().expect("nonempty")).expect("validated component");
    let target_name =
        CString::new(*target_parts.last().expect("nonempty")).expect("validated component");

    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        ) as i32
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn rename_no_replace(
    _source: &RootHandle,
    source_relative: &str,
    _target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    validate_relative(source_relative)?;
    validate_relative(target_relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace rename is not implemented on this platform",
    ))
}
