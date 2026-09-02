use super::digest::hash_opened_file;
use super::metadata::{
    artifact_stamp, directory_entries, ensure_same_entry, stamp_stable_across_rename, stat_named,
    stat_opened,
};
use super::{ArtifactHandle, ArtifactStamp, TreeEntryKind, TreeEntrySnapshot};
use crate::path::validate_relative;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

fn assert_name_absent(parent: RawFd, name: &CString) -> io::Result<()> {
    match stat_named(parent, name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact name was replaced during removal",
        )),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn isolate_opened_for_removal(
    artifact: &ArtifactHandle,
    quarantine_relative: &str,
    resume_isolated: bool,
) -> io::Result<CString> {
    let parts = validate_relative(quarantine_relative)?;
    if parts.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "removal quarantine must be an immediate sibling",
        ));
    }
    let quarantine_name = CString::new(parts[0]).expect("validated component");
    if resume_isolated {
        if artifact.name.as_bytes() != quarantine_name.as_bytes() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "resumed removal handle does not name its quarantine",
            ));
        }
    } else {
        if artifact.name.as_bytes() == quarantine_name.as_bytes() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "removal quarantine must differ from the artifact name",
            ));
        }

        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                artifact.parent.as_raw_fd(),
                artifact.name.as_ptr(),
                artifact.parent.as_raw_fd(),
                quarantine_name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                artifact.parent.as_raw_fd(),
                artifact.name.as_ptr(),
                artifact.parent.as_raw_fd(),
                quarantine_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            ) as i32
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
    }

    let isolated = ensure_same_entry(
        artifact.artifact.as_raw_fd(),
        artifact.parent.as_raw_fd(),
        &quarantine_name,
    );
    if let Ok(isolated_stat) = isolated
        && (resume_isolated && artifact_stamp(&isolated_stat) == artifact.opened_stamp
            || !resume_isolated
                && stamp_stable_across_rename(
                    artifact_stamp(&isolated_stat),
                    artifact.opened_stamp,
                ))
    {
        if !resume_isolated {
            assert_name_absent(artifact.parent.as_raw_fd(), &artifact.name)?;
        }
        if unsafe { libc::fsync(artifact.parent.as_raw_fd()) } < 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(quarantine_name);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "artifact changed while isolating removal; preserved as {}",
            quarantine_name.to_string_lossy()
        ),
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn isolate_opened_for_removal(
    _artifact: &ArtifactHandle,
    quarantine_relative: &str,
    _resume_isolated: bool,
) -> io::Result<CString> {
    validate_relative(quarantine_relative)?;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic removal isolation is not implemented on this platform",
    ))
}

pub(super) fn snapshot_directory(directory: RawFd) -> io::Result<Vec<TreeEntrySnapshot>> {
    let mut snapshot = Vec::new();
    for name in directory_entries(directory)? {
        let named_stat = stat_named(directory, &name)?;
        let file_type = named_stat.st_mode & libc::S_IFMT;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if file_type == libc::S_IFDIR {
                libc::O_DIRECTORY
            } else {
                0
            };
        let child = unsafe { libc::openat(directory, name.as_ptr(), flags) };
        if child < 0 {
            return Err(io::Error::last_os_error());
        }
        let child = unsafe { OwnedFd::from_raw_fd(child) };
        let opened_stat = ensure_same_entry(child.as_raw_fd(), directory, &name)?;
        let opened_type = opened_stat.st_mode & libc::S_IFMT;
        let kind = if opened_type == libc::S_IFDIR {
            TreeEntryKind::Directory(snapshot_directory(child.as_raw_fd())?)
        } else if opened_type == libc::S_IFREG {
            TreeEntryKind::File
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "refusing to remove a symbolic link or special file",
            ));
        };
        snapshot.push(TreeEntrySnapshot {
            name,
            stamp: artifact_stamp(&opened_stat),
            kind,
        });
    }
    Ok(snapshot)
}

