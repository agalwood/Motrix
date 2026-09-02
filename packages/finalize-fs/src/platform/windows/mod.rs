//! Windows handle-relative filesystem operations with fail-closed reparse handling.

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

pub(crate) struct RootHandle {
    handle: OwnedHandle,
}

pub(crate) struct ArtifactHandle {
    handle: OwnedHandle,
    parent: OwnedHandle,
    name: Vec<u16>,
    snapshot: ArtifactSnapshot,
}

pub(crate) fn open_root(path: &str) -> io::Result<RootHandle> {
    let requested = Path::new(path);
    let (anchor, components) = split_absolute_root(requested)?;
    let mut current = nt::open_anchor(&anchor, components.is_empty())?;
    let anchor_stamp = query_stamp(&current)?;
    if !anchor_stamp.directory {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows root anchor is not a directory",
        ));
    }
    let component_count = components.len();
    for (index, component) in components.into_iter().enumerate() {
        current = if index + 1 == component_count {
            nt::open_mutable_directory(&current, &component)?
        } else {
            nt::open_existing_directory(&current, &component)?
        };
        if !query_stamp(&current)?.directory {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows root component is not a directory",
            ));
        }
    }
    Ok(RootHandle { handle: current })
}

pub(crate) fn open_artifact(root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    let parts = validate_relative(relative)?;
    let (parent, name) = open_parent(&root.handle, &parts)?;
    let handle = nt::open_existing(&parent, &name)?;
    let snapshot = metadata::snapshot_opened(&handle)?;
    ensure_named_entry(&handle, &parent, &name)?;
    Ok(ArtifactHandle {
        handle,
        parent,
        name,
        snapshot,
    })
}

pub(crate) fn rename_opened_no_replace(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    ensure_snapshot(&artifact.handle, &artifact.snapshot)?;
    ensure_named_entry(&artifact.handle, &artifact.parent, &artifact.name)?;
    let parts = validate_relative(target_relative)?;
    let (target_parent, target_name) = open_parent(&target.handle, &parts)?;
    nt::rename_no_replace(&artifact.handle, &target_parent, &target_name)?;
    ensure_named_entry(&artifact.handle, &target_parent, &target_name)?;
    assert_name_absent(&artifact.parent, &artifact.name)?;
    Ok(())
}

pub(crate) fn rename_no_replace(
    source: &RootHandle,
    source_relative: &str,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    let artifact = open_artifact(source, source_relative)?;
    rename_opened_no_replace(&artifact, target, target_relative)
}

pub(crate) fn sync_root(root: &RootHandle) -> io::Result<()> {
    nt::flush(&root.handle)
}

fn open_parent(root: &OwnedHandle, parts: &[&str]) -> io::Result<(OwnedHandle, Vec<u16>)> {
    let mut current = root.try_clone()?;
    for component in &parts[..parts.len().saturating_sub(1)] {
        current = nt::open_mutable_directory(&current, &nt::wide_name(component)?)?;
        if !query_stamp(&current)?.directory {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows path component is not a directory",
            ));
        }
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
