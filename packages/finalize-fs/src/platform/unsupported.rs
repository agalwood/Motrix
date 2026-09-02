//! Truthful unsupported backend for unimplemented target families.

use crate::path::validate_relative;
use std::io;

pub(crate) struct RootHandle;
pub(crate) struct ArtifactHandle;

pub(crate) fn open_root(_path: &str) -> io::Result<RootHandle> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "held root handles are not implemented on this platform",
    ))
}

pub(crate) fn open_artifact(_root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    validate_relative(relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "held artifact handles are not implemented on this platform",
    ))
}

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

pub(crate) fn copy_opened(
    _artifact: &ArtifactHandle,
    _target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    validate_relative(target_relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "handle-bound artifact copy is not implemented on this platform",
    ))
}

pub(crate) fn remove_opened(
    _artifact: &ArtifactHandle,
    quarantine_relative: &str,
    _resume_isolated: bool,
) -> io::Result<()> {
    validate_relative(quarantine_relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "handle-bound removal is not implemented on this platform",
    ))
}

pub(crate) fn sync_root(_root: &RootHandle) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory durability is not implemented on this platform",
    ))
}
