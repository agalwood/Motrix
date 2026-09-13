//! Compile-time platform facade for handle-bound filesystem operations.

#[cfg(unix)]
mod unix;
#[cfg(not(any(unix, windows)))]
mod unsupported;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod windows_policy;

#[cfg(unix)]
pub(crate) use unix::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_artifact_for_rename, open_root,
    remove_opened, rename_no_replace, rename_opened_no_replace, sync_root,
};
#[cfg(not(any(unix, windows)))]
pub(crate) use unsupported::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_artifact_for_rename, open_root,
    remove_opened, rename_no_replace, rename_opened_no_replace, sync_root,
};
#[cfg(windows)]
pub(crate) use windows::{
    ArtifactHandle, RootHandle, copy_opened, open_artifact, open_artifact_for_rename, open_root,
    remove_opened, rename_no_replace, rename_opened_no_replace,
};

pub(crate) fn sync_root_mode(root: &RootHandle) -> std::io::Result<&'static str> {
    #[cfg(windows)]
    {
        windows::sync_root_mode(root)
    }
    #[cfg(not(windows))]
    {
        sync_root(root).map(|()| "directory_flushed")
    }
}
