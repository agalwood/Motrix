use std::marker::PhantomData;
use std::time::Instant;

use windows::ApplicationModel::Core::AppListEntry;

use windows::ApplicationModel::{Package, StartupTask};
use windows::Win32::Foundation::{
    APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
};
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::Shell::{
    ASSOCF, ASSOCF_IS_PROTOCOL, ASSOCF_NOFIXUPS, ASSOCF_NOTRUNCATE, ASSOCSTR_APPID,
    AssocQueryStringW,
};
use windows::core::{Error, HRESULT, HSTRING, PCWSTR, PWSTR};

use crate::associations::{
    Association, AssociationsBackend, MAX_AUMID_UNITS, MAX_PACKAGE_APPLICATIONS,
    PackageApplications, query_aumid,
};
use crate::main_launch::{LAUNCH_OPERATION_TIMEOUT, MainLaunchBackend, wait_for_operation};
use crate::protocol::{ErrorCode, TASK_ID};
use crate::startup_task::{StartupBackend, StartupError};

fn winrt_error(error: Error) -> StartupError {
    StartupError::with_hresult(ErrorCode::WinrtFailed, error.code().0)
}

// The apartment guard cannot move to a different thread. Its matching
// RoUninitialize runs after every WinRT reference has been released.
struct Apartment(PhantomData<*mut ()>);

