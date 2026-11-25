//! Compatibility publication for macOS exFAT, Paragon NTFS, and SMB (smbfs) downloads.
//! The final name must remain application-owned between its last check and ordinary rename.
//! This deliberately does not implement the atomic no-replace contract.

use super::digest::Sha256State;
use super::metadata::{artifact_stamp, ensure_same_entry, stat_named, stat_opened};
use super::{ArtifactHandle, RootHandle, assert_opened_artifact};
use crate::error::{native_error, operation_error};
use crate::rename::RenameOutcome;
use std::ffi::{CStr, CString};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;

mod ntfs_volume;

fn fstype_bytes(fs: &libc::statfs) -> &[u8] {
    unsafe { CStr::from_ptr(fs.f_fstypename.as_ptr()) }.to_bytes()
}

fn is_local_reserved_filesystem(fs: &libc::statfs) -> bool {
    fs.f_flags & libc::MNT_LOCAL as u32 != 0 && matches!(fstype_bytes(fs), b"exfat" | b"ufsd_NTFS")
}

// macOS smbfs（网络 SMB 挂载）对目录 F_FULLFSYNC、renameatx_np(RENAME_EXCL) 与 linkat
// 均返回 ENOTSUP(45)，且 renameat 后路径派生的合成 st_ino 会变化 (#2549)。
fn is_macos_smbfs(fs: &libc::statfs) -> bool {
    fs.f_flags & libc::MNT_LOCAL as u32 == 0 && fstype_bytes(fs) == b"smbfs"
}

fn supported_filesystem(fs: &libc::statfs) -> bool {
    is_local_reserved_filesystem(fs) || is_macos_smbfs(fs)
}

