use super::metadata::{ArtifactSnapshot, content_matches, ensure_named_entry, ensure_snapshot};
use super::{ArtifactHandle, RootHandle, open_parent};
use crate::path::validate_relative;
use std::fs::File;
use std::io::{self, Seek};
use std::os::windows::io::OwnedHandle;

pub(crate) fn copy_opened(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    ensure_snapshot(&artifact.handle, &artifact.snapshot)?;
    ensure_named_entry(&artifact.handle, &artifact.parent, &artifact.name)?;

    let target_parts = validate_relative(target_relative)?;
    let (target_parent, target_name) = open_parent(&target.handle, &target_parts)?;
    materialize(
        &artifact.handle,
        &artifact.snapshot,
        &target_parent,
        &target_name,
    )?;
    ensure_snapshot(&artifact.handle, &artifact.snapshot)?;
    ensure_named_entry(&artifact.handle, &artifact.parent, &artifact.name)?;
    super::nt::flush(&target_parent)
}

fn materialize(
    source: &OwnedHandle,
    expected: &ArtifactSnapshot,
    target_parent: &OwnedHandle,
    target_name: &[u16],
) -> io::Result<()> {
    let target = if expected.is_directory() {
        super::nt::create_directory(target_parent, target_name)?
    } else {
        super::nt::create_file(target_parent, target_name)?
    };
    copy_into(source, expected, &target)?;
    let actual = super::metadata::snapshot_opened(&target)?;
    if !content_matches(expected, &actual) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows copied artifact does not match its held source",
        ));
    }
    super::nt::flush(&target)
}

fn copy_into(
    source: &OwnedHandle,
    expected: &ArtifactSnapshot,
    target: &OwnedHandle,
) -> io::Result<()> {
    ensure_snapshot(source, expected)?;
    match expected {
        ArtifactSnapshot::File { .. } => copy_file_contents(source, target)?,
        ArtifactSnapshot::Directory { entries, .. } => {
            for entry in entries {
                let source_child = super::nt::open_existing(source, &entry.name)?;
                ensure_snapshot(&source_child, &entry.artifact)?;
                materialize(&source_child, &entry.artifact, target, &entry.name)?;
                ensure_snapshot(&source_child, &entry.artifact)?;
            }
        }
    }
    ensure_snapshot(source, expected)
}

fn copy_file_contents(source: &OwnedHandle, target: &OwnedHandle) -> io::Result<()> {
    let mut source_file = File::from(source.try_clone()?);
    let mut target_file = File::from(target.try_clone()?);
    source_file.rewind()?;
    target_file.rewind()?;
    io::copy(&mut source_file, &mut target_file)?;
    target_file.sync_all()
}
