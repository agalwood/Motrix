//! Read the persistent NTFS volume UUID from the system Disk Arbitration API.
use std::ffi::{CStr, c_char, c_void};
use std::io;

type CFRef = *const c_void;

#[repr(C)]
struct UuidBytes {
    bytes: [u8; 16],
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: CFRef);
    fn CFGetTypeID(value: CFRef) -> usize;
    fn CFDictionaryGetValue(dictionary: CFRef, key: CFRef) -> CFRef;
    fn CFUUIDGetTypeID() -> usize;
    fn CFUUIDGetUUIDBytes(uuid: CFRef) -> UuidBytes;
}

#[link(name = "DiskArbitration", kind = "framework")]
unsafe extern "C" {
    fn DASessionCreate(allocator: CFRef) -> CFRef;
    fn DADiskCreateFromBSDName(allocator: CFRef, session: CFRef, name: *const c_char) -> CFRef;
    fn DADiskCopyDescription(disk: CFRef) -> CFRef;
    static kDADiskDescriptionVolumeUUIDKey: CFRef;
}

struct Owned(CFRef);

impl Owned {
    fn checked(value: CFRef) -> io::Result<Self> {
        if value.is_null() {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "NTFS volume is unavailable",
            ))
        } else {
            Ok(Self(value))
        }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

pub(super) fn volume_uuid(fs: &libc::statfs) -> io::Result<String> {
    let device = unsafe { CStr::from_ptr(fs.f_mntfromname.as_ptr()) };
    if !device.to_bytes().starts_with(b"/dev/disk") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "NTFS source is not a local disk",
        ));
    }
    let session = Owned::checked(unsafe { DASessionCreate(std::ptr::null()) })?;
    let disk = Owned::checked(unsafe {
        DADiskCreateFromBSDName(std::ptr::null(), session.0, device.as_ptr())
    })?;
    let description = Owned::checked(unsafe { DADiskCopyDescription(disk.0) })?;
    let uuid = unsafe { CFDictionaryGetValue(description.0, kDADiskDescriptionVolumeUUIDKey) };
    if uuid.is_null() || unsafe { CFGetTypeID(uuid) != CFUUIDGetTypeID() } {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "missing NTFS volume UUID",
        ));
    }
    let bytes = unsafe { CFUUIDGetUUIDBytes(uuid) }.bytes;
    if bytes.iter().all(|byte| *byte == 0) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "empty NTFS volume UUID",
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