impl Apartment {
    fn initialize() -> Result<Self, StartupError> {
        // Both S_OK and S_FALSE require a matching RoUninitialize. A failed
        // initialization creates no guard and is never silently ignored.
        // https://learn.microsoft.com/windows/win32/api/roapi/nf-roapi-roinitialize
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(winrt_error)?;
        Ok(Self(PhantomData))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

#[derive(Default)]
pub struct WindowsBackend {
    // Rust drops fields in declaration order: release COM objects first.
    task: Option<StartupTask>,
    launch_entry: Option<AppListEntry>,
    launch_deadline: Option<Instant>,
    apartment: Option<Apartment>,
}

impl WindowsBackend {
    fn ensure_apartment(&mut self) -> Result<(), StartupError> {
        if self.apartment.is_none() {
            self.apartment = Some(Apartment::initialize()?);
        }
        Ok(())
    }

    fn task(&mut self) -> Result<&StartupTask, StartupError> {
        self.ensure_apartment()?;
        if self.task.is_none() {
            let task = StartupTask::GetAsync(&HSTRING::from(TASK_ID))
                .and_then(|operation| operation.join())
                .map_err(|error| {
                    StartupError::with_hresult(ErrorCode::TaskUnavailable, error.code().0)
                })?;
            if task.TaskId().map_err(winrt_error)? != TASK_ID {
                return Err(StartupError::new(ErrorCode::TaskUnavailable));
            }
            self.task = Some(task);
        }
        self.task
            .as_ref()
            .ok_or_else(|| StartupError::new(ErrorCode::TaskUnavailable))
    }
}

fn bounded_identifier(value: &HSTRING) -> Result<String, StartupError> {
    if value.is_empty() || value.len() > MAX_AUMID_UNITS {
        return Err(StartupError::new(ErrorCode::MainAppUnavailable));
    }
    String::from_utf16(value).map_err(|_| StartupError::new(ErrorCode::MainAppUnavailable))
}

fn association_flags(association: Association) -> ASSOCF {
    // NOFIXUPS keeps the query read-only; NOTRUNCATE rejects partial identifiers.
    // IS_PROTOCOL (Windows 8+) resolves magnet through current user defaults.
    // No NOUSERSETTINGS, PER_MACHINE_ONLY, or FIXED_PROGID fallback is used.
    // https://learn.microsoft.com/windows/win32/shell/assocf_str
    let flags = ASSOCF_NOFIXUPS | ASSOCF_NOTRUNCATE;
    if association.is_protocol() {
        flags | ASSOCF_IS_PROTOCOL
    } else {
        flags
    }
}

impl MainLaunchBackend for WindowsBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError> {
        StartupBackend::require_package_identity(self)
    }

    fn applications_for_launch(&mut self) -> Result<PackageApplications, StartupError> {
        let deadline = Instant::now() + LAUNCH_OPERATION_TIMEOUT;
        self.launch_deadline = Some(deadline);
        self.launch_entry = None;
        self.ensure_apartment()?;
        let package = Package::Current().map_err(winrt_error)?;
        let family = package
            .Id()
            .and_then(|id| id.FamilyName())
            .map_err(winrt_error)?;
        let family_name = bounded_identifier(&family)?;
        let operation = package.GetAppListEntriesAsync().map_err(winrt_error)?;
        let entries = wait_for_operation(
            deadline,
            || {
                // AsyncStatus.Started is 0. GetResults propagates error/cancellation
                // for every terminal state instead of treating it as completion.
                if operation.Status().map_err(winrt_error)?.0 == 0 {
                    return Ok(None);
                }
                operation.GetResults().map(Some).map_err(winrt_error)
            },
            || {
                let _ = operation.Cancel();
            },
        )?;
        let count = entries.Size().map_err(winrt_error)?;
        if count as usize > MAX_PACKAGE_APPLICATIONS {
            return Err(StartupError::new(ErrorCode::MainAppUnavailable));
        }
        let candidate = format!("{family_name}!{}", crate::associations::MAIN_APP_ID);
        let mut app_user_model_ids = Vec::with_capacity(count as usize);
        for index in 0..count {
            if Instant::now() >= deadline {
                return Err(StartupError::new(ErrorCode::OperationTimedOut));
            }
            let entry = entries.GetAt(index).map_err(winrt_error)?;
            let aumid = bounded_identifier(&entry.AppUserModelId().map_err(winrt_error)?)?;
            if aumid == candidate {
                self.launch_entry = Some(entry);
            }
            app_user_model_ids.push(aumid);
        }
        Ok(PackageApplications {
            family_name,
            app_user_model_ids,
        })
    }

    fn launch_main(&mut self, aumid: &str) -> Result<bool, StartupError> {
        let deadline = self
            .launch_deadline
            .ok_or(StartupError::new(ErrorCode::MainAppUnavailable))?;
        if Instant::now() >= deadline {
            return Err(StartupError::new(ErrorCode::OperationTimedOut));
        }
        let entry = self
            .launch_entry
            .as_ref()
            .ok_or(StartupError::new(ErrorCode::MainAppUnavailable))?;
        if bounded_identifier(&entry.AppUserModelId().map_err(winrt_error)?)? != aumid {
            return Err(StartupError::new(ErrorCode::MainAppUnavailable));
        }
        // Activate the OS-enumerated main entry, with no arguments and no
        // executable/protocol search. This does not assert bridge readiness.
        // https://learn.microsoft.com/uwp/api/windows.applicationmodel.core.applistentry.launchasync
        let operation = entry.LaunchAsync().map_err(winrt_error)?;
        wait_for_operation(
            deadline,
            || {
                if operation.Status().map_err(winrt_error)?.0 == 0 {
                    return Ok(None);
                }
                operation.GetResults().map(Some).map_err(winrt_error)
            },
            || {
                let _ = operation.Cancel();
            },
        )
    }
}

impl AssociationsBackend for WindowsBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError> {
        StartupBackend::require_package_identity(self)
    }

    fn package_applications(&mut self) -> Result<PackageApplications, StartupError> {
        self.ensure_apartment()?;
        // Package/PackageId and GetAppListEntriesAsync are UniversalApiContract
        // v1; AppUserModelId is v5 (16299), below the manifest minimum 19045.
        // AppListEntry.AppInfo requires 20348 and is deliberately not used.
        // https://learn.microsoft.com/uwp/api/windows.applicationmodel.package
        // https://learn.microsoft.com/uwp/api/windows.applicationmodel.core.applistentry.appusermodelid
        let package = Package::Current().map_err(winrt_error)?;
        let family = package
            .Id()
            .and_then(|id| id.FamilyName())
            .map_err(winrt_error)?;
        let family_name = bounded_identifier(&family)?;
        let entries = package
            .GetAppListEntriesAsync()
            .and_then(|operation| operation.join())
            .map_err(winrt_error)?;
        let count = entries.Size().map_err(winrt_error)?;
        // Defensive enumeration bound, not a Windows package schema limit.
        if count as usize > MAX_PACKAGE_APPLICATIONS {
            return Err(StartupError::new(ErrorCode::MainAppUnavailable));
        }
        let mut app_user_model_ids = Vec::with_capacity(count as usize);
        for index in 0..count {
            let aumid = entries
                .GetAt(index)
                .and_then(|entry| entry.AppUserModelId())
                .map_err(winrt_error)?;
            app_user_model_ids.push(bounded_identifier(&aumid)?);
        }
        Ok(PackageApplications {
            family_name,
            app_user_model_ids,
        })
    }

