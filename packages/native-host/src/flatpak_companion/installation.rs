use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::CompanionError;
use super::allowlist::NativeMessagingAllowlist;
use super::manifest::{manifest_bytes, manifest_points_to};
use super::paths::CompanionPaths;
use super::secure_fs::{
    OwnerRequirement, atomic_copy, atomic_write, destination_root, path_entry_exists,
    path_entry_is_symlink, read_limited, validate_existing_private_parent_prefix,
    validate_flatpak_binary, validate_private_file, validate_private_parent, validate_regular_file,
    validate_source_executable,
};
use crate::broker_protocol::MAX_BROKER_MESSAGE_BYTES;

const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompanionConfig {
    schema_version: u32,
    flatpak_bin: PathBuf,
    installed_binary: PathBuf,
}

impl CompanionConfig {
    fn new(flatpak_bin: PathBuf, installed_binary: PathBuf) -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            flatpak_bin,
            installed_binary,
        }
    }

    pub fn flatpak_bin(&self) -> &Path {
        &self.flatpak_bin
    }
}

pub fn install_companion(
    paths: &CompanionPaths,
    source_executable: &Path,
    flatpak_bin: &Path,
    allowlist: &NativeMessagingAllowlist,
    force: bool,
) -> Result<(), CompanionError> {
    let canonical_flatpak = validate_flatpak_binary(flatpak_bin)?;
    let canonical_source = validate_source_executable(source_executable)?;

    for destination in std::iter::once(&paths.binary)
        .chain(std::iter::once(&paths.config))
        .chain(paths.manifests.iter().map(|target| &target.path))
    {
        validate_private_parent(destination_root(paths, destination)?, destination, true)?;
    }

    let existing_config = validate_private_file(paths, &paths.config, 0o600)
        .ok()
        .and_then(|()| read_limited(&paths.config, MAX_BROKER_MESSAGE_BYTES as u64).ok())
        .and_then(|bytes| serde_json::from_slice::<CompanionConfig>(&bytes).ok());
    let config_owned = existing_config.as_ref().is_some_and(|config| {
        config.schema_version == CONFIG_SCHEMA_VERSION && config.installed_binary == paths.binary
    });

    if path_entry_exists(&paths.config)
        && (path_entry_is_symlink(&paths.config) || !config_owned)
        && !force
    {
        return Err(CompanionError::new(format!(
            "refusing to replace unowned config {}; pass --force",
            paths.config.display()
        )));
    }
    for target in &paths.manifests {
        let manifest_owned = validate_private_file(paths, &target.path, 0o600).is_ok()
            && manifest_points_to(&target.path, &paths.binary);
        if path_entry_exists(&target.path)
            && (path_entry_is_symlink(&target.path) || !manifest_owned)
            && !force
        {
            return Err(CompanionError::new(format!(
                "refusing to replace unowned manifest {}; pass --force",
                target.path.display()
            )));
        }
    }
    let source_is_installed =
        fs::canonicalize(&paths.binary).is_ok_and(|installed| installed == canonical_source);
    let binary_owned = validate_private_file(paths, &paths.binary, 0o700).is_ok() && config_owned;
    if !source_is_installed
        && path_entry_exists(&paths.binary)
        && (path_entry_is_symlink(&paths.binary) || !binary_owned)
        && !force
    {
        return Err(CompanionError::new(format!(
            "refusing to replace unowned binary {}; pass --force",
            paths.binary.display()
        )));
    }

    if source_is_installed {
        validate_private_file(paths, &paths.binary, 0o700)?;
    } else {
        atomic_copy(source_executable, &paths.data_root, &paths.binary)?;
    }
    let config = CompanionConfig::new(canonical_flatpak, paths.binary.clone());
    let mut config_bytes = serde_json::to_vec_pretty(&config)
        .map_err(|error| CompanionError::new(format!("serialize config: {error}")))?;
    config_bytes.push(b'\n');
    atomic_write(&paths.config_root, &paths.config, &config_bytes, false)?;
    for target in &paths.manifests {
        atomic_write(
            destination_root(paths, &target.path)?,
            &target.path,
            &manifest_bytes(target, &paths.binary, allowlist)?,
            false,
        )?;
    }
    Ok(())
}

