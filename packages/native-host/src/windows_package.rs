//! Package-aware profile selection. Only an OS-confirmed unpackaged process may
//! use the traditional environment/profile/launcher discovery paths.
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageError {
    Identity,
    Application,
    Profile,
}

/// A verified package helper profile, or an OS-confirmed unpackaged process.
/// The application ID is deliberately separate from the P0 diagnostic helper.
pub type PackageProfile = Result<Option<PathBuf>, PackageError>;

pub fn select_profile(
    package: PackageProfile,
    has_override: bool,
    direct: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    match package {
        Ok(None) => direct(),
        Ok(Some(path)) if !has_override => Some(path),
        Ok(Some(_)) | Err(_) => None,
    }
}

pub fn permits_direct_launch(package: &PackageProfile) -> bool {
    matches!(package, Ok(None))
}

#[cfg(any(windows, test))]
fn helper_identity_matches(family: &str, application: &str) -> bool {
    !family.is_empty()
        && !family.contains(['!', '\0'])
        && application == format!("{family}!MotrixNativeHost")
}

#[cfg(not(windows))]
pub fn current_profile() -> PackageProfile {
    Ok(None)
}

#[cfg(windows)]
pub fn current_profile() -> PackageProfile {
    windows::current_profile()
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
    };
    use windows_sys::Win32::Storage::Packaging::Appx::{
        GetCurrentApplicationUserModelId, GetCurrentPackageFamilyName,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath};

    use super::{PackageError, PackageProfile, helper_identity_matches};

    type Query = unsafe extern "system" fn(*mut u32, *mut u16) -> u32;

    fn query_identity(
        query: Query,
        allow_no_package: bool,
    ) -> Result<Option<String>, PackageError> {
        let mut length = 0;
        // SAFETY: the API supports a null buffer to obtain its required size.
        let status = unsafe { query(&mut length, ptr::null_mut()) };
        if allow_no_package && status == APPMODEL_ERROR_NO_PACKAGE {
            return Ok(None);
        }
        if status != ERROR_INSUFFICIENT_BUFFER || !(2..=4096).contains(&length) {
            return Err(PackageError::Identity);
        }
        let mut buffer = vec![0u16; length as usize];
        // SAFETY: buffer owns length writable UTF-16 elements for this call.
        let status = unsafe { query(&mut length, buffer.as_mut_ptr()) };
        if status != ERROR_SUCCESS
            || length < 2
            || length as usize > buffer.len()
            || buffer[length as usize - 1] != 0
        {
            return Err(PackageError::Identity);
        }
        let value = String::from_utf16(&buffer[..length as usize - 1])
            .map_err(|_| PackageError::Identity)?;
        if value.contains('\0') {
            return Err(PackageError::Identity);
        }
        Ok(Some(value))
    }

    fn roaming_profile() -> Result<PathBuf, PackageError> {
        let mut value = ptr::null_mut();
        // SAFETY: a valid known-folder GUID, the current user's token, and a
        // writable output pointer. The API allocates a NUL-terminated string.
        let status = unsafe {
            SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, ptr::null_mut(), &mut value)
        };
        let result = (|| {
            if status < 0 || value.is_null() {
                return Err(PackageError::Profile);
            }
            let mut length = 0;
            // SAFETY: success returns a valid NUL-terminated UTF-16 allocation.
            // Keep a separate path-size limit before constructing the PathBuf.
            while unsafe { *value.add(length) } != 0 {
                length += 1;
                if length > 32767 {
                    return Err(PackageError::Profile);
                }
            }
            // SAFETY: the scan above established these initialized elements.
            let path = PathBuf::from(OsString::from_wide(unsafe {
                std::slice::from_raw_parts(value, length)
            }));
            if !path.is_absolute() || path.parent().is_none() {
                return Err(PackageError::Profile);
            }
            // Matches Electron's appData/Motrix-Store contract. Physical package
            // redirection is owned by Windows, never reconstructed from APPDATA.
            Ok(path.join("Motrix-Store"))
        })();
        // SAFETY: free the allocation from SHGetKnownFolderPath, including an
        // allocated output on error; CoTaskMemFree accepts null.
        unsafe { CoTaskMemFree(value.cast()) };
        result
    }

    pub(super) fn current_profile() -> PackageProfile {
        let Some(family) = query_identity(GetCurrentPackageFamilyName, true)? else {
            return Ok(None);
        };
        let application = query_identity(GetCurrentApplicationUserModelId, false)?
            .ok_or(PackageError::Application)?;
        if !helper_identity_matches(&family, &application) {
            return Err(PackageError::Application);
        }
        roaming_profile().map(Some)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        unsafe extern "system" fn absent(_length: *mut u32, _buffer: *mut u16) -> u32 {
            APPMODEL_ERROR_NO_PACKAGE
        }
        unsafe extern "system" fn denied(_length: *mut u32, _buffer: *mut u16) -> u32 {
            5
        }
        unsafe extern "system" fn excessive(length: *mut u32, _buffer: *mut u16) -> u32 {
            // SAFETY: query_identity supplies a valid mutable length pointer.
            unsafe { *length = 4097 };
            ERROR_INSUFFICIENT_BUFFER
        }
        unsafe extern "system" fn invalid_utf16(length: *mut u32, buffer: *mut u16) -> u32 {
            // SAFETY: query_identity allocates the requested two writable units.
            unsafe { *length = 2 };
            if buffer.is_null() {
                return ERROR_INSUFFICIENT_BUFFER;
            }
            unsafe {
                *buffer = 0xd800;
                *buffer.add(1) = 0;
            }
            ERROR_SUCCESS
        }
        #[test]
        fn only_the_package_query_accepts_explicit_absence() {
            assert_eq!(query_identity(absent, true), Ok(None));
            assert_eq!(query_identity(absent, false), Err(PackageError::Identity));
        }
        #[test]
        fn errors_and_invalid_os_buffers_fail_closed() {
            for query in [denied as Query, excessive as Query, invalid_utf16 as Query] {
                assert_eq!(query_identity(query, true), Err(PackageError::Identity));
            }
        }
        #[test]
        fn unpackaged_windows_test_process_uses_the_direct_route() {
            assert_eq!(current_profile(), Ok(None));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{PackageError, helper_identity_matches, permits_direct_launch, select_profile};

    #[test]
    fn requires_the_same_family_and_production_helper_application() {
        let family = "Motrix.Store.Test_abcde12345678";
        assert!(helper_identity_matches(
            family,
            &format!("{family}!MotrixNativeHost")
        ));
        for application in [
            "",
            "Motrix",
            "Other_123!MotrixNativeHost",
            "Motrix.Store.Test_abcde12345678!MotrixNativeHostP0",
            "Motrix.Store.Test_abcde12345678!Motrix",
        ] {
            assert!(!helper_identity_matches(family, application));
        }
        assert!(!helper_identity_matches("", "!MotrixNativeHost"));
    }

    #[test]
    fn package_paths_and_errors_never_evaluate_direct_discovery() {
        let store = PathBuf::from("isolated/Motrix-Store");
        assert_eq!(
            select_profile(Ok(Some(store.clone())), false, || panic!(
                "direct path evaluated"
            )),
            Some(store)
        );
        for package in [
            Ok(Some(PathBuf::from("isolated/Motrix-Store"))),
            Err(PackageError::Identity),
            Err(PackageError::Application),
            Err(PackageError::Profile),
        ] {
            assert!(!permits_direct_launch(&package));
            assert_eq!(
                select_profile(package, true, || panic!("direct path evaluated")),
                None
            );
        }
    }

    #[test]
    fn package_query_errors_do_not_become_absent_package() {
        for error in [
            PackageError::Identity,
            PackageError::Application,
            PackageError::Profile,
        ] {
            assert_eq!(
                select_profile(Err(error), false, || panic!("direct path evaluated")),
                None
            );
        }
    }

    #[test]
    fn confirmed_unpacked_process_preserves_existing_discovery_and_launch() {
        assert!(permits_direct_launch(&Ok(None)));
        let direct = PathBuf::from("traditional/Motrix");
        assert_eq!(
            select_profile(Ok(None), true, || Some(direct.clone())),
            Some(direct)
        );
    }
}
