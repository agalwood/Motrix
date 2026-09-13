//! Identity and immutable tree snapshots for held Windows handles.

use super::super::windows_policy::unsupported_information;
use super::digest::hash_opened_file;
use super::nt;
use crate::error::{native_error, os_code};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, ERROR_PATH_NOT_FOUND,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_FULL_DIR_INFO,
    FILE_ID_INFO, FILE_STANDARD_INFO, FileBasicInfo, FileFullDirectoryInfo,
    FileFullDirectoryRestartInfo, FileIdInfo, FileStandardInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx,
};

#[derive(Clone, Debug, Eq, PartialEq)]
enum FileIdentity {
    Extended([u8; 16]),
    Legacy(u64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct FileStamp {
    volume: u64,
    file_id: FileIdentity,
    size: i64,
    last_write: i64,
    attributes: u32,
    pub(super) directory: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct EntrySnapshot {
    pub(super) name: Vec<u16>,
    pub(super) artifact: ArtifactSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ArtifactSnapshot {
    File {
        stamp: FileStamp,
        sha256: [u8; 32],
    },
    Directory {
        stamp: FileStamp,
        entries: Vec<EntrySnapshot>,
    },
}

impl ArtifactSnapshot {
    pub(super) fn is_directory(&self) -> bool {
        matches!(self, Self::Directory { .. })
    }
}

pub(super) fn query_stamp(handle: &OwnedHandle) -> io::Result<FileStamp> {
    let basic: FILE_BASIC_INFO = query(handle, FileBasicInfo)?;
    let (volume, file_id) = query_identity(handle)?;
    let standard: FILE_STANDARD_INFO = query(handle, FileStandardInfo)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows reparse points are forbidden",
        ));
    }
    Ok(FileStamp {
        volume,
        file_id,
        size: standard.EndOfFile,
        last_write: basic.LastWriteTime,
        attributes: basic.FileAttributes,
        directory: standard.Directory,
    })
}

fn query_identity(handle: &OwnedHandle) -> io::Result<(u64, FileIdentity)> {
    query_identity_with(handle, query::<FILE_ID_INFO>(handle, FileIdInfo))
}

fn query_identity_with(
    handle: &OwnedHandle,
    extended: io::Result<FILE_ID_INFO>,
) -> io::Result<(u64, FileIdentity)> {
    match extended {
        Ok(id) if id.FileId.Identifier != [0; 16] => Ok((
            id.VolumeSerialNumber,
            FileIdentity::Extended(id.FileId.Identifier),
        )),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem returned an empty file identity",
        )),
        Err(error) if unsupported_information(os_code(&error)) => {
            // SMB 2.x and older NAS implementations expose 64-bit file indices.
            // Keep the identity namespace distinct from the 128-bit query.
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
                return Err(native_error(
                    io::Error::last_os_error(),
                    "GetFileInformationByHandle",
                    None,
                ));
            }
            let id = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
            if id == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "filesystem returned an empty legacy file identity",
                ));
            }
            Ok((
                u64::from(info.dwVolumeSerialNumber),
                FileIdentity::Legacy(id),
            ))
        }
        Err(error) => Err(error),
    }
}

pub(super) fn snapshot_opened(handle: &OwnedHandle) -> io::Result<ArtifactSnapshot> {
    let stamp = query_stamp(handle)?;
    if stamp.directory {
        Ok(ArtifactSnapshot::Directory {
            stamp,
            entries: snapshot_directory(handle)?,
        })
    } else {
        Ok(ArtifactSnapshot::File {
            stamp,
            sha256: hash_opened_file(handle)?,
        })
    }
}

pub(super) fn ensure_snapshot(handle: &OwnedHandle, expected: &ArtifactSnapshot) -> io::Result<()> {
    if snapshot_opened(handle)? != *expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened Windows artifact changed after admission",
        ));
    }
    Ok(())
}

pub(super) fn ensure_named_entry(
    opened: &OwnedHandle,
    parent: &OwnedHandle,
    name: &[u16],
) -> io::Result<()> {
    let named = nt::open_metadata(parent, name)?;
    ensure_same_opened(opened, &named)
}

pub(super) fn ensure_same_opened(left: &OwnedHandle, right: &OwnedHandle) -> io::Result<()> {
    let left_stamp = query_stamp(left)?;
    let right_stamp = query_stamp(right)?;
    if left_stamp.volume != right_stamp.volume || left_stamp.file_id != right_stamp.file_id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened Windows handles no longer identify the same artifact",
        ));
    }
    Ok(())
}

