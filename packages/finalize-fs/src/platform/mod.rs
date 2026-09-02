//! Compile-time platform facade for handle-bound filesystem operations.

#[cfg(unix)]
mod unix;
#[cfg(not(any(unix, windows)))]
mod unsupported;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(crate) use unix::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_root, remove_opened,
    rename_no_replace, rename_opened_no_replace, sync_root,
};
#[cfg(not(any(unix, windows)))]
pub(crate) use unsupported::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_root, remove_opened,
    rename_no_replace, rename_opened_no_replace, sync_root,
};
#[cfg(windows)]
pub(crate) use windows::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_root, remove_opened,
    rename_no_replace, rename_opened_no_replace, sync_root,
};
