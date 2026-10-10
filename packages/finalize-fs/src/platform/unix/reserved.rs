//! Compatibility publication for local macOS exFAT downloads. The final name
//! must remain application-owned between its last check and ordinary rename.
//! This deliberately does not implement the atomic no-replace contract.

use super::metadata::{artifact_stamp, ensure_same_entry, stat_named, stat_opened};
use super::{ArtifactHandle, RootHandle, assert_opened_artifact};
use crate::error::{native_error, operation_error};
use crate::rename::RenameOutcome;
use std::ffi::{CStr, CString};
use std::io;
use std::os::fd::AsRawFd;

fn identity(stat: &libc::stat) -> String {
    // Node BigIntStats exposes inode through a signed 64-bit slot. FSKit's
    // synthetic empty-file IDs set the high bit; preserve the host's existing
    // journal representation instead of changing identities of older records.
    format!("{}:{}", stat.st_dev, stat.st_ino as i64)
}

fn validate_scope(
    source: &ArtifactHandle,
    target: &std::os::fd::OwnedFd,
    name: &CStr,
) -> io::Result<()> {
    let from = stat_opened(source.parent.as_raw_fd())?;
    let to = stat_opened(target.as_raw_fd())?;
    let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(target.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fs = unsafe { fs.assume_init() };
    let fs_name = unsafe { CStr::from_ptr(fs.f_fstypename.as_ptr()) };
    if from.st_dev != to.st_dev
        || from.st_ino != to.st_ino
        || fs.f_flags & libc::MNT_LOCAL as u32 == 0
        || fs_name.to_bytes() != b"exfat"
        || source.name.to_bytes().strip_suffix(b".motrix") != Some(name.to_bytes())
        || name.to_bytes().is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "reserved rename requires same-directory suffix removal on local exFAT",
        ));
    }
    unchanged(source)?;
    Ok(())
}

fn unchanged(artifact: &ArtifactHandle) -> io::Result<libc::stat> {
    assert_opened_artifact(artifact, artifact.parent.as_raw_fd(), &artifact.name)?;
    let stat = stat_opened(artifact.artifact.as_raw_fd())?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_nlink != 1
        || artifact_stamp(&stat) != artifact.opened_stamp
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reserved publication artifact changed",
        ));
    }
    Ok(stat)
}

pub(crate) fn reserve_exfat_target(
    source: &ArtifactHandle,
    root: &RootHandle,
    relative: &str,
    expected: Option<&str>,
) -> io::Result<(ArtifactHandle, String)> {
    let parts = crate::path::validate_relative(relative)?;
    if parts.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reservation requires an immediate child",
        ));
    }
    let name = CString::new(relative).expect("validated component");
    validate_scope(source, &root.0, &name)
        .map_err(|e| operation_error(e, "validate_reservation", "not_attempted", None))?;
    let flags =
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC;
    let flags = if expected.is_some() {
        flags
    } else {
        flags | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL
    };
    let artifact = rustix::fs::openat(
        &root.0,
        &name,
        flags,
        rustix::fs::Mode::from_bits_truncate(0o600),
    )
    .map_err(|e| {
        operation_error(
            native_error(e.into(), "openat(exclusive_reservation)", None),
            "reserve_target",
            "unknown",
            None,
        )
    })?;
    // Never unlink on a failure: an unacknowledged reservation must be retained.
    let stat = ensure_same_entry(artifact.as_raw_fd(), root.0.as_raw_fd(), &name)?;
    let id = identity(&stat);
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_size != 0
        || stat.st_nlink != 1
        || expected.is_some_and(|expected| expected != id)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reservation identity mismatch",
        ));
    }
    rustix::fs::fsync(&artifact)?;
    rustix::fs::fsync(&root.0)?;
    Ok((
        ArtifactHandle {
            artifact,
            parent: root.0.try_clone()?,
            name,
            device: stat.st_dev,
            inode: stat.st_ino,
            opened_stamp: artifact_stamp(&stat),
            opened_link_count: stat.st_nlink,
            opened_tree: None,
            opened_file_sha256: None,
        },
        id,
    ))
}

