//! Thin, checked wrappers around the Windows native handle APIs we need.

use std::ffi::{OsStr, c_void};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
    FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    NtCreateFile, NtFlushBuffersFile,
};
use windows_sys::Win32::Foundation::{
    HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, RtlNtStatusToDosError, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_ACCESS_RIGHTS, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL,
    FILE_CASE_SENSITIVE_INFO, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
    FileCaseSensitiveInfo, FileDispositionInfoEx, FileRenameInfo, GetFileInformationByHandleEx,
    OPEN_EXISTING, SYNCHRONIZE, SetFileInformationByHandle,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const SHARE_HELD_ARTIFACT: u32 = FILE_SHARE_READ | FILE_SHARE_DELETE;
const OPEN_COMMON: u32 =
    FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT;
const SOURCE_ACCESS: FILE_ACCESS_RIGHTS =
    FILE_READ_DATA | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | DELETE | SYNCHRONIZE;
const TRAVERSAL_ACCESS: FILE_ACCESS_RIGHTS =
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
// NtFlushBuffersFile requires write or append access. Held roots and mutable
// parents use both directory aliases so metadata changes can be flushed
// without granting DELETE on every ancestor traversed to reach the root.
const MUTABLE_DIRECTORY_ACCESS: FILE_ACCESS_RIGHTS = FILE_LIST_DIRECTORY
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_TRAVERSE
    | FILE_READ_ATTRIBUTES
    | FILE_WRITE_ATTRIBUTES
    | SYNCHRONIZE;
const TARGET_FILE_ACCESS: FILE_ACCESS_RIGHTS = FILE_READ_DATA
    | FILE_WRITE_DATA
    | FILE_READ_ATTRIBUTES
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | SYNCHRONIZE;
const TARGET_DIRECTORY_ACCESS: FILE_ACCESS_RIGHTS = FILE_LIST_DIRECTORY
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_TRAVERSE
    | FILE_READ_ATTRIBUTES
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | SYNCHRONIZE;

pub(super) fn wide_name(value: &str) -> io::Result<Vec<u16>> {
    validate_component(value)?;
    Ok(OsStr::new(value).encode_wide().collect())
}

pub(super) fn validate_wide_name(value: &[u16]) -> io::Result<()> {
    let value = String::from_utf16(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows artifact name is not valid Unicode",
        )
    })?;
    validate_component(&value)
}

fn validate_component(value: &str) -> io::Result<()> {
    if value.is_empty()
        || value.ends_with([' ', '.'])
        || value.chars().any(|character| {
            matches!(
                character,
                '\0'..='\u{1f}' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows artifact name uses forbidden syntax",
        ));
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    if reserved {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows reserved device names are forbidden",
        ));
    }
    Ok(())
}

pub(super) fn open_anchor(path: &Path, mutable: bool) -> io::Result<OwnedHandle> {
    let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    encoded.push(0);
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            if mutable {
                MUTABLE_DIRECTORY_ACCESS
            } else {
                TRAVERSAL_ACCESS
            },
            SHARE_ALL,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) fn open_existing(parent: &OwnedHandle, name: &[u16]) -> io::Result<OwnedHandle> {
    nt_create(
        parent,
        name,
        SOURCE_ACCESS,
        SHARE_HELD_ARTIFACT,
        FILE_OPEN,
        OPEN_COMMON,
    )
}

pub(super) fn open_existing_directory(
    parent: &OwnedHandle,
    name: &[u16],
) -> io::Result<OwnedHandle> {
    nt_create(
        parent,
        name,
        TRAVERSAL_ACCESS,
        SHARE_ALL,
        FILE_OPEN,
        OPEN_COMMON | FILE_DIRECTORY_FILE,
    )
}

pub(super) fn open_mutable_directory(
    parent: &OwnedHandle,
    name: &[u16],
) -> io::Result<OwnedHandle> {
    nt_create(
        parent,
        name,
        MUTABLE_DIRECTORY_ACCESS,
        SHARE_ALL,
        FILE_OPEN,
        OPEN_COMMON | FILE_DIRECTORY_FILE,
    )
}

