use std::marker::PhantomData;

use windows::ApplicationModel::StartupTask;
use windows::Win32::Foundation::{
    APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
};
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::{Error, HRESULT, HSTRING, PWSTR};

use crate::protocol::{ErrorCode, TASK_ID};
use crate::startup_task::{StartupBackend, StartupError};

fn winrt_error(error: Error) -> StartupError {
    StartupError::with_hresult(ErrorCode::WinrtFailed, error.code().0)
}

// The apartment guard cannot move to a different thread. Its matching
// RoUninitialize runs after every StartupTask reference has been released.
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
    apartment: Option<Apartment>,
}

impl WindowsBackend {
    fn task(&mut self) -> Result<&StartupTask, StartupError> {
        if self.apartment.is_none() {
            self.apartment = Some(Apartment::initialize()?);
        }
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