fn smbfs_volume_identity(fs: &libc::statfs) -> io::Result<String> {
    let source = unsafe { CStr::from_ptr(fs.f_mntfromname.as_ptr()) }.to_bytes();
    if source.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "missing SMB mount source identity",
        ));
    }
    // 对挂载源做 SHA-256 截断为 32 位十六进制：既跨重挂载保持稳定，又避免将 SMB 凭据/主机名明文写入 journal。
    let mut hasher = Sha256State::new();
    hasher.update(b"macos-smbfs-v1\0");
    hasher.update(source);
    let digest = hasher.finalize();
    Ok(digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn identity(stat: &libc::stat) -> String {
    // Node BigIntStats exposes inode through a signed 64-bit slot. FSKit's
    // synthetic empty-file IDs set the high bit; preserve the host's existing
    // journal representation instead of changing identities of older records.
    format!("{}:{}", stat.st_dev, stat.st_ino as i64)
}

/// Query a persistent volume UUID, not the mount's transient device number.
pub(crate) fn exfat_volume_identity(root: &RootHandle) -> io::Result<Option<String>> {
    let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(root.0.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fs = unsafe { fs.assume_init() };
    if !supported_filesystem(&fs) {
        return Ok(None);
    }
    if is_macos_smbfs(&fs) {
        return smbfs_volume_identity(&fs).map(Some);
    }
    // Paragon rejects ATTR_VOL_UUID with EINVAL. Disk Arbitration supplies the
    // same persistent volume UUID without relying on transient st_dev values.
    if fstype_bytes(&fs) == b"ufsd_NTFS" {
        return ntfs_volume::volume_uuid(&fs).map(Some);
    }
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    // Darwin attribute buffers have a 4-byte length followed by the UUID.
    let mut buffer = [0_u8; 20];
    if unsafe {
        libc::fgetattrlist(
            root.0.as_raw_fd(),
            (&mut attributes as *mut libc::attrlist).cast(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if u32::from_ne_bytes(buffer[..4].try_into().unwrap()) != 20
        || buffer[4..].iter().all(|byte| *byte == 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "missing exFAT volume UUID",
        ));
    }
    Ok(Some(
        buffer[4..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

pub(super) fn sync_full_mode(fd: &std::os::fd::OwnedFd) -> io::Result<&'static str> {
    // std 在 Apple 平台默认调用 F_FULLFSYNC；对目录句柄，macOS smbfs 返回 ENOTSUP(45)
    // 但普通 fsync(dir_fd) 可正常完成，此时仅对 smbfs 降级并上报 remote_acknowledged (#2549)。
    match std::fs::File::from(fd.try_clone()?).sync_all() {
        Ok(()) => Ok("directory_flushed"),
        Err(err) if err.raw_os_error() == Some(libc::ENOTSUP) => {
            let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
            if unsafe { libc::fstatfs(fd.as_raw_fd(), fs.as_mut_ptr()) } == 0 {
                let fs = unsafe { fs.assume_init() };
                if is_macos_smbfs(&fs) {
                    if unsafe { libc::fsync(fd.as_raw_fd()) } < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok("remote_acknowledged");
                }
            }
            Err(err)
        }
        Err(err) => Err(err),
    }
}

pub(super) fn sync_full(fd: &std::os::fd::OwnedFd) -> io::Result<()> {
    sync_full_mode(fd).map(|_| ())
}

fn marker(token: &str) -> io::Result<Vec<u8>> {
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid reservation token",
        ));
    }
    Ok(format!("motrix-reservation-v1:{token}\n").into_bytes())
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
    if from.st_dev != to.st_dev
        || from.st_ino != to.st_ino
        || !supported_filesystem(&fs)
        || source.name.to_bytes().strip_suffix(b".motrix") != Some(name.to_bytes())
        || name.to_bytes().is_empty()
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "reserved rename requires same-directory suffix removal on exFAT, Paragon NTFS, or macOS SMB",
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
    ownership: Option<(&str, &str)>,
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
    let contents = ownership.map(|(token, _)| marker(token)).transpose()?;
    if let Some((_, volume)) = ownership
        && exfat_volume_identity(root)?.as_deref() != Some(volume)
    {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "reserved volume is unavailable",
        ));
    }
    let flags =
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC;
    // The token was persisted before CREATE. A lost response can therefore
    // reopen only the exact marker, even before its file ID was checkpointed.
    let (artifact, created) = if expected.is_none() {
        match rustix::fs::openat(
            &root.0,
            &name,
            flags | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL,
            rustix::fs::Mode::from_bits_truncate(0o600),
        ) {
            Ok(fd) => (fd, true),
            Err(rustix::io::Errno::EXIST) if contents.is_some() => (
                rustix::fs::openat(&root.0, &name, flags, rustix::fs::Mode::empty())?,
                false,
            ),
            Err(e) => {
                return Err(operation_error(
                    native_error(e.into(), "openat(exclusive_reservation)", None),
                    "reserve_target",
                    "unknown",
                    None,
                ));
            }
        }
    } else {
        (
            rustix::fs::openat(&root.0, &name, flags, rustix::fs::Mode::empty())?,
            false,
        )
    };
    if created && let Some(contents) = &contents {
        std::fs::File::from(artifact.try_clone()?).write_all(contents)?;
    }
    if created {
        let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(root.0.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let fs = unsafe { fs.assume_init() };
        if unsafe { CStr::from_ptr(fs.f_fstypename.as_ptr()) }.to_bytes() == b"ufsd_NTFS" {
            // Paragon defaults to whole-second timestamps and immediately
            // reuses the overwritten reservation inode. Give each new marker
            // a precise mtime so the host's inode/size/time digest cache cannot
            // mistake it for the preceding task's different ownership token.
            std::fs::File::from(artifact.try_clone()?).set_modified(std::time::SystemTime::now())?;
        }
    }
    // Never unlink on a failure: an unacknowledged reservation must be retained.
    let stat = ensure_same_entry(artifact.as_raw_fd(), root.0.as_raw_fd(), &name)?;
    let id = identity(&stat);
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG
        || stat.st_size != contents.as_ref().map_or(0, |bytes| bytes.len() as i64)
        || stat.st_nlink != 1
        || (contents.is_none() && expected.is_some_and(|expected| expected != id))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "reservation identity mismatch",
        ));
    }
    if let Some(contents) = &contents {
        let mut actual = vec![0; contents.len()];
        std::fs::File::from(artifact.try_clone()?).read_exact_at(&mut actual, 0)?;
        if actual != *contents {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reservation token mismatch",
            ));
        }
    }
    let digest = super::digest::hash_opened_file(artifact.as_raw_fd())?;
    sync_full(&artifact)?;
    sync_full(&root.0)?;
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
            metadata_removal: false,
            reservation_digest: Some(digest),
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
        unchanged(reservation)?;
        if reservation.reservation_digest
            != Some(super::digest::hash_opened_file(
                reservation.artifact.as_raw_fd(),
            )?)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reservation contents changed",
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
        let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(reservation.parent.as_raw_fd(), fs.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let fs = unsafe { fs.assume_init() };
        let allow_synthetic_inode = is_macos_smbfs(&fs);
        // FSKit exFAT 在空文件 rename 时可能变更文件 ID，macOS smbfs 在普通 renameat 后
        // 也会生成新的路径派生合成 st_ino。先通过 ensure_same_entry 证明打开句柄与目标路径
        // 指向同一文件，再在 smbfs 挂载上放宽跨 rename 的 st_ino 比较 (#2549)。
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
            || (!allow_synthetic_inode && before.st_size != 0 && after.st_ino != before.st_ino)
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
    let outcome = crate::rename::sync_parents(true, |_| sync_full_mode(&reservation.parent))?;
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
        let error = reserve_exfat_target(&source, &root, "file", None, None)
            .err()
            .expect("non-exFAT root accepted");
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(!dir.0.join("file").exists());
    }

    #[test]
    fn smbfs_detection_and_volume_identity_hash_mount_source() {
        let make_statfs = |fstype: &[u8], mntfrom: &[u8], flags: u32| {
            let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
            fs.f_flags = flags;
            for (dst, src) in fs.f_fstypename.iter_mut().zip(fstype.iter()) {
                *dst = *src as libc::c_char;
            }
            for (dst, src) in fs.f_mntfromname.iter_mut().zip(mntfrom.iter()) {
                *dst = *src as libc::c_char;
            }
            fs
        };

        let remote_smb = make_statfs(b"smbfs", b"//alice@nas.local/downloads", 0x18);
        assert!(is_macos_smbfs(&remote_smb));
        assert!(supported_filesystem(&remote_smb));

        let local_smb = make_statfs(
            b"smbfs",
            b"//alice@nas.local/downloads",
            libc::MNT_LOCAL as u32,
        );
        assert!(!is_macos_smbfs(&local_smb));
        assert!(!supported_filesystem(&local_smb));

        let remote_nfs = make_statfs(b"nfs", b"nas.local:/export", 0);
        assert!(!is_macos_smbfs(&remote_nfs));
        assert!(!supported_filesystem(&remote_nfs));

        let id1 = smbfs_volume_identity(&remote_smb).unwrap();
        let id2 = smbfs_volume_identity(&remote_smb).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 32);
        assert!(
            id1.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert!(!id1.contains("alice") && !id1.contains("nas"));

        let other_smb = make_statfs(b"smbfs", b"//alice@nas.local/media", 0x18);
        assert_ne!(id1, smbfs_volume_identity(&other_smb).unwrap());

        let empty_smb = make_statfs(b"smbfs", b"", 0x18);
        assert_eq!(
            smbfs_volume_identity(&empty_smb).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }

    #[test]
    #[ignore = "requires MOTRIX_FINALIZE_EXFAT_ROOT on a disposable local exFAT volume"]
    fn exfat_reservations_preserve_conflicts_and_publish_held_files() {
        let parent =
            PathBuf::from(std::env::var("MOTRIX_FINALIZE_EXFAT_ROOT").expect("exFAT test root"));
        check_reservations(parent, "directory_flushed");
    }

    #[test]
    #[ignore = "requires MOTRIX_FINALIZE_NTFS_ROOT on a writable Paragon NTFS volume"]
    fn ntfs_reservations_preserve_conflicts_and_publish_held_files() {
        let parent =
            PathBuf::from(std::env::var("MOTRIX_FINALIZE_NTFS_ROOT").expect("NTFS test root"));
        let root = super::super::open_root(parent.to_str().unwrap()).unwrap();
        let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        assert_eq!(
            unsafe { libc::fstatfs(root.0.as_raw_fd(), fs.as_mut_ptr()) },
            0
        );
        let fs = unsafe { fs.assume_init() };
        assert_eq!(
            fstype_bytes(&fs),
            b"ufsd_NTFS",
            "NTFS test root must use the Paragon driver"
        );
        let uuid = exfat_volume_identity(&root)
            .unwrap()
            .expect("persistent NTFS UUID");
        assert_eq!(uuid.len(), 32);
        check_reservations(parent, "directory_flushed");
    }

    #[test]
    #[ignore = "requires MOTRIX_FINALIZE_SMBFS_ROOT on a writable macOS SMB share"]
    fn smbfs_reservations_preserve_conflicts_and_publish_held_files() {
        let parent =
            PathBuf::from(std::env::var("MOTRIX_FINALIZE_SMBFS_ROOT").expect("SMB test root"));
        let root = super::super::open_root(parent.to_str().unwrap()).unwrap();
        let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        assert_eq!(
            unsafe { libc::fstatfs(root.0.as_raw_fd(), fs.as_mut_ptr()) },
            0
        );
        let fs = unsafe { fs.assume_init() };
        assert!(is_macos_smbfs(&fs), "SMB test root must use macOS smbfs");
        assert_eq!(
            super::super::sync_root_mode(&root).unwrap(),
            "remote_acknowledged"
        );
        let uuid = exfat_volume_identity(&root)
            .unwrap()
            .expect("persistent SMB share identity");
        assert_eq!(uuid.len(), 32);
        check_reservations(parent, "remote_acknowledged");
    }

    fn check_reservations(parent: PathBuf, expected_sync_mode: &str) {
        let dir = scratch(parent.clone());
        // Also exercise a held volume root, with names unique to this fixture.
        let root_name = dir.0.file_name().unwrap().to_str().unwrap().to_owned() + "-payload";
        let from_name = format!("{root_name}.motrix");
        let files = Files(vec![parent.join(&from_name), parent.join(&root_name)]);
        let file = std::fs::File::create_new(&files.0[0]).unwrap();
        drop(file);
        let volume = super::super::open_root(parent.to_str().unwrap()).unwrap();
        let source = super::super::open_artifact_for_rename(&volume, &from_name).unwrap();
        let (reserved, _) = reserve_exfat_target(&source, &volume, &root_name, None, None).unwrap();
        rename_opened_reserved(&source, &reserved).unwrap();
        assert!(!files.0[0].exists());
        assert!(files.0[1].exists());
        let root = super::super::open_root(dir.0.to_str().unwrap()).unwrap();
        for (name, contents) in [
            ("empty", b"".as_slice()),
            ("download", b"complete download".as_slice()),
            ("中文视频.mp4", b"unicode download".as_slice()),
        ] {
            let source_name = format!("{name}.motrix");
            std::fs::write(dir.0.join(&source_name), contents).unwrap();
            let source = super::super::open_artifact_for_rename(&root, &source_name).unwrap();
            let (reserved, id) = reserve_exfat_target(&source, &root, name, None, None).unwrap();
            assert_eq!(
                reserve_exfat_target(&source, &root, name, None, None)
                    .err()
                    .unwrap()
                    .kind(),
                io::ErrorKind::AlreadyExists
            );
            assert!(reserve_exfat_target(&source, &root, name, Some("wrong-id"), None).is_err());
            let (reopened, _) =
                reserve_exfat_target(&source, &root, name, Some(&id), None).unwrap();
            drop(reserved);
            let (outcome, installed) = rename_opened_reserved(&source, &reopened).unwrap();
            assert_eq!(outcome.directory_sync_mode, expected_sync_mode);
            assert_eq!(
                installed,
                identity(&stat_named(root.0.as_raw_fd(), &CString::new(name).unwrap()).unwrap())
            );
            assert_eq!(std::fs::read(dir.0.join(name)).unwrap(), contents);
            assert!(!dir.0.join(&source_name).exists());
        }
        let volume_id = exfat_volume_identity(&root).unwrap().unwrap();
        std::fs::write(dir.0.join("token.motrix"), b"download").unwrap();
        let source = super::super::open_artifact_for_rename(&root, "token.motrix").unwrap();
        let token = "a".repeat(64);
        let ownership = Some((token.as_str(), volume_id.as_str()));
        assert!(
            reserve_exfat_target(
                &source,
                &root,
                "token",
                None,
                Some((&token, "wrong-volume"))
            )
            .is_err()
        );
        assert!(!dir.0.join("token").exists());
        let (reserved, _) = reserve_exfat_target(&source, &root, "token", None, ownership).unwrap();
        assert_eq!(
            std::fs::read(dir.0.join("token")).unwrap(),
            marker(&token).unwrap()
        );
        let unreserved = super::super::open_artifact(&root, "token").unwrap();
        assert!(rename_opened_reserved(&source, &unreserved).is_err());
        assert!(dir.0.join("token.motrix").exists());
        // No acknowledged file ID is needed when the pre-journaled token matches.
        let (reopened, _) = reserve_exfat_target(&source, &root, "token", None, ownership).unwrap();
        assert!(
            reserve_exfat_target(
                &source,
                &root,
                "token",
                None,
                Some((&"b".repeat(64), &volume_id))
            )
            .is_err()
        );
        drop(reserved);
        rename_opened_reserved(&source, &reopened).unwrap();
        assert_eq!(std::fs::read(dir.0.join("token")).unwrap(), b"download");

        std::fs::write(dir.0.join("conflict.motrix"), b"download").unwrap();
        let source = super::super::open_artifact_for_rename(&root, "conflict.motrix").unwrap();
        let (reserved, _) = reserve_exfat_target(&source, &root, "conflict", None, None).unwrap();
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
