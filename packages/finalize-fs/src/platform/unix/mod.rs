//! Unix handle ownership and descriptor-relative artifact admission.

mod copy;
mod digest;
mod metadata;
mod remove;
mod rename;

#[cfg(test)]
mod tests;

use crate::path::validate_relative;
use digest::hash_opened_file;
use metadata::artifact_stamp;
use remove::snapshot_directory;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path};

pub(crate) use copy::copy_opened;
pub(crate) use remove::remove_opened;
pub(crate) use rename::{rename_no_replace, rename_opened_no_replace};

pub(crate) struct RootHandle(OwnedFd);

pub(crate) struct ArtifactHandle {
    artifact: OwnedFd,
    parent: OwnedFd,
    name: CString,
    device: libc::dev_t,
    inode: libc::ino_t,
    opened_stamp: ArtifactStamp,
    opened_tree: Option<Vec<TreeEntrySnapshot>>,
    opened_file_sha256: Option<[u8; 32]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ArtifactStamp {
    device: libc::dev_t,
    inode: libc::ino_t,
    size: libc::off_t,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

struct TreeEntrySnapshot {
    name: CString,
    stamp: ArtifactStamp,
    kind: TreeEntryKind,
}

enum TreeEntryKind {
    File,
    Directory(Vec<TreeEntrySnapshot>),
}

pub(crate) fn open_root(path: &str) -> io::Result<RootHandle> {
    use std::os::unix::ffi::OsStrExt;

    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "root path must be absolute",
        ));
    }

    // O_NOFOLLOW on a complete path protects only its final component. Walk
    // from the filesystem root so every directory is resolved relative to an
    // already-held descriptor.
    let fd = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut current = unsafe { OwnedFd::from_raw_fd(fd) };
    for component in requested.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => {
                let part = CString::new(part.as_bytes()).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "root contains NUL")
                })?;
                let next = unsafe {
                    libc::openat(
                        current.as_raw_fd(),
                        part.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if next < 0 {
                    return Err(io::Error::last_os_error());
                }
                current = unsafe { OwnedFd::from_raw_fd(next) };
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "root path traversal is forbidden",
                ));
            }
        }
    }
    Ok(RootHandle(current))
}

fn open_parent(root: RawFd, parts: &[&str]) -> io::Result<OwnedFd> {
    let duplicate = unsafe { libc::fcntl(root, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut current = unsafe { OwnedFd::from_raw_fd(duplicate) };
    for part in &parts[..parts.len().saturating_sub(1)] {
        let part = CString::new(*part).expect("validated component");
        let next = unsafe {
            libc::openat(
                current.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if next < 0 {
            return Err(io::Error::last_os_error());
        }
        current = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok(current)
}

pub(crate) fn open_artifact(root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    let parts = validate_relative(relative)?;
    let parent = open_parent(root.0.as_raw_fd(), &parts)?;
    let name = CString::new(*parts.last().expect("nonempty")).expect("validated component");
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let artifact = unsafe { OwnedFd::from_raw_fd(fd) };
    let opened_stat = metadata::stat_opened(artifact.as_raw_fd())?;
    let named_stat = metadata::stat_named(parent.as_raw_fd(), &name)?;
    if opened_stat.st_dev != named_stat.st_dev || opened_stat.st_ino != named_stat.st_ino {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "artifact changed while opening",
        ));
    }
    let opened_type = opened_stat.st_mode & libc::S_IFMT;
    let opened_tree = if opened_type == libc::S_IFDIR {
        Some(snapshot_directory(artifact.as_raw_fd())?)
    } else if opened_type == libc::S_IFREG {
        None
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "refusing to open a symbolic link or special artifact",
        ));
    };
    let opened_file_sha256 = if opened_type == libc::S_IFREG {
        Some(hash_opened_file(artifact.as_raw_fd())?)
    } else {
        None
    };
    Ok(ArtifactHandle {
        artifact,
        parent,
        name,
        device: opened_stat.st_dev,
        inode: opened_stat.st_ino,
        opened_stamp: artifact_stamp(&opened_stat),
        opened_tree,
        opened_file_sha256,
    })
}

fn assert_opened_artifact(
    artifact: &ArtifactHandle,
    parent: RawFd,
    name: &CString,
) -> io::Result<()> {
    let opened_stat = metadata::stat_opened(artifact.artifact.as_raw_fd())?;
    let named_stat = metadata::stat_named(parent, name)?;
    if opened_stat.st_dev != artifact.device
        || opened_stat.st_ino != artifact.inode
        || named_stat.st_dev != artifact.device
        || named_stat.st_ino != artifact.inode
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened artifact identity mismatch",
        ));
    }
    Ok(())
}

pub(crate) fn sync_root(root: &RootHandle) -> io::Result<()> {
    if unsafe { libc::fsync(root.0.as_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
