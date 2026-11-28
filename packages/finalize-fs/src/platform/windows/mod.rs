//! Windows handle-relative filesystem operations with fail-closed reparse handling.

mod operations;
pub(crate) use operations::{
    copy_selected_file, create_private_root, open_selected_file, remove_private_root,
    root_identity, validate_root_identity,
};
mod copy;
mod digest;
mod metadata;
mod nt;
mod remove;

#[cfg(test)]
mod tests;

use crate::path::validate_relative;
use metadata::{
    ArtifactSnapshot, assert_name_absent, ensure_named_entry, ensure_snapshot, query_stamp,
};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::OwnedHandle;
use std::path::{Component, Path, PathBuf, Prefix};

pub(crate) use copy::copy_opened;
pub(crate) use remove::remove_opened;

use super::windows_policy::RenameRetryBudget;
use crate::error::operation_error;
use crate::rename::{RenameOutcome, sync_parents};

pub(crate) struct RootHandle {
    handle: OwnedHandle,
}

pub(crate) struct ArtifactHandle {
    handle: OwnedHandle,
    parent: OwnedHandle,
    name: Vec<u16>,
    snapshot: Option<ArtifactSnapshot>,
    stamp: metadata::FileStamp,
    rename_budget: RenameRetryBudget,
    rename_guard: bool,
}

pub(crate) fn open_root(path: &str) -> io::Result<RootHandle> {
    open_root_with_access(path, true)
}
pub(crate) fn open_root_with_access(path: &str, mutable: bool) -> io::Result<RootHandle> {
    let requested = Path::new(path);
    let (anchor, components) = split_absolute_root(requested)?;
    let mut current = nt::open_anchor(&anchor, mutable && components.is_empty())?;
    metadata::ensure_directory(&current)?;
    let component_count = components.len();
    for (index, component) in components.into_iter().enumerate() {
        current = if mutable && index + 1 == component_count {
            nt::open_mutable_directory(&current, &component)?
        } else {
            nt::open_existing_directory(&current, &component)?
        };
        metadata::ensure_directory(&current)?;
    }
    Ok(RootHandle { handle: current })
}

pub(crate) fn open_artifact(root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    open_artifact_internal(root, relative, true)
}

pub(crate) fn open_artifact_for_rename(
    root: &RootHandle,
    relative: &str,
) -> io::Result<ArtifactHandle> {
    open_artifact_internal(root, relative, false)
}

fn open_artifact_internal(
    root: &RootHandle,
    relative: &str,
    snapshot: bool,
) -> io::Result<ArtifactHandle> {
    let parts = validate_relative(relative)?;
    let (parent, name) = open_parent(&root.handle, &parts)?;
    let rename_budget = RenameRetryBudget::default();
    let handle = if snapshot {
        nt::open_existing(&parent, &name)?
    } else {
        rename_budget.run("open_source", "not_attempted", || {
            nt::open_existing(&parent, &name)
        })?
    };
    let stamp = query_stamp(&handle)?;
    let snapshot = if snapshot {
        Some(metadata::snapshot_opened(&handle)?)
    } else {
        None
    };
    ensure_named_entry(&handle, &parent, &name)?;
    Ok(ArtifactHandle {
        handle,
        parent,
        name,
        snapshot,
        stamp,
        rename_budget,
        rename_guard: false,
    })
}

/// Flush data before establishing the durable source stamp. The read handle
/// outlives the handle which performs the rename, so delayed change-time
/// updates from closing the renamer are observable while writes remain excluded.
pub(crate) fn open_rename_guard(
    root: &RootHandle,
    relative: &str,
) -> io::Result<Option<(ArtifactHandle, String)>> {
    let parts = validate_relative(relative)?;
    let (parent, name) = open_parent(&root.handle, &parts)?;
    let budget = RenameRetryBudget::default();
    let writer = budget.run("open_flush_file", "not_attempted", || {
        nt::open_flush_file(&parent, &name)
    })?;
    let flushed = query_stamp(&writer)?;
    nt::flush(&writer)?;
    let change_time = metadata::change_time(&writer)?;
    drop(writer);
    let handle = budget.run("open_guard", "not_attempted", || {
        nt::open_selected(&parent, &name)
    })?;
    let stamp = query_stamp(&handle)?;
    if !stamp.same_file_and_size(&flushed) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "source changed during flush handoff",
        ));
    }
    if stamp != flushed || metadata::change_time(&handle)? != change_time {
        // No journal exists yet. Verify content when this volume cannot
        // attest an uninterrupted flush-to-reader handoff using metadata.
        return Ok(None);
    }
    let Some(file_id) = metadata::journal_file_id(&handle)? else {
        return Ok(None);
    };
    ensure_named_entry(&handle, &parent, &name)?;
    Ok(Some((
        ArtifactHandle {
            handle,
            parent,
            name,
            stamp,
            rename_budget: budget,
            snapshot: None,
            rename_guard: true,
        },
        file_id,
    )))
}