pub(super) fn assert_name_absent(parent: &OwnedHandle, name: &[u16]) -> io::Result<()> {
    match nt::open_metadata(parent, name) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows artifact name still exists after mutation",
        )),
        Err(error)
            if matches!(
                os_code(&error),
                Some(code)
                    if code == ERROR_FILE_NOT_FOUND as i32
                        || code == ERROR_PATH_NOT_FOUND as i32
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

pub(super) fn content_matches(expected: &ArtifactSnapshot, actual: &ArtifactSnapshot) -> bool {
    match (expected, actual) {
        (
            ArtifactSnapshot::File { sha256: left, .. },
            ArtifactSnapshot::File { sha256: right, .. },
        ) => left == right,
        (
            ArtifactSnapshot::Directory { entries: left, .. },
            ArtifactSnapshot::Directory { entries: right, .. },
        ) => {
            left.len() == right.len()
                && left.iter().zip(right).all(|(left, right)| {
                    left.name == right.name && content_matches(&left.artifact, &right.artifact)
                })
        }
        _ => false,
    }
}

fn snapshot_directory(directory: &OwnedHandle) -> io::Result<Vec<EntrySnapshot>> {
    let mut entries = Vec::new();
    for name in directory_names(directory)? {
        let child = nt::open_existing(directory, &name)?;
        entries.push(EntrySnapshot {
            name,
            artifact: snapshot_opened(&child)?,
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

fn directory_names(directory: &OwnedHandle) -> io::Result<Vec<Vec<u16>>> {
    const BUFFER_BYTES: usize = 64 * 1024;
    let mut storage = vec![0_u64; BUFFER_BYTES.div_ceil(size_of::<u64>())];
    let mut names = Vec::new();
    let mut restart = true;
    loop {
        let class = if restart {
            FileFullDirectoryRestartInfo
        } else {
            FileFullDirectoryInfo
        };
        restart = false;
        let result = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                storage.as_mut_ptr().cast(),
                u32::try_from(BUFFER_BYTES).expect("directory buffer size"),
            )
        };
        if result == 0 {
            let error = io::Error::last_os_error();
            if os_code(&error) == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(native_error(
                error,
                format!("GetFileInformationByHandleEx(class={class})"),
                None,
            ));
        }

        let mut offset = 0_usize;
        loop {
            let header_end = offset
                .checked_add(offset_of!(FILE_FULL_DIR_INFO, FileName))
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "directory entry overflow")
                })?;
            if header_end > BUFFER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows directory entry exceeds its buffer",
                ));
            }
            let entry = unsafe {
                &*storage
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_FULL_DIR_INFO>()
            };
            if entry.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Windows directory contains a reparse point",
                ));
            }
            let name_bytes = usize::try_from(entry.FileNameLength).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "directory name is too long")
            })?;
            if name_bytes % size_of::<u16>() != 0
                || header_end
                    .checked_add(name_bytes)
                    .is_none_or(|end| end > BUFFER_BYTES)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows directory name has an invalid length",
                ));
            }
            let name = unsafe {
                std::slice::from_raw_parts(
                    std::ptr::addr_of!(entry.FileName).cast::<u16>(),
                    name_bytes / size_of::<u16>(),
                )
            };
            if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
                nt::validate_wide_name(name)?;
                names.push(name.to_vec());
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            offset = offset
                .checked_add(entry.NextEntryOffset as usize)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "directory offset overflow")
                })?;
            if offset >= BUFFER_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Windows directory offset exceeds its buffer",
                ));
            }
        }
    }
    names.sort();
    Ok(names)
}

fn query<T: Default>(handle: &OwnedHandle, class: i32) -> io::Result<T> {
    let mut output = T::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            class,
            (&mut output as *mut T).cast(),
            u32::try_from(size_of::<T>()).expect("file information size"),
        )
    };
    if result == 0 {
        return Err(native_error(
            io::Error::last_os_error(),
            format!("GetFileInformationByHandleEx(class={class})"),
            None,
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_identity_fallback_is_stable_and_preserves_real_errors() {
        let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        let handle: OwnedHandle = file.into();
        let first = query_identity_with(&handle, Err(io::Error::from_raw_os_error(50))).unwrap();
        let second = query_identity_with(&handle, Err(io::Error::from_raw_os_error(1))).unwrap();
        assert_eq!(first, second);
        assert!(matches!(first.1, FileIdentity::Legacy(id) if id != 0));
        for code in [5, 32, 53, 64, 112, 121, 1117] {
            assert_eq!(
                os_code(
                    &query_identity_with(&handle, Err(io::Error::from_raw_os_error(code)))
                        .unwrap_err()
                ),
                Some(code)
            );
        }
        assert!(query_identity_with(&handle, Ok(FILE_ID_INFO::default())).is_err());
    }
}
