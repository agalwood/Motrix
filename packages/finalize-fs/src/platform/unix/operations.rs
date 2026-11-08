//! Non-destructive selected-file copies and private output staging.
use super::{
    ArtifactHandle, RootHandle, artifact_stamp, metadata, open_artifact_for_rename, open_parent,
};
use crate::path::validate_relative;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Seek};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

pub(crate) fn root_identity(root: &RootHandle) -> io::Result<String> {
    let s = metadata::stat_opened(root.0.as_raw_fd())?;
    Ok(format!("{}:{}", s.st_dev, s.st_ino))
}

pub(crate) fn create_private_root(parent: &RootHandle, name: &str) -> io::Result<RootHandle> {
    let parts = validate_relative(name)?;
    if parts.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private directory must be a leaf",
        ));
    }
    let name = CString::new(name)?;
    if unsafe { libc::mkdirat(parent.0.as_raw_fd(), name.as_ptr(), 0o700) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe {
        libc::openat(
            parent.0.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let stat = metadata::ensure_same_entry(fd.as_raw_fd(), parent.0.as_raw_fd(), &name)?;
    if stat.st_mode & 0o777 != 0o700 || stat.st_uid != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "operation staging requires a private directory",
        ));
    }
    Ok(RootHandle(fd))
}

pub(crate) fn remove_private_root(
    parent: &RootHandle,
    name: &str,
    root: &RootHandle,
) -> io::Result<()> {
    if validate_relative(name)?.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private directory must be a leaf",
        ));
    }
    let name = CString::new(name)?;
    metadata::ensure_same_entry(root.0.as_raw_fd(), parent.0.as_raw_fd(), &name)?;
    if unsafe { libc::unlinkat(parent.0.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn open_selected_file(root: &RootHandle, relative: &str) -> io::Result<ArtifactHandle> {
    let file = open_artifact_for_rename(root, relative)?;
    let s = metadata::stat_opened(file.artifact.as_raw_fd())?;
    if s.st_mode & libc::S_IFMT != libc::S_IFREG || s.st_size <= 0 {
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
        let s = metadata::ensure_same_entry(
            file.artifact.as_raw_fd(),
            file.parent.as_raw_fd(),
            &file.name,
        )?;
        if s.st_mode & libc::S_IFMT != libc::S_IFREG || artifact_stamp(&s) != file.opened_stamp {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "selected file changed",
            ));
        }
        Ok(())
    };
    check()?;
    let parts = validate_relative(relative)?;
    let parent = open_parent(target.0.as_raw_fd(), &parts)?;
    let name = CString::new(*parts.last().expect("nonempty"))?;
    #[cfg(target_os = "macos")]
    if unsafe {
        libc::fclonefileat(
            file.artifact.as_raw_fd(),
            parent.as_raw_fd(),
            name.as_ptr(),
            0,
        )
    } == 0
    {
        check()?;
        return Ok(());
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let expected = file.opened_stamp.size as u64;
    let mut input = File::from(file.artifact.try_clone()?);
    input.rewind()?;
    let mut output = File::from(fd);
    if io::copy(&mut input.take(expected + 1), &mut output)? != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "selected file length changed",
        ));
    }
    output.sync_all()?;
    check()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static ID: AtomicU64 = AtomicU64::new(0);
    fn directory() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "motrix-operation-test-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&p).unwrap();
        p.canonicalize().unwrap()
    }
    #[test]
    fn selected_copy_does_not_modify_input_and_private_root_is_identity_bound() {
        let dir = directory();
        fs::write(dir.join("input"), b"hello").unwrap();
        let root = super::super::open_root(dir.to_str().unwrap()).unwrap();
        let source = open_selected_file(&root, "input").unwrap();
        let private = create_private_root(&root, "private").unwrap();
        copy_selected_file(&source, &private, "copy").unwrap();
        assert_eq!(fs::read(dir.join("private/copy")).unwrap(), b"hello");
        assert!(copy_selected_file(&source, &private, "copy").is_err());
        fs::remove_file(dir.join("private/copy")).unwrap();
        fs::rename(dir.join("private"), dir.join("moved")).unwrap();
        fs::create_dir(dir.join("private")).unwrap();
        assert!(remove_private_root(&root, "private", &private).is_err());
        assert!(dir.join("private").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn selected_replacement_and_in_place_mutation_are_rejected() {
        let dir = directory();
        fs::write(dir.join("input"), b"hello").unwrap();
        let root = super::super::open_root(dir.to_str().unwrap()).unwrap();
        let source = open_selected_file(&root, "input").unwrap();
        fs::write(dir.join("input"), b"changed").unwrap();
        assert!(copy_selected_file(&source, &root, "bad").is_err());
        let source = open_selected_file(&root, "input").unwrap();
        fs::rename(dir.join("input"), dir.join("old")).unwrap();
        fs::write(dir.join("input"), b"changed").unwrap();
        assert!(copy_selected_file(&source, &root, "bad").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn refuses_links_and_special_files_without_blocking() {
        let dir = directory();
        fs::write(dir.join("input"), b"hello").unwrap();
        let root = super::super::open_root(dir.to_str().unwrap()).unwrap();
        std::os::unix::fs::symlink("input", dir.join("link")).unwrap();
        assert!(open_selected_file(&root, "link").is_err());
        let fifo = CString::new(dir.join("fifo").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(open_selected_file(&root, "fifo").is_err());
        assert!(open_selected_file(&root, ".").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