pub(crate) fn rename_opened_no_replace(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<RenameOutcome> {
    if artifact.rename_guard {
        let renamer = artifact
            .rename_budget
            .run("open_source", "not_attempted", || {
                nt::open_rename_file(&artifact.parent, &artifact.name)
            })?;
        metadata::ensure_same_opened(&artifact.handle, &renamer)
            .map_err(|e| operation_error(e, "validate_source", "not_attempted", None))?;
        let result = rename_with_handle(artifact, &renamer, target, target_relative)?;
        drop(renamer);
        let verify_target = || {
            let parts = validate_relative(target_relative)?;
            let (parent, name) = open_parent(&target.handle, &parts)?;
            ensure_named_entry(&artifact.handle, &parent, &name)
        };
        verify_target().map_err(|e| operation_error(e, "verify_target", "applied", None))?;
        return Ok(result);
    }
    rename_with_handle(artifact, &artifact.handle, target, target_relative)
}

fn rename_with_handle(
    artifact: &ArtifactHandle,
    renamer: &OwnedHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<RenameOutcome> {
    let (target_parent, target_name, same_parent) = (|| {
        if let Some(snapshot) = &artifact.snapshot {
            ensure_snapshot(&artifact.handle, snapshot)?;
        } else if query_stamp(&artifact.handle)? != artifact.stamp {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "opened Windows artifact changed before rename",
            ));
        }
        ensure_named_entry(&artifact.handle, &artifact.parent, &artifact.name)?;
        let parts = validate_relative(target_relative)?;
        let (target_parent, target_name) = open_parent(&target.handle, &parts)?;
        let same_parent = metadata::same_parent_directory(&artifact.parent, &target_parent)?;
        Ok((target_parent, target_name, same_parent))
    })()
    .map_err(|e| operation_error(e, "validate_source", "not_attempted", None))?;
    nt::rename_no_replace_with_retry(
        renamer,
        &target_parent,
        &target_name,
        &artifact.rename_budget,
    )?;
    ensure_named_entry(&artifact.handle, &target_parent, &target_name)
        .and_then(|()| assert_name_absent(&artifact.parent, &artifact.name))
        .map_err(|e| operation_error(e, "verify_target", "applied", None))?;
    sync_parents(same_parent, |target| {
        nt::flush_directory(if target {
            &target_parent
        } else {
            &artifact.parent
        })
    })
}

pub(crate) fn rename_no_replace(
    source: &RootHandle,
    source_relative: &str,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<RenameOutcome> {
    let artifact = open_artifact(source, source_relative)?;
    rename_opened_no_replace(&artifact, target, target_relative)
}

#[cfg(test)]
pub(crate) fn sync_root(root: &RootHandle) -> io::Result<()> {
    sync_root_mode(root).map(|_| ())
}

pub(crate) fn sync_root_mode(root: &RootHandle) -> io::Result<&'static str> {
    nt::flush_directory(&root.handle)
}

fn open_parent(root: &OwnedHandle, parts: &[&str]) -> io::Result<(OwnedHandle, Vec<u16>)> {
    let mut current = root.try_clone()?;
    for component in &parts[..parts.len().saturating_sub(1)] {
        current = nt::open_mutable_directory(&current, &nt::wide_name(component)?)?;
        metadata::ensure_directory(&current)?;
    }
    Ok((
        current,
        nt::wide_name(parts.last().expect("validated relative path"))?,
    ))
}

fn split_absolute_root(path: &Path) -> io::Result<(PathBuf, Vec<Vec<u16>>)> {
    let mut parts = path.components();
    let prefix = match parts.next() {
        Some(Component::Prefix(prefix)) => prefix,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows root path must be absolute",
            ));
        }
    };
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::UNC(_, _) => {}
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows device and verbatim root paths are forbidden",
            ));
        }
    }
    if !matches!(parts.next(), Some(Component::RootDir)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows root path must include a volume root",
        ));
    }

    let mut anchor = PathBuf::from(prefix.as_os_str());
    anchor.push(Path::new(r"\"));
    let mut components = Vec::new();
    for component in parts {
        match component {
            Component::Normal(value) => {
                let value: Vec<u16> = value.encode_wide().collect();
                nt::validate_wide_name(&value)?;
                components.push(value);
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Windows root path traversal is forbidden",
                ));
            }
        }
    }
    Ok((anchor, components))
}