pub fn load_companion_config(
    paths: &CompanionPaths,
    current_executable: &Path,
) -> Result<CompanionConfig, CompanionError> {
    validate_private_file(paths, &paths.config, 0o600)?;
    validate_private_file(paths, &paths.binary, 0o700)?;
    let bytes = read_limited(&paths.config, MAX_BROKER_MESSAGE_BYTES as u64)?;
    let config: CompanionConfig = serde_json::from_slice(&bytes)
        .map_err(|error| CompanionError::new(format!("invalid companion config: {error}")))?;
    let expected_executable = fs::canonicalize(&paths.binary).map_err(|error| {
        CompanionError::io("resolve installed executable", &paths.binary, error)
    })?;
    let actual_executable = fs::canonicalize(current_executable).map_err(|error| {
        CompanionError::io("resolve current executable", current_executable, error)
    })?;
    if config.schema_version != CONFIG_SCHEMA_VERSION
        || config.installed_binary != paths.binary
        || actual_executable != expected_executable
    {
        return Err(CompanionError::new(
            "companion config does not own this executable",
        ));
    }
    let canonical_flatpak = validate_flatpak_binary(&config.flatpak_bin)?;
    if canonical_flatpak != config.flatpak_bin {
        return Err(CompanionError::new(
            "configured flatpak binary path is not canonical",
        ));
    }
    Ok(config)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanionStatus {
    pub installed: bool,
    pub issues: Vec<String>,
}

pub fn companion_status(
    paths: &CompanionPaths,
    allowlist: &NativeMessagingAllowlist,
) -> CompanionStatus {
    let mut issues = Vec::new();
    let config = validate_private_file(paths, &paths.config, 0o600)
        .and_then(|()| read_limited(&paths.config, MAX_BROKER_MESSAGE_BYTES as u64))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CompanionConfig>(&bytes).ok());
    if config.as_ref().is_none_or(|config| {
        config.schema_version != CONFIG_SCHEMA_VERSION || config.installed_binary != paths.binary
    }) {
        issues.push("config missing, malformed, or unowned".into());
    } else if let Some(config) = &config
        && !validate_flatpak_binary(&config.flatpak_bin)
            .is_ok_and(|canonical| canonical == config.flatpak_bin)
    {
        issues.push("configured flatpak binary is unavailable or unsafe".into());
    }

    if validate_private_file(paths, &paths.binary, 0o700).is_err() {
        issues.push("installed companion binary is missing or unsafe".into());
    }

    for target in &paths.manifests {
        let expected = manifest_bytes(target, &paths.binary, allowlist)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let actual = validate_private_file(paths, &target.path, 0o600)
            .and_then(|()| read_limited(&target.path, MAX_BROKER_MESSAGE_BYTES as u64))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if expected.is_none() || expected != actual {
            issues.push(format!(
                "manifest missing or stale: {}",
                target.path.display()
            ));
        }
    }

    CompanionStatus {
        installed: issues.is_empty(),
        issues,
    }
}

pub fn uninstall_companion(paths: &CompanionPaths) -> Result<(), CompanionError> {
    let destinations = std::iter::once(&paths.binary)
        .chain(std::iter::once(&paths.config))
        .chain(paths.manifests.iter().map(|target| &target.path));
    for destination in destinations.clone() {
        validate_existing_private_parent_prefix(
            destination_root(paths, destination)?,
            destination,
        )?;
    }
    if !destinations.clone().any(|path| path_entry_exists(path)) {
        return Ok(());
    }

    for destination in destinations {
        if !path_entry_exists(destination) {
            continue;
        }
        validate_private_parent(destination_root(paths, destination)?, destination, false)?;
        validate_regular_file(destination, OwnerRequirement::Current, None, false)?;
    }

    let config_owned = if path_entry_exists(&paths.config) {
        validate_private_file(paths, &paths.config, 0o600).is_ok()
            && read_limited(&paths.config, MAX_BROKER_MESSAGE_BYTES as u64)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<CompanionConfig>(&bytes).ok())
                .is_some_and(|config| {
                    config.schema_version == CONFIG_SCHEMA_VERSION
                        && config.installed_binary == paths.binary
                })
    } else {
        false
    };
    let mut manifests_to_remove = Vec::new();
    for target in &paths.manifests {
        if path_entry_exists(&target.path)
            && validate_private_file(paths, &target.path, 0o600).is_ok()
            && manifest_points_to(&target.path, &paths.binary)
        {
            manifests_to_remove.push(&target.path);
        }
    }
    if config_owned && path_entry_exists(&paths.binary) {
        validate_private_file(paths, &paths.binary, 0o700)?;
    }

    for manifest in manifests_to_remove {
        fs::remove_file(manifest)
            .map_err(|error| CompanionError::io("remove manifest", manifest, error))?;
    }
    if config_owned {
        fs::remove_file(&paths.config)
            .map_err(|error| CompanionError::io("remove config", &paths.config, error))?;
    }
    if config_owned && paths.binary.exists() {
        fs::remove_file(&paths.binary)
            .map_err(|error| CompanionError::io("remove companion binary", &paths.binary, error))?;
    }
    Ok(())
}
