use super::metadata::{directory_entries, ensure_same_entry, stat_named};
use super::{ArtifactHandle, RootHandle, open_parent};
use crate::path::validate_relative;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

fn copy_file_contents(source: RawFd, target: RawFd) -> io::Result<()> {
    if unsafe { libc::lseek(source, 0, libc::SEEK_SET) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = unsafe { libc::read(source, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if read == 0 {
            break;
        }
        let mut written = 0_usize;
        while written < read as usize {
            let count = unsafe {
                libc::write(
                    target,
                    buffer[written..read as usize].as_ptr().cast(),
                    read as usize - written,
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "copy target stopped accepting bytes",
                ));
            }
            written += count as usize;
        }
    }
    if unsafe { libc::fsync(target) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn copy_directory_contents(source: RawFd, target: RawFd) -> io::Result<()> {
    for name in directory_entries(source)? {
        let source_stat = stat_named(source, &name)?;
        let source_type = source_stat.st_mode & libc::S_IFMT;
        if source_type == libc::S_IFDIR {
            if unsafe { libc::mkdirat(target, name.as_ptr(), 0o700) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let source_child = unsafe {
                libc::openat(
                    source,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if source_child < 0 {
                return Err(io::Error::last_os_error());
            }
            let source_child = unsafe { OwnedFd::from_raw_fd(source_child) };
            ensure_same_entry(source_child.as_raw_fd(), source, &name)?;
            let target_child = unsafe {
                libc::openat(
                    target,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if target_child < 0 {
                return Err(io::Error::last_os_error());
            }
            let target_child = unsafe { OwnedFd::from_raw_fd(target_child) };
            copy_directory_contents(source_child.as_raw_fd(), target_child.as_raw_fd())?;
            ensure_same_entry(source_child.as_raw_fd(), source, &name)?;
        } else if source_type == libc::S_IFREG {
            let source_child = unsafe {
                libc::openat(
                    source,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if source_child < 0 {
                return Err(io::Error::last_os_error());
            }
            let source_child = unsafe { OwnedFd::from_raw_fd(source_child) };
            ensure_same_entry(source_child.as_raw_fd(), source, &name)?;
            let target_child = unsafe {
                libc::openat(
                    target,
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if target_child < 0 {
                return Err(io::Error::last_os_error());
            }
            let target_child = unsafe { OwnedFd::from_raw_fd(target_child) };
            copy_file_contents(source_child.as_raw_fd(), target_child.as_raw_fd())?;
            ensure_same_entry(source_child.as_raw_fd(), source, &name)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "refusing to copy a symbolic link or special file",
            ));
        }
    }
    if unsafe { libc::fsync(target) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn copy_opened(
    artifact: &ArtifactHandle,
    target: &RootHandle,
    target_relative: &str,
) -> io::Result<()> {
    let target_parts = validate_relative(target_relative)?;
    let target_parent = open_parent(target.0.as_raw_fd(), &target_parts)?;
    let target_name =
        CString::new(*target_parts.last().expect("nonempty")).expect("validated component");
    let source_stat = ensure_same_entry(
        artifact.artifact.as_raw_fd(),
        artifact.parent.as_raw_fd(),
        &artifact.name,
    )?;
    let source_type = source_stat.st_mode & libc::S_IFMT;
    if source_type == libc::S_IFDIR {
        if unsafe { libc::mkdirat(target_parent.as_raw_fd(), target_name.as_ptr(), 0o700) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let target_artifact = unsafe {
            libc::openat(
                target_parent.as_raw_fd(),
                target_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if target_artifact < 0 {
            return Err(io::Error::last_os_error());
        }
        let target_artifact = unsafe { OwnedFd::from_raw_fd(target_artifact) };
        copy_directory_contents(artifact.artifact.as_raw_fd(), target_artifact.as_raw_fd())?;
    } else if source_type == libc::S_IFREG {
        let target_artifact = unsafe {
            libc::openat(
                target_parent.as_raw_fd(),
                target_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if target_artifact < 0 {
            return Err(io::Error::last_os_error());
        }
        let target_artifact = unsafe { OwnedFd::from_raw_fd(target_artifact) };
        copy_file_contents(artifact.artifact.as_raw_fd(), target_artifact.as_raw_fd())?;
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "refusing to copy a symbolic link or special artifact",
        ));
    }
    ensure_same_entry(
        artifact.artifact.as_raw_fd(),
        artifact.parent.as_raw_fd(),
        &artifact.name,
    )?;
    if unsafe { libc::fsync(target_parent.as_raw_fd()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
