//! Handle-bound operation grants; no caller-supplied path is reopened during copying.
use super::{ArtifactHandle, RootHandle, metadata, nt};
use crate::path::validate_relative;
use std::fs::File;
use std::io::{self, Read, Seek};
use std::os::windows::ffi::OsStrExt;

fn leaf(name: &str) -> io::Result<Vec<u16>> {
    if validate_relative(name)?.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private directory must be a leaf",
        ));
    }
    Ok(std::ffi::OsStr::new(name).encode_wide().collect())
}
pub(crate) fn root_identity(root: &RootHandle) -> io::Result<String> {
    let (volume, file) = metadata::query_identity(&root.handle)?;
    Ok(format!("{volume}:{file:?}"))
}
pub(crate) fn validate_root_identity(root: &RootHandle, expected: &str) -> io::Result<()> {
    if root_identity(root)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "held directory identity changed",
        ));
    }
    Ok(())
}
pub(crate) fn create_private_root(parent: &RootHandle, name: &str) -> io::Result<RootHandle> {
    let handle = nt::create_private_directory(&parent.handle, &leaf(name)?)?;
    Ok(RootHandle { handle })
}
pub(crate) fn remove_private_root(
    parent: &RootHandle,
    name: &str,
    root: &RootHandle,
) -> io::Result<()> {
    metadata::ensure_named_entry(&root.handle, &parent.handle, &leaf(name)?)?;
    nt::mark_delete(&root.handle)
}
pub(crate) fn open_selected_file(root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    let parts = validate_relative(relative)?;
    let (parent, name) = super::open_parent(&root.handle, &parts)?;
    let handle = nt::open_selected(&parent, &name)?;
    let stamp = metadata::query_stamp(&handle)?;
    metadata::ensure_named_entry(&handle, &parent, &name)?;
    let file = ArtifactHandle {
        handle,
        parent,
        name,
        snapshot: None,
        stamp,
        rename_budget: Default::default(),
    };
    if file.stamp.directory || File::from(file.handle.try_clone()?).metadata()?.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "selection must be a nonempty regular file",
        ));
    }
    Ok(file)
}
pub(crate) fn copy_selected_file(
    file: &ArtifactHandle,
    target: &RootHandle,
    relative: &str,
) -> io::Result<()> {
    let check = || -> io::Result<()> {
        metadata::ensure_named_entry(&file.handle, &file.parent, &file.name)?;
        if file.stamp.directory || metadata::query_stamp(&file.handle)? != file.stamp {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "selected file changed",
            ));
        }
        Ok(())
    };
    check()?;
    let output = nt::create_file(&target.handle, &leaf(relative)?)?;
    let mut source = File::from(file.handle.try_clone()?);
    source.rewind()?;
    let mut destination = File::from(output);
    let expected = file.stamp.size as u64;
    if io::copy(&mut source.take(expected + 1), &mut destination)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "selected file length changed",
        ));
    }
    destination.sync_all()?;
    check()
}
