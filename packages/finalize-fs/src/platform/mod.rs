//! Compile-time platform facade for handle-bound filesystem operations.

#[cfg(target_os = "macos")]
pub(crate) use unix::{exfat_volume_identity, rename_opened_reserved, reserve_exfat_target};

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
    ArtifactHandle, RootHandle, copy_opened, copy_selected_file, create_private_root,
    open_artifact, open_artifact_for_rename, open_root, open_selected_file, remove_opened,
    remove_private_root, rename_no_replace, rename_opened_no_replace, root_identity, sync_root,
};
#[cfg(not(any(unix, windows)))]
pub(crate) use unsupported::{
    ArtifactHandle, RootHandle, copy_opened, copy_selected_file, create_private_root,
    open_artifact, open_artifact_for_rename, open_root, open_selected_file, remove_opened,
    remove_private_root, rename_no_replace, rename_opened_no_replace, root_identity, sync_root,
};
#[cfg(windows)]
pub(crate) use windows::{
    ArtifactHandle, RootHandle, copy_opened, copy_selected_file, create_private_root,
    open_artifact, open_artifact_for_rename, open_root, open_selected_file, remove_opened,
    remove_private_root, rename_no_replace, rename_opened_no_replace, root_identity,
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

#[cfg(unix)]
pub(crate) use unix::{
    isolate_opened, link_opened_no_replace, remove_opened_preserving, validate_root_identity,
};

#[cfg(not(unix))]
pub(crate) fn link_opened_no_replace(
    _: &ArtifactHandle,
    _: &RootHandle,
    _: &str,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "held hard-link publication is unsupported",
    ))
}

#[cfg(not(unix))]
pub(crate) fn isolate_opened(
    _: &ArtifactHandle,
    _: &RootHandle,
    _: &str,
    _: &str,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "private removal isolation is unsupported",
    ))
}

#[cfg(windows)]
pub(crate) use windows::validate_root_identity;

#[cfg(not(any(unix, windows)))]
pub(crate) fn validate_root_identity(_: &RootHandle, _: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Unix directory identity is unsupported",
    ))
}

pub(crate) fn open_root_for_selection(path: &str, read_only: bool) -> std::io::Result<RootHandle> {
    #[cfg(windows)]
    {
        if read_only {
            windows::open_root_with_access(path, false)
        } else {
            open_root(path)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = read_only;
        open_root(path)
    }
}
