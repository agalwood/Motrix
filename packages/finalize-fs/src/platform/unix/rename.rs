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
    if super::metadata::artifact_stamp(&super::metadata::stat_opened(
        artifact.artifact.as_raw_fd(),
    )?) != artifact.opened_stamp
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened artifact changed before rename",
        ));
    }

    rustix::fs::renameat_with(
        &artifact.parent,
        &artifact.name,
        &target_parent,
        &target_name,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        crate::error::rename_error(
            error.into(),
            super::metadata::stat_opened(artifact.artifact.as_raw_fd())
                .is_ok_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFREG),
        )
    })?;
    assert_opened_artifact(artifact, target_parent.as_raw_fd(), &target_name)?;
    rustix::fs::fsync(&target_parent)
        .map_err(|e| crate::error::native_error(e.into(), "fsync(rename_target_parent)", None))?;
    rustix::fs::fsync(&artifact.parent)
        .map_err(|e| crate::error::native_error(e.into(), "fsync(rename_source_parent)", None))?;
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

    rustix::fs::renameat_with(
        &source_parent,
        &source_name,
        &target_parent,
        &target_name,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(|error| crate::error::native_error(error.into(), "renameat_with(NOREPLACE)", None))?;
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