    fn default_aumid(&mut self, association: Association) -> Option<String> {
        let name = HSTRING::from(association.name());
        let flags = association_flags(association);
        // ASSOCSTR_APPID is available since Windows 10 and returns the default
        // app's AUMID. Missing AUMIDs (including traditional apps) stay unknown.
        // https://learn.microsoft.com/windows/win32/api/shlwapi/ne-shlwapi-assocstr
        query_aumid(|buffer, length| unsafe {
            AssocQueryStringW(
                flags,
                ASSOCSTR_APPID,
                &name,
                PCWSTR::null(),
                buffer.map(|buffer| PWSTR(buffer.as_mut_ptr())),
                length,
            )
            .0
        })
    }
}

impl StartupBackend for WindowsBackend {
    fn require_package_identity(&mut self) -> Result<(), StartupError> {
        // A path inside WindowsApps and an environment variable do not establish
        // package identity. Query the actual process through the OS before WinRT.
        // Presence does not identify a Store publisher or distribution source.
        // https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-getcurrentpackagefullname
        let mut length = 0;
        let status = unsafe { GetCurrentPackageFullName(&mut length, None) };
        if status == APPMODEL_ERROR_NO_PACKAGE {
            return Err(StartupError::new(ErrorCode::NoPackageIdentity));
        }
        if status != ERROR_INSUFFICIENT_BUFFER {
            return Err(StartupError::with_hresult(
                ErrorCode::WinrtFailed,
                HRESULT::from_win32(status.0).0,
            ));
        }
        // A defensive allocation bound, not a claim about the package-name schema.
        if !(2..=4096).contains(&length) {
            return Err(StartupError::new(ErrorCode::NoPackageIdentity));
        }
        let mut name = vec![0u16; length as usize];
        let status =
            unsafe { GetCurrentPackageFullName(&mut length, Some(PWSTR(name.as_mut_ptr()))) };
        if status == APPMODEL_ERROR_NO_PACKAGE {
            return Err(StartupError::new(ErrorCode::NoPackageIdentity));
        }
        if status != ERROR_SUCCESS {
            return Err(StartupError::with_hresult(
                ErrorCode::WinrtFailed,
                HRESULT::from_win32(status.0).0,
            ));
        }
        if length < 2
            || length as usize > name.len()
            || name[0] == 0
            || name[length as usize - 1] != 0
        {
            return Err(StartupError::new(ErrorCode::NoPackageIdentity));
        }
        Ok(())
    }

    fn state(&mut self) -> Result<i32, StartupError> {
        self.task()?
            .State()
            .map(|state| state.0)
            .map_err(winrt_error)
    }

    fn request_enable(&mut self) -> Result<i32, StartupError> {
        self.task()?
            .RequestEnableAsync()
            .and_then(|operation| operation.join())
            .map(|state| state.0)
            .map_err(winrt_error)
    }

    fn disable(&mut self) -> Result<(), StartupError> {
        self.task()?.Disable().map_err(winrt_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_queries_use_only_read_only_current_user_flags() {
        assert_eq!(
            MAX_AUMID_UNITS + 1,
            windows::Win32::Storage::Packaging::Appx::APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize
        );
        assert_eq!(
            association_flags(Association::Torrent),
            ASSOCF_NOFIXUPS | ASSOCF_NOTRUNCATE
        );
        assert_eq!(
            association_flags(Association::Magnet),
            ASSOCF_NOFIXUPS | ASSOCF_NOTRUNCATE | ASSOCF_IS_PROTOCOL
        );
    }
}
