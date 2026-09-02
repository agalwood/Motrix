use super::ArtifactStamp;
use std::ffi::CString;
use std::io;
use std::os::fd::RawFd;

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

pub(super) fn directory_entries(directory: RawFd) -> io::Result<Vec<CString>> {
    // F_DUPFD shares the directory stream offset with the held descriptor.
    // Reopen `.` so repeated snapshots each start from offset zero.
    let duplicate = unsafe {
        libc::openat(
            directory,
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(error);
    }
    let stream = DirectoryStream(stream);
    let mut names = Vec::new();
    loop {
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(0) {
                return Err(error);
            }
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        names.push(name.to_owned());
    }
    names.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    Ok(names)
}

pub(super) fn stat_named(parent: RawFd, name: &CString) -> io::Result<libc::stat> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            value.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { value.assume_init() })
}

pub(super) fn stat_opened(opened: RawFd) -> io::Result<libc::stat> {
    let mut value = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(opened, value.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { value.assume_init() })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn artifact_stamp(value: &libc::stat) -> ArtifactStamp {
    ArtifactStamp {
        device: value.st_dev,
        inode: value.st_ino,
        size: value.st_size,
        modified_seconds: value.st_mtime,
        modified_nanoseconds: value.st_mtime_nsec,
        changed_seconds: value.st_ctime,
        changed_nanoseconds: value.st_ctime_nsec,
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub(super) fn artifact_stamp(value: &libc::stat) -> ArtifactStamp {
    ArtifactStamp {
        device: value.st_dev,
        inode: value.st_ino,
        size: value.st_size,
        modified_seconds: value.st_mtime,
        modified_nanoseconds: 0,
        changed_seconds: value.st_ctime,
        changed_nanoseconds: 0,
    }
}

pub(super) fn stamp_stable_across_rename(actual: ArtifactStamp, opened: ArtifactStamp) -> bool {
    actual.device == opened.device
        && actual.inode == opened.inode
        && actual.size == opened.size
        && actual.modified_seconds == opened.modified_seconds
        && actual.modified_nanoseconds == opened.modified_nanoseconds
}

pub(super) fn ensure_same_entry(
    opened: RawFd,
    parent: RawFd,
    name: &CString,
) -> io::Result<libc::stat> {
    let opened_stat = stat_opened(opened)?;
    let named_stat = stat_named(parent, name)?;
    if opened_stat.st_dev != named_stat.st_dev || opened_stat.st_ino != named_stat.st_ino {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened artifact identity mismatch",
        ));
    }
    Ok(opened_stat)
}