pub(super) fn create_file(parent: &OwnedHandle, name: &[u16]) -> io::Result<OwnedHandle> {
    nt_create(
        parent,
        name,
        TARGET_FILE_ACCESS,
        SHARE_HELD_ARTIFACT,
        FILE_CREATE,
        OPEN_COMMON | FILE_NON_DIRECTORY_FILE,
    )
}

pub(super) fn create_directory(parent: &OwnedHandle, name: &[u16]) -> io::Result<OwnedHandle> {
    nt_create(
        parent,
        name,
        TARGET_DIRECTORY_ACCESS,
        SHARE_HELD_ARTIFACT,
        FILE_CREATE,
        OPEN_COMMON | FILE_DIRECTORY_FILE,
    )
}

fn nt_create(
    parent: &OwnedHandle,
    name: &[u16],
    desired_access: FILE_ACCESS_RIGHTS,
    share_access: u32,
    disposition: u32,
    options: u32,
) -> io::Result<OwnedHandle> {
    if name.is_empty() || name.len() > (u16::MAX as usize / size_of::<u16>()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows path component is empty or too long",
        ));
    }
    let byte_len = u16::try_from(size_of_val(name)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows path component is too long",
        )
    })?;
    let object_name = UNICODE_STRING {
        Length: byte_len,
        MaximumLength: byte_len,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: u32::try_from(size_of::<OBJECT_ATTRIBUTES>()).expect("OBJECT_ATTRIBUTES size"),
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &object_name,
        Attributes: object_attributes(parent),
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle: HANDLE = std::ptr::null_mut();
    let mut io_status = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &attributes,
            &mut io_status,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share_access,
            disposition,
            options,
            std::ptr::null(),
            0,
        )
    };
    check_status(status)?;
    if handle.is_null() {
        return Err(io::Error::other("NtCreateFile returned a null handle"));
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn object_attributes(parent: &OwnedHandle) -> u32 {
    const FILE_CS_FLAG_CASE_SENSITIVE_DIR: u32 = 1;
    let mut info = FILE_CASE_SENSITIVE_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            parent.as_raw_handle(),
            FileCaseSensitiveInfo,
            (&mut info as *mut FILE_CASE_SENSITIVE_INFO).cast(),
            u32::try_from(size_of::<FILE_CASE_SENSITIVE_INFO>())
                .expect("FILE_CASE_SENSITIVE_INFO size"),
        )
    };
    if result != 0 && info.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0 {
        OBJ_DONT_REPARSE
    } else {
        OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
    }
}

pub(super) fn rename_no_replace(
    artifact: &OwnedHandle,
    target_parent: &OwnedHandle,
    target_name: &[u16],
) -> io::Result<()> {
    let name_bytes = target_name
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    let total_bytes = offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(name_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
    let words = total_bytes.div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.Flags = 0;
        (*info).RootDirectory = target_parent.as_raw_handle();
        (*info).FileNameLength = u32::try_from(name_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "target name is too long"))?;
        std::ptr::copy_nonoverlapping(
            target_name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            target_name.len(),
        );
    }
    let result = unsafe {
        SetFileInformationByHandle(
            artifact.as_raw_handle(),
            FileRenameInfo,
            info.cast::<c_void>(),
            u32::try_from(total_bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "target name is too long")
            })?,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn mark_delete(artifact: &OwnedHandle) -> io::Result<()> {
    let mut disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let result = unsafe {
        SetFileInformationByHandle(
            artifact.as_raw_handle(),
            FileDispositionInfoEx,
            (&mut disposition as *mut FILE_DISPOSITION_INFO_EX).cast(),
            u32::try_from(size_of::<FILE_DISPOSITION_INFO_EX>())
                .expect("FILE_DISPOSITION_INFO_EX size"),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn flush(handle: &OwnedHandle) -> io::Result<()> {
    let mut io_status = IO_STATUS_BLOCK::default();
    let status = unsafe { NtFlushBuffersFile(handle.as_raw_handle(), &mut io_status) };
    check_status(status)
}

fn check_status(status: i32) -> io::Result<()> {
    if status >= 0 {
        return Ok(());
    }
    let error = unsafe { RtlNtStatusToDosError(status) };
    Err(io::Error::from_raw_os_error(error as i32))
}