fn remove_directory_snapshot(directory: RawFd, snapshot: &[TreeEntrySnapshot]) -> io::Result<()> {
    let current = directory_entries(directory)?;
    if current.len() != snapshot.len()
        || current
            .iter()
            .zip(snapshot)
            .any(|(name, expected)| name.as_bytes() != expected.name.as_bytes())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "directory contents changed before removal",
        ));
    }

    for expected in snapshot {
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if matches!(&expected.kind, TreeEntryKind::Directory(_)) {
                libc::O_DIRECTORY
            } else {
                0
            };
        let child = unsafe { libc::openat(directory, expected.name.as_ptr(), flags) };
        if child < 0 {
            return Err(io::Error::last_os_error());
        }
        let child = unsafe { OwnedFd::from_raw_fd(child) };
        let opened_stat = ensure_same_entry(child.as_raw_fd(), directory, &expected.name)?;
        if artifact_stamp(&opened_stat) != expected.stamp {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "directory entry changed before removal",
            ));
        }
        match &expected.kind {
            TreeEntryKind::Directory(children) => {
                remove_directory_snapshot(child.as_raw_fd(), children)?;
                ensure_same_entry(child.as_raw_fd(), directory, &expected.name)?;
                if unsafe { libc::unlinkat(directory, expected.name.as_ptr(), libc::AT_REMOVEDIR) }
                    < 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            TreeEntryKind::File => {
                let before_unlink =
                    ensure_same_entry(child.as_raw_fd(), directory, &expected.name)?;
                if artifact_stamp(&before_unlink) != expected.stamp {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "file changed before removal",
                    ));
                }
                if unsafe { libc::unlinkat(directory, expected.name.as_ptr(), 0) } < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
        }
        assert_name_absent(directory, &expected.name)?;
    }
    if unsafe { libc::fsync(directory) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn remove_directory_contents(
    directory: RawFd,
    opened_stamp: ArtifactStamp,
    opened_tree: &[TreeEntrySnapshot],
) -> io::Result<()> {
    if !stamp_stable_across_rename(artifact_stamp(&stat_opened(directory)?), opened_stamp) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "directory changed after it was opened",
        ));
    }
    if !stamp_stable_across_rename(artifact_stamp(&stat_opened(directory)?), opened_stamp) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "directory changed while snapshotting removal",
        ));
    }
    remove_directory_snapshot(directory, opened_tree)
}

pub(crate) fn remove_opened(
    artifact: &ArtifactHandle,
    quarantine_relative: &str,
    resume_isolated: bool,
) -> io::Result<()> {
    let opened_stat = ensure_same_entry(
        artifact.artifact.as_raw_fd(),
        artifact.parent.as_raw_fd(),
        &artifact.name,
    )?;
    if artifact_stamp(&opened_stat) != artifact.opened_stamp {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact changed after it was opened",
        ));
    }
    // POSIX has no unlink-by-handle primitive. Atomically isolate the verified
    // name first, then bind the quarantine name back to the held descriptor.
    let isolated_name = isolate_opened_for_removal(artifact, quarantine_relative, resume_isolated)?;
    let file_type = opened_stat.st_mode & libc::S_IFMT;
    if file_type == libc::S_IFDIR {
        let opened_tree = artifact.opened_tree.as_deref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "opened directory is missing its held tree snapshot",
            )
        })?;
        remove_directory_contents(
            artifact.artifact.as_raw_fd(),
            artifact.opened_stamp,
            opened_tree,
        )?;
        ensure_same_entry(
            artifact.artifact.as_raw_fd(),
            artifact.parent.as_raw_fd(),
            &isolated_name,
        )?;
        if unsafe {
            libc::unlinkat(
                artifact.parent.as_raw_fd(),
                isolated_name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
    } else if file_type == libc::S_IFREG {
        let before_unlink = ensure_same_entry(
            artifact.artifact.as_raw_fd(),
            artifact.parent.as_raw_fd(),
            &isolated_name,
        )?;
        if !stamp_stable_across_rename(artifact_stamp(&before_unlink), artifact.opened_stamp) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "artifact changed before removal",
            ));
        }
        let opened_file_sha256 = artifact.opened_file_sha256.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "opened file is missing its held content digest",
            )
        })?;
        if hash_opened_file(artifact.artifact.as_raw_fd())? != opened_file_sha256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file content changed before removal",
            ));
        }
        if unsafe { libc::unlinkat(artifact.parent.as_raw_fd(), isolated_name.as_ptr(), 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "refusing to remove a symbolic link or special artifact",
        ));
    }
    assert_name_absent(artifact.parent.as_raw_fd(), &isolated_name)?;
    if unsafe { libc::fsync(artifact.parent.as_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
