use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use super::{CompanionError, FLATPAK_COMPANION_BINARY};

const MANIFEST_FILE_NAME: &str = "app.motrix.bridge.json";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManifestFamily {
    Chromium,
    Firefox,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestTarget {
    pub family: ManifestFamily,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanionPaths {
    pub home_root: PathBuf,
    pub data_root: PathBuf,
    pub config_root: PathBuf,
    pub binary: PathBuf,
    pub config: PathBuf,
    pub manifests: Vec<ManifestTarget>,
}

pub(super) fn absolute_root(value: &OsStr, label: &str) -> Result<PathBuf, CompanionError> {
    let text = value
        .to_str()
        .ok_or_else(|| CompanionError::new(format!("{label} must be valid UTF-8")))?;
    if text.is_empty() || text.trim() != text {
        return Err(CompanionError::new(format!(
            "{label} must not be empty or padded"
        )));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(CompanionError::new(format!(
            "{label} must be a canonical absolute path"
        )));
    }
    Ok(path)
}

pub fn resolve_companion_paths(
    home: &Path,
    xdg_data_home: Option<&OsStr>,
    xdg_config_home: Option<&OsStr>,
) -> Result<CompanionPaths, CompanionError> {
    let home = absolute_root(home.as_os_str(), "home")?;
    let data_home = match xdg_data_home {
        Some(value) if !value.is_empty() => absolute_root(value, "XDG_DATA_HOME")?,
        Some(_) | None => home.join(".local").join("share"),
    };
    let config_home = match xdg_config_home {
        Some(value) if !value.is_empty() => absolute_root(value, "XDG_CONFIG_HOME")?,
        Some(_) | None => home.join(".config"),
    };
    let binary = data_home
        .join("motrix")
        .join("native-messaging")
        .join(FLATPAK_COMPANION_BINARY);
    let config = config_home
        .join("motrix")
        .join("native-messaging")
        .join("flatpak-companion.json");
    let manifests = vec![
        ManifestTarget {
            family: ManifestFamily::Chromium,
            path: config_home
                .join("google-chrome")
                .join("NativeMessagingHosts")
                .join(MANIFEST_FILE_NAME),
        },
        ManifestTarget {
            family: ManifestFamily::Chromium,
            path: config_home
                .join("chromium")
                .join("NativeMessagingHosts")
                .join(MANIFEST_FILE_NAME),
        },
        ManifestTarget {
            family: ManifestFamily::Chromium,
            path: config_home
                .join("microsoft-edge")
                .join("NativeMessagingHosts")
                .join(MANIFEST_FILE_NAME),
        },
        ManifestTarget {
            family: ManifestFamily::Firefox,
            path: home
                .join(".mozilla")
                .join("native-messaging-hosts")
                .join(MANIFEST_FILE_NAME),
        },
    ];
    Ok(CompanionPaths {
        home_root: home,
        data_root: data_home,
        config_root: config_home,
        binary,
        config,
        manifests,
    })
}

pub fn current_companion_paths() -> Result<CompanionPaths, CompanionError> {
    let home = home::home_dir().ok_or_else(|| CompanionError::new("home directory unavailable"))?;
    resolve_companion_paths(
        &home,
        std::env::var_os("XDG_DATA_HOME").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
    )
}
