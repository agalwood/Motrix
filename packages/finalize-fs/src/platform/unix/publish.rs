use super::metadata::{artifact_stamp, directory_entries, stat_opened};
use super::{ArtifactHandle, RootHandle, assert_opened_artifact};
use crate::error::native_error;
use crate::path::validate_relative;
use std::ffi::CString;
use std::io;
use std::os::fd::AsRawFd;

fn checked_name(relative: &str) -> io::Result<CString> {
    let parts = validate_relative(relative)?;
    if parts.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "publication requires an immediate child",
        ));
    }
    Ok(CString::new(relative).expect("validated name"))
}

fn unchanged_file(artifact: &ArtifactHandle) -> io::Result<libc::stat> {
    assert_opened_artifact(artifact, artifact.parent.as_raw_fd(), &artifact.name)?;
    let stat = stat_opened(artifact.artifact.as_raw_fd())?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || artifact_stamp(&stat) != artifact.opened_stamp
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "publication requires an unchanged regular file",
        ));
    }
    Ok(stat)
}

/// Install a second name. Source removal belongs to the durable host journal.
#[cfg(target_os = "linux")]
pub(crate) fn link_opened_no_replace(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    relative: &str,
) -> io::Result<()> {
    let name = checked_name(relative)?;
    unchanged_file(artifact)?;
    // Only this generated procfs reference follows a symlink. User paths are
    // still resolved beneath held, no-follow directory descriptors. Unlike
    // AT_EMPTY_PATH this does not require CAP_DAC_READ_SEARCH in containers.
    let source = format!("/proc/self/fd/{}", artifact.artifact.as_raw_fd());
    rustix::fs::linkat(
        rustix::fs::CWD,
        source,
        &target.0,
        &name,
        rustix::fs::AtFlags::SYMLINK_FOLLOW,
    )
    .map_err(|e| native_error(e.into(), "linkat(held_fd)", None))?;
    assert_opened_artifact(artifact, target.0.as_raw_fd(), &name)?;
    rustix::fs::fsync(&target.0)
        .map_err(|e| native_error(e.into(), "fsync(link_target_parent)", None))?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn link_opened_no_replace(
    _: &ArtifactHandle,
    _: &RootHandle,
    _: &str,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "held hard-link publication requires Linux procfs",
    ))
}

/// The host exclusively creates and journals this private directory before
/// moving a source name into it. Ordinary rename is confined to this namespace.
pub(crate) fn isolate_opened(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    relative: &str,
    expected_root_identity: &str,
) -> io::Result<()> {
    let name = checked_name(relative)?;
    let source = unchanged_file(artifact)?;
    let directory = stat_opened(target.0.as_raw_fd())?;
    if format!("{}:{}", directory.st_dev, directory.st_ino) != expected_root_identity
        || directory.st_mode & 0o777 != 0o700
        || directory.st_uid != source.st_uid
        || !directory_entries(target.0.as_raw_fd())?.is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "isolation requires an empty private directory owned by the artifact owner",
        ));
    }
    rustix::fs::renameat(&artifact.parent, &artifact.name, &target.0, &name)
        .map_err(|e| native_error(e.into(), "renameat(private_isolation)", None))?;
    assert_opened_artifact(artifact, target.0.as_raw_fd(), &name)?;
    rustix::fs::fsync(&target.0)
        .map_err(|e| native_error(e.into(), "fsync(isolation_directory)", None))?;
    rustix::fs::fsync(&artifact.parent)
        .map_err(|e| native_error(e.into(), "fsync(isolation_source_parent)", None))?;
    Ok(())
}

/// Validate the opened directory, including when resuming a cleanup after restart.
pub(crate) fn validate_root_identity(root: &RootHandle, expected: &str) -> io::Result<()> {
    let directory = stat_opened(root.0.as_raw_fd())?;
    if format!("{}:{}", directory.st_dev, directory.st_ino) != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "held directory identity changed",
        ));
    }
    Ok(())
}