pub(crate) fn rename_opened_reserved(
    source: &ArtifactHandle,
    reservation: &ArtifactHandle,
) -> io::Result<(RenameOutcome, String)> {
    let before = (|| {
        validate_scope(source, &reservation.parent, &reservation.name)?;
        let reserved = unchanged(reservation)?;
        if reserved.st_size != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reservation is not empty",
            ));
        }
        unchanged(source)
    })()
    .map_err(|e| operation_error(e, "validate_reservation", "not_attempted", None))?;
    rustix::fs::renameat(
        &source.parent,
        &source.name,
        &reservation.parent,
        &reservation.name,
    )
    .map_err(|e| {
        operation_error(
            native_error(e.into(), "renameat(owned_reservation)", None),
            "rename",
            "unknown",
            Some(1),
        )
    })?;
    let installed = (|| {
        // FSKit exFAT can change an empty file's ID during rename, including
        // the ID returned by the continuously held descriptor. Bind the new
        // name to that descriptor, rather than trusting an equal empty digest.
        let after = ensure_same_entry(
            source.artifact.as_raw_fd(),
            reservation.parent.as_raw_fd(),
            &reservation.name,
        )?;
        if after.st_dev != before.st_dev
            || after.st_size != before.st_size
            || after.st_mode & libc::S_IFMT != libc::S_IFREG
            || after.st_nlink != 1
            || after.st_mtime != before.st_mtime
            || after.st_mtime_nsec != before.st_mtime_nsec
            || (before.st_size != 0 && after.st_ino != before.st_ino)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "installed file changed",
            ));
        }
        match stat_named(source.parent.as_raw_fd(), &source.name) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(identity(&after)),
            Err(e) => Err(e),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "source name reappeared after publication",
            )),
        }
    })()
    .map_err(|e| operation_error(e, "verify_target", "applied", None))?;
    let outcome = crate::rename::sync_parents(true, |_| {
        rustix::fs::fsync(&reservation.parent)?;
        Ok("directory_flushed")
    })?;
    Ok((outcome, installed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Files(Vec<PathBuf>);
    impl Drop for Files {
        fn drop(&mut self) {
            for file in &self.0 {
                let _ = std::fs::remove_file(file);
            }
        }
    }

    fn scratch(parent: PathBuf) -> Scratch {
        let path = parent.join(format!(
            "motrix-reserved-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Scratch(path.canonicalize().unwrap())
    }

    #[test]
    fn reservation_rejects_other_filesystems_without_creating_a_target() {
        let dir = scratch(std::env::temp_dir());
        std::fs::write(dir.0.join("file.motrix"), b"source").unwrap();
        let root = super::super::open_root(dir.0.to_str().unwrap()).unwrap();
        let source = super::super::open_artifact_for_rename(&root, "file.motrix").unwrap();
        let error = reserve_exfat_target(&source, &root, "file", None)
            .err()
            .expect("non-exFAT root accepted");
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(!dir.0.join("file").exists());
    }

    #[test]
    #[ignore = "requires MOTRIX_FINALIZE_EXFAT_ROOT on a disposable local exFAT volume"]
    fn exfat_reservations_preserve_conflicts_and_publish_held_files() {
        let parent =
            PathBuf::from(std::env::var("MOTRIX_FINALIZE_EXFAT_ROOT").expect("exFAT test root"));
        let dir = scratch(parent.clone());
        // Also exercise a held volume root, with names unique to this fixture.
        let root_name = dir.0.file_name().unwrap().to_str().unwrap().to_owned() + "-payload";
        let from_name = format!("{root_name}.motrix");
        let files = Files(vec![parent.join(&from_name), parent.join(&root_name)]);
        let file = std::fs::File::create_new(&files.0[0]).unwrap();
        drop(file);
        let volume = super::super::open_root(parent.to_str().unwrap()).unwrap();
        let source = super::super::open_artifact_for_rename(&volume, &from_name).unwrap();
        let (reserved, _) = reserve_exfat_target(&source, &volume, &root_name, None).unwrap();
        rename_opened_reserved(&source, &reserved).unwrap();
        assert!(!files.0[0].exists());
        assert!(files.0[1].exists());
        let root = super::super::open_root(dir.0.to_str().unwrap()).unwrap();
        for (name, contents) in [
            ("empty", b"".as_slice()),
            ("download", b"complete download".as_slice()),
        ] {
            let source_name = format!("{name}.motrix");
            std::fs::write(dir.0.join(&source_name), contents).unwrap();
            let source = super::super::open_artifact_for_rename(&root, &source_name).unwrap();
            let (reserved, id) = reserve_exfat_target(&source, &root, name, None).unwrap();
            assert_eq!(
                reserve_exfat_target(&source, &root, name, None)
                    .err()
                    .unwrap()
                    .kind(),
                io::ErrorKind::AlreadyExists
            );
            assert!(reserve_exfat_target(&source, &root, name, Some("wrong-id")).is_err());
            let (reopened, _) = reserve_exfat_target(&source, &root, name, Some(&id)).unwrap();
            drop(reserved);
            let (outcome, installed) = rename_opened_reserved(&source, &reopened).unwrap();
            assert_eq!(outcome.directory_sync_mode, "directory_flushed");
            assert_eq!(
                installed,
                identity(&stat_named(root.0.as_raw_fd(), &CString::new(name).unwrap()).unwrap())
            );
            assert_eq!(std::fs::read(dir.0.join(name)).unwrap(), contents);
            assert!(!dir.0.join(&source_name).exists());
        }
        std::fs::write(dir.0.join("conflict.motrix"), b"download").unwrap();
        let source = super::super::open_artifact_for_rename(&root, "conflict.motrix").unwrap();
        let (reserved, _) = reserve_exfat_target(&source, &root, "conflict", None).unwrap();
        std::fs::rename(dir.0.join("conflict"), dir.0.join("old-reservation")).unwrap();
        std::fs::write(dir.0.join("conflict"), b"other owner").unwrap();
        let error = rename_opened_reserved(&source, &reserved).unwrap_err();
        assert_eq!(
            crate::error::operation_context(&error).unwrap().mutation,
            "not_attempted"
        );
        assert_eq!(
            std::fs::read(dir.0.join("conflict")).unwrap(),
            b"other owner"
        );
        assert_eq!(
            std::fs::read(dir.0.join("conflict.motrix")).unwrap(),
            b"download"
        );
    }
}
