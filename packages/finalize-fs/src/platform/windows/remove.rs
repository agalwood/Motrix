use super::ArtifactHandle;
use super::metadata::{
    ArtifactSnapshot, assert_name_absent, ensure_named_entry, ensure_snapshot, snapshot_opened,
};
use crate::path::validate_relative;
use std::io;
use std::os::windows::io::OwnedHandle;

pub(crate) fn remove_opened(
    artifact: &ArtifactHandle,
    quarantine_relative: &str,
    resume_isolated: bool,
) -> io::Result<()> {
    let parts = validate_relative(quarantine_relative)?;
    if parts.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "removal quarantine must be an immediate Windows sibling",
        ));
    }
    let quarantine_name = super::nt::wide_name(parts[0])?;
    ensure_snapshot(&artifact.handle, &artifact.snapshot)?;
    ensure_named_entry(&artifact.handle, &artifact.parent, &artifact.name)?;

    if resume_isolated {
        if artifact.name != quarantine_name {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "resumed Windows removal handle does not name its quarantine",
            ));
        }
    } else {
        if artifact.name == quarantine_name {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows removal quarantine must differ from the artifact name",
            ));
        }
        super::nt::rename_no_replace(&artifact.handle, &artifact.parent, &quarantine_name)?;
        ensure_named_entry(&artifact.handle, &artifact.parent, &quarantine_name)?;
        assert_name_absent(&artifact.parent, &artifact.name)?;
        super::nt::flush(&artifact.parent)?;
    }

    remove_snapshot(&artifact.handle, &artifact.snapshot)?;
    assert_name_absent(&artifact.parent, &quarantine_name)?;
    super::nt::flush(&artifact.parent)
}

fn remove_snapshot(handle: &OwnedHandle, expected: &ArtifactSnapshot) -> io::Result<()> {
    ensure_snapshot(handle, expected)?;
    if let ArtifactSnapshot::Directory { entries, .. } = expected {
        for entry in entries {
            let child = super::nt::open_existing(handle, &entry.name)?;
            ensure_named_entry(&child, handle, &entry.name)?;
            remove_snapshot(&child, &entry.artifact)?;
            drop(child);
            assert_name_absent(handle, &entry.name)?;
        }
        match snapshot_opened(handle)? {
            ArtifactSnapshot::Directory { entries, .. } if entries.is_empty() => {}
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows directory changed while it was being removed",
                ));
            }
        }
        super::nt::flush(handle)?;
    }
    super::nt::mark_delete(handle)
}
