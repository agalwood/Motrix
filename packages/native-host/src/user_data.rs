use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::MOTRIX_FLATPAK_ID;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeHostPlatform {
    Darwin,
    Linux,
    Win32,
}

pub fn current_platform() -> NativeHostPlatform {
    #[cfg(target_os = "macos")]
    {
        NativeHostPlatform::Darwin
    }
    #[cfg(target_os = "linux")]
    {
        NativeHostPlatform::Linux
    }
    #[cfg(target_os = "windows")]
    {
        NativeHostPlatform::Win32
    }
}

pub fn resolve_native_host_user_data_dir(
    platform: NativeHostPlatform,
    home: &Path,
    roaming_app_data: Option<&OsStr>,
) -> PathBuf {
    match platform {
        NativeHostPlatform::Darwin => home
            .join("Library")
            .join("Application Support")
            .join("Motrix"),
        NativeHostPlatform::Linux => home.join(".config").join("motrix"),
        NativeHostPlatform::Win32 => {
            let roaming_root = roaming_app_data
                .filter(|value| !value.to_string_lossy().trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming"));
            roaming_root.join("Motrix")
        }
    }
}

pub fn native_host_user_data_dir() -> Option<PathBuf> {
    resolve_native_host_user_data_dir_from_optional_home(
        current_platform(),
        home::home_dir().as_deref(),
        std::env::var_os("APPDATA").as_deref(),
    )
}

pub(crate) fn absolute_directory_from_env(value: &OsStr) -> Option<PathBuf> {
    let text = value.to_str()?;
    if text.is_empty() || text.trim() != text {
        return None;
    }

    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

pub fn resolve_bridge_data_dir(
    user_data: Option<&Path>,
    override_data_dir: Option<&OsStr>,
) -> Option<PathBuf> {
    match override_data_dir {
        Some(value) => absolute_directory_from_env(value),
        None => user_data.map(|base| base.join("bridge")),
    }
}

pub fn native_host_bridge_data_dir(user_data: Option<&Path>) -> Option<PathBuf> {
    resolve_bridge_data_dir(
        user_data,
        std::env::var_os("MOTRIX_BRIDGE_DATA_DIR").as_deref(),
    )
}

/// Resolve the bridge directory visible inside the Motrix Flatpak sandbox.
///
/// The broker must not fall back to the host user's home directory: that can
/// point at a different endpoint namespace when Flatpak environment setup is
/// incomplete or spoofed.
pub fn resolve_flatpak_bridge_data_dir(
    flatpak_id: Option<&OsStr>,
    xdg_config_home: Option<&OsStr>,
) -> Option<PathBuf> {
    if flatpak_id != Some(OsStr::new(MOTRIX_FLATPAK_ID)) {
        return None;
    }
    absolute_directory_from_env(xdg_config_home?)
        .map(|config_home| config_home.join("motrix").join("bridge"))
}

fn resolve_native_host_user_data_dir_from_optional_home(
    platform: NativeHostPlatform,
    home: Option<&Path>,
    roaming_app_data: Option<&OsStr>,
) -> Option<PathBuf> {
    if platform == NativeHostPlatform::Win32
        && let Some(roaming_root) =
            roaming_app_data.filter(|value| !value.to_string_lossy().trim().is_empty())
    {
        return Some(PathBuf::from(roaming_root).join("Motrix"));
    }
    let home = home?;
    Some(resolve_native_host_user_data_dir(
        platform,
        home,
        roaming_app_data,
    ))
}

pub fn endpoint_path(base: &Path) -> PathBuf {
    base.join("bridge").join("endpoint.json")
}

pub fn bridge_endpoint_path(bridge_data_dir: &Path) -> PathBuf {
    bridge_data_dir.join("endpoint.json")
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use super::resolve_flatpak_bridge_data_dir;
    use super::resolve_native_host_user_data_dir_from_optional_home;
    use super::{
        NativeHostPlatform, bridge_endpoint_path, endpoint_path, resolve_bridge_data_dir,
        resolve_native_host_user_data_dir,
    };

    #[test]
    fn resolves_macos_and_linux_paths() {
        assert_eq!(
            resolve_native_host_user_data_dir(
                NativeHostPlatform::Darwin,
                Path::new("/Users/me"),
                None,
            ),
            PathBuf::from("/Users/me/Library/Application Support/Motrix")
        );
        assert_eq!(
            resolve_native_host_user_data_dir(
                NativeHostPlatform::Linux,
                Path::new("/home/me"),
                None,
            ),
            PathBuf::from("/home/me/.config/motrix")
        );
    }

    #[test]
    fn resolves_windows_roaming_path_and_fallback() {
        assert_eq!(
            resolve_native_host_user_data_dir(
                NativeHostPlatform::Win32,
                Path::new("C:/Users/me"),
                Some(OsStr::new("Z:/Profiles/me/Roaming")),
            ),
            PathBuf::from("Z:/Profiles/me/Roaming").join("Motrix")
        );
        assert_eq!(
            resolve_native_host_user_data_dir(
                NativeHostPlatform::Win32,
                Path::new("C:/Users/me"),
                Some(OsStr::new("  ")),
            ),
            PathBuf::from("C:/Users/me")
                .join("AppData")
                .join("Roaming")
                .join("Motrix")
        );
    }

    #[test]
    fn windows_appdata_does_not_require_home_resolution() {
        assert_eq!(
            resolve_native_host_user_data_dir_from_optional_home(
                NativeHostPlatform::Win32,
                None,
                Some(OsStr::new("Z:/Profiles/me/Roaming")),
            ),
            Some(PathBuf::from("Z:/Profiles/me/Roaming").join("Motrix"))
        );
        assert_eq!(
            resolve_native_host_user_data_dir_from_optional_home(
                NativeHostPlatform::Win32,
                None,
                Some(OsStr::new(" ")),
            ),
            None
        );
    }

    #[test]
    fn endpoint_is_under_bridge_directory() {
        assert_eq!(
            endpoint_path(Path::new("/data/Motrix")),
            PathBuf::from("/data/Motrix/bridge/endpoint.json")
        );
        assert_eq!(
            bridge_endpoint_path(Path::new("/data/shared-bridge")),
            PathBuf::from("/data/shared-bridge/endpoint.json")
        );
    }

    #[test]
    fn bridge_data_override_is_absolute_and_replaces_the_fallback() {
        #[cfg(windows)]
        let override_dir = PathBuf::from(r"C:\data\snap\common\bridge");
        #[cfg(not(windows))]
        let override_dir = PathBuf::from("/data/snap/common/bridge");

        assert_eq!(
            resolve_bridge_data_dir(
                Some(Path::new("/data/Motrix")),
                Some(override_dir.as_os_str()),
            ),
            Some(override_dir)
        );
        assert_eq!(
            resolve_bridge_data_dir(Some(Path::new("/data/Motrix")), None),
            Some(PathBuf::from("/data/Motrix/bridge"))
        );
        assert_eq!(resolve_bridge_data_dir(None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn flatpak_bridge_requires_the_exact_app_id_and_absolute_xdg_config_home() {
        assert_eq!(
            resolve_flatpak_bridge_data_dir(
                Some(OsStr::new("app.motrix.native")),
                Some(OsStr::new("/home/me/.var/app/app.motrix.native/config")),
            ),
            Some(PathBuf::from(
                "/home/me/.var/app/app.motrix.native/config/motrix/bridge"
            ))
        );
        for flatpak_id in [None, Some(OsStr::new("org.example.Other"))] {
            assert_eq!(
                resolve_flatpak_bridge_data_dir(
                    flatpak_id,
                    Some(OsStr::new("/home/me/.var/app/app.motrix.native/config")),
                ),
                None
            );
        }
        for config_home in [
            None,
            Some(OsStr::new("relative/config")),
            Some(OsStr::new("/")),
        ] {
            assert_eq!(
                resolve_flatpak_bridge_data_dir(Some(OsStr::new("app.motrix.native")), config_home,),
                None
            );
        }
    }

    #[test]
    fn malformed_bridge_data_override_fails_closed() {
        for invalid in [
            "",
            " ",
            "relative/bridge",
            "/",
            "/data/common/../escape",
            "/data/common/bridge ",
        ] {
            assert_eq!(
                resolve_bridge_data_dir(Some(Path::new("/fallback")), Some(OsStr::new(invalid))),
                None,
                "{invalid:?} must not fall back to user data",
            );
        }
    }
}
