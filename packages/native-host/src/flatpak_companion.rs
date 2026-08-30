use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub use crate::MOTRIX_FLATPAK_ID;
use crate::broker_protocol::{
    BROKER_HEADER_BYTES, BrokerOperation, BrokerRequest, MAX_BROKER_MESSAGE_BYTES,
    decode_broker_response, write_broker_message,
};
use crate::resolve::{ResolveError, ResolveResult};

pub const FLATPAK_BROKER_COMMAND: &str = "motrix-native-host-broker";
pub const FLATPAK_COMPANION_BINARY: &str = "motrix-flatpak-native-host";
pub const NATIVE_MESSAGING_HOST_NAME: &str = "app.motrix.bridge";
pub const DEFAULT_FLATPAK_BIN: &str = "/usr/bin/flatpak";

const CONFIG_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE_NAME: &str = "app.motrix.bridge.json";
const MANIFEST_DESCRIPTION: &str = "Motrix browser download bridge";
const PROBE_PROCESS_TIMEOUT: Duration = Duration::from_secs(10);
// The broker's endpoint polling deadline is independently fixed at 15s. Give
// Flatpak process startup enough headroom without extending that security
// boundary on slower hosts.
const WAIT_PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);
const EMBEDDED_ALLOWLIST: &str =
    include_str!("../../../src/shared/config/native-messaging-extensions.json");

#[derive(Debug)]
pub struct CompanionError {
    message: String,
}

impl CompanionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn io(action: &str, path: &Path, error: std::io::Error) -> Self {
        Self::new(format!("{action} {}: {error}", path.display()))
    }
}

impl fmt::Display for CompanionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CompanionError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NativeMessagingAllowlist {
    pub chromium: Vec<String>,
    pub firefox: Vec<String>,
}

pub fn embedded_allowlist() -> Result<NativeMessagingAllowlist, CompanionError> {
    let allowlist: NativeMessagingAllowlist = serde_json::from_str(EMBEDDED_ALLOWLIST)
        .map_err(|error| CompanionError::new(format!("invalid embedded allowlist: {error}")))?;
    if allowlist.chromium.is_empty() || allowlist.firefox.is_empty() {
        return Err(CompanionError::new("embedded allowlist must not be empty"));
    }
    for id in &allowlist.chromium {
        if !is_chromium_extension_id(id) {
            return Err(CompanionError::new(format!(
                "invalid embedded Chromium extension ID: {id}"
            )));
        }
    }
    for id in &allowlist.firefox {
        if !is_firefox_extension_id(id) {
            return Err(CompanionError::new(format!(
                "invalid embedded Firefox extension ID: {id}"
            )));
        }
    }
    Ok(allowlist)
}

fn is_chromium_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

fn is_firefox_extension_id(id: &str) -> bool {
    let mut parts = id.split('@');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(left), Some(right), None) if !left.is_empty() && !right.is_empty()
            && !id.bytes().any(|byte| byte.is_ascii_whitespace())
    ) || (id.starts_with('{')
        && id.ends_with('}')
        && id.len() == 38
        && id[1..id.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
}

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

fn absolute_root(value: &OsStr, label: &str) -> Result<PathBuf, CompanionError> {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompanionCommand {
    Browser,
    Install { flatpak_bin: PathBuf, force: bool },
    Status,
    Uninstall,
    Help,
    Version,
}

pub fn parse_companion_command(args: &[OsString]) -> Result<CompanionCommand, CompanionError> {
    let Some(first) = args.first().and_then(|value| value.to_str()) else {
        return Ok(CompanionCommand::Browser);
    };
    match first {
        "install" => {
            let mut flatpak_bin = None;
            let mut force = false;
            let mut index = 1;
            while index < args.len() {
                let flag = args[index]
                    .to_str()
                    .ok_or_else(|| CompanionError::new("install arguments must be UTF-8"))?;
                match flag {
                    "--force" if !force => force = true,
                    "--force" => return Err(CompanionError::new("--force provided twice")),
                    "--flatpak-bin" if flatpak_bin.is_none() => {
                        index += 1;
                        let value = args
                            .get(index)
                            .ok_or_else(|| CompanionError::new("--flatpak-bin requires a value"))?;
                        flatpak_bin = Some(absolute_root(value, "--flatpak-bin")?);
                    }
                    "--flatpak-bin" => {
                        return Err(CompanionError::new("--flatpak-bin provided twice"));
                    }
                    _ => {
                        return Err(CompanionError::new(format!(
                            "unknown install argument: {flag}"
                        )));
                    }
                }
                index += 1;
            }
            Ok(CompanionCommand::Install {
                flatpak_bin: flatpak_bin.unwrap_or_else(|| PathBuf::from(DEFAULT_FLATPAK_BIN)),
                force,
            })
        }
        "status" if args.len() == 1 => Ok(CompanionCommand::Status),
        "uninstall" if args.len() == 1 => Ok(CompanionCommand::Uninstall),
        "--help" if args.len() == 1 => Ok(CompanionCommand::Help),
        "--version" if args.len() == 1 => Ok(CompanionCommand::Version),
        "status" | "uninstall" | "--help" | "--version" => {
            Err(CompanionError::new(format!("{first} takes no arguments")))
        }
        _ => Ok(CompanionCommand::Browser),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserCaller {
    Chromium { extension_id: String },
    Firefox { extension_id: String },
}

pub fn validate_browser_caller(
    args: &[OsString],
    allowlist: &NativeMessagingAllowlist,
    paths: &CompanionPaths,
) -> Result<BrowserCaller, CompanionError> {
    if args.len() == 1 {
        let origin = args[0]
            .to_str()
            .ok_or_else(|| CompanionError::new("Chromium caller origin must be UTF-8"))?;
        let extension_id = origin
            .strip_prefix("chrome-extension://")
            .map(|value| value.strip_suffix('/').unwrap_or(value))
            .filter(|value| !value.contains('/'))
            .ok_or_else(|| CompanionError::new("invalid Chromium caller origin"))?;
        if !allowlist
            .chromium
            .iter()
            .any(|allowed| allowed == extension_id)
        {
            return Err(CompanionError::new("Chromium caller is not allowlisted"));
        }
        return Ok(BrowserCaller::Chromium {
            extension_id: extension_id.into(),
        });
    }

    if args.len() == 2 {
        let manifest_path = PathBuf::from(&args[0]);
        let expected_manifest = paths
            .manifests
            .iter()
            .find(|target| target.family == ManifestFamily::Firefox)
            .map(|target| &target.path);
        if !manifest_path.is_absolute() || Some(&manifest_path) != expected_manifest {
            return Err(CompanionError::new("unexpected Firefox manifest path"));
        }
        let extension_id = args[1]
            .to_str()
            .ok_or_else(|| CompanionError::new("Firefox caller ID must be UTF-8"))?;
        if !allowlist
            .firefox
            .iter()
            .any(|allowed| allowed == extension_id)
        {
            return Err(CompanionError::new("Firefox caller is not allowlisted"));
        }
        return Ok(BrowserCaller::Firefox {
            extension_id: extension_id.into(),
        });
    }

    Err(CompanionError::new("missing or malformed browser caller"))
}

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

#[derive(Serialize)]
struct ChromiumManifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a Path,
    r#type: &'static str,
    allowed_origins: Vec<String>,
}

#[derive(Serialize)]
struct FirefoxManifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a Path,
    r#type: &'static str,
    allowed_extensions: &'a [String],
}

fn manifest_bytes(
    target: &ManifestTarget,
    binary: &Path,
    allowlist: &NativeMessagingAllowlist,
) -> Result<Vec<u8>, CompanionError> {
    let value = match target.family {
        ManifestFamily::Chromium => serde_json::to_value(ChromiumManifest {
            name: NATIVE_MESSAGING_HOST_NAME,
            description: MANIFEST_DESCRIPTION,
            path: binary,
            r#type: "stdio",
            allowed_origins: allowlist
                .chromium
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect(),
        }),
        ManifestFamily::Firefox => serde_json::to_value(FirefoxManifest {
            name: NATIVE_MESSAGING_HOST_NAME,
            description: MANIFEST_DESCRIPTION,
            path: binary,
            r#type: "stdio",
            allowed_extensions: &allowlist.firefox,
        }),
    }
    .map_err(|error| CompanionError::new(format!("serialize manifest: {error}")))?;
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| CompanionError::new(format!("serialize manifest: {error}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[derive(Deserialize)]
struct ManifestOwnership {
    name: String,
    path: PathBuf,
}

fn read_limited(path: &Path, maximum: u64) -> Result<Vec<u8>, CompanionError> {
    let file = File::open(path).map_err(|error| CompanionError::io("open", path, error))?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CompanionError::io("read", path, error))?;
    if bytes.len() as u64 > maximum {
        return Err(CompanionError::new(format!(
            "{} exceeds {maximum} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

fn manifest_points_to(path: &Path, binary: &Path) -> bool {
    let Ok(bytes) = read_limited(path, MAX_BROKER_MESSAGE_BYTES as u64) else {
        return false;
    };
    serde_json::from_slice::<ManifestOwnership>(&bytes).is_ok_and(|manifest| {
        manifest.name == NATIVE_MESSAGING_HOST_NAME && manifest.path == binary
    })
}

fn path_entry_exists(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

fn path_entry_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

#[derive(Clone, Copy)]
enum OwnerRequirement {
    Current,
    CurrentOrRoot,
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }

    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { geteuid() }
}

fn entry_metadata(path: &Path) -> Result<Option<fs::Metadata>, CompanionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CompanionError::io("inspect", path, error)),
    }
}

fn validate_owner(
    path: &Path,
    metadata: &fs::Metadata,
    requirement: OwnerRequirement,
) -> Result<(), CompanionError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        let owner = metadata.uid();
        let current = effective_user_id();
        let accepted = owner == current
            || matches!(requirement, OwnerRequirement::CurrentOrRoot) && owner == 0;
        if !accepted {
            return Err(CompanionError::new(format!(
                "{} is not owned by the current user{}",
                path.display(),
                if matches!(requirement, OwnerRequirement::CurrentOrRoot) {
                    " or root"
                } else {
                    ""
                }
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = (path, metadata, requirement);
    Ok(())
}

fn validate_directory(
    path: &Path,
    requirement: OwnerRequirement,
    allow_shared_sticky: bool,
) -> Result<(), CompanionError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CompanionError::io("inspect directory", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CompanionError::new(format!(
            "{} is not a real directory",
            path.display()
        )));
    }
    validate_owner(path, &metadata, requirement)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = metadata.permissions().mode();
        if mode & 0o022 != 0 && !(allow_shared_sticky && mode & 0o1000 != 0) {
            return Err(CompanionError::new(format!(
                "{} is writable by another user",
                path.display()
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = allow_shared_sticky;
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), CompanionError> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    let created = match builder.create(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(CompanionError::io("create directory", path, error)),
    };
    if !created {
        return validate_directory(path, OwnerRequirement::Current, false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| CompanionError::io("set directory permissions", path, error))?;
    }
    validate_directory(path, OwnerRequirement::Current, false)
}

fn prepare_private_root(root: &Path, create: bool) -> Result<(), CompanionError> {
    match entry_metadata(root)? {
        Some(_) => {
            validate_executable_parent_chain(root)?;
            return validate_directory(root, OwnerRequirement::Current, false);
        }
        None if !create => {
            return Err(CompanionError::new(format!(
                "private root is missing: {}",
                root.display()
            )));
        }
        None => {}
    }

    let mut missing = vec![root.to_path_buf()];
    let mut cursor = root
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", root.display())))?;
    loop {
        match entry_metadata(cursor)? {
            Some(_) => {
                if cursor.parent().is_some() {
                    validate_executable_parent_chain(cursor)?;
                }
                validate_directory(cursor, OwnerRequirement::CurrentOrRoot, true)?;
                break;
            }
            None => missing.push(cursor.to_path_buf()),
        }
        cursor = cursor.parent().ok_or_else(|| {
            CompanionError::new(format!("no existing ancestor for {}", root.display()))
        })?;
    }

    for directory in missing.iter().rev() {
        create_private_directory(directory)?;
    }
    validate_directory(root, OwnerRequirement::Current, false)
}

fn validate_private_parent(root: &Path, path: &Path, create: bool) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        CompanionError::new(format!(
            "{} escapes private root {}",
            path.display(),
            root.display()
        ))
    })?;
    prepare_private_root(root, create)?;

    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CompanionError::new(format!(
                "{} has a non-canonical component",
                path.display()
            )));
        };
        directory.push(name);
        match entry_metadata(&directory)? {
            Some(_) => validate_directory(&directory, OwnerRequirement::Current, false)?,
            None if create => create_private_directory(&directory)?,
            None => {
                return Err(CompanionError::new(format!(
                    "private directory is missing: {}",
                    directory.display()
                )));
            }
        }
    }
    Ok(())
}

fn validate_existing_private_parent_prefix(root: &Path, path: &Path) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        CompanionError::new(format!(
            "{} escapes private root {}",
            path.display(),
            root.display()
        ))
    })?;
    if entry_metadata(root)?.is_none() {
        return Ok(());
    }
    validate_directory(root, OwnerRequirement::Current, false)?;

    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CompanionError::new(format!(
                "{} has a non-canonical component",
                path.display()
            )));
        };
        directory.push(name);
        if entry_metadata(&directory)?.is_none() {
            return Ok(());
        }
        validate_directory(&directory, OwnerRequirement::Current, false)?;
    }
    Ok(())
}

fn destination_root<'a>(
    paths: &'a CompanionPaths,
    destination: &Path,
) -> Result<&'a Path, CompanionError> {
    if destination == paths.binary {
        return Ok(&paths.data_root);
    }
    if destination == paths.config {
        return Ok(&paths.config_root);
    }
    if let Some(target) = paths
        .manifests
        .iter()
        .find(|target| target.path == destination)
    {
        return Ok(match target.family {
            ManifestFamily::Chromium => &paths.config_root,
            ManifestFamily::Firefox => &paths.home_root,
        });
    }
    Err(CompanionError::new(format!(
        "unknown companion destination: {}",
        destination.display()
    )))
}

fn validate_regular_file(
    path: &Path,
    requirement: OwnerRequirement,
    exact_mode: Option<u32>,
    executable: bool,
) -> Result<(), CompanionError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CompanionError::io("inspect file", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CompanionError::new(format!(
            "{} is not a real regular file",
            path.display()
        )));
    }
    validate_owner(path, &metadata, requirement)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = metadata.permissions().mode();
        if let Some(expected) = exact_mode {
            if mode & 0o7777 != expected {
                return Err(CompanionError::new(format!(
                    "{} has mode {:04o}; expected {expected:04o}",
                    path.display(),
                    mode & 0o7777
                )));
            }
        } else if mode & 0o022 != 0 {
            return Err(CompanionError::new(format!(
                "{} is writable by another user",
                path.display()
            )));
        }
        if executable && mode & 0o111 == 0 {
            return Err(CompanionError::new(format!(
                "{} is not executable",
                path.display()
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = (exact_mode, executable);
    Ok(())
}

fn validate_private_file(
    paths: &CompanionPaths,
    path: &Path,
    expected_mode: u32,
) -> Result<(), CompanionError> {
    validate_private_parent(destination_root(paths, path)?, path, false)?;
    validate_regular_file(
        path,
        OwnerRequirement::Current,
        Some(expected_mode),
        expected_mode == 0o700,
    )
}

fn validate_executable_parent_chain(path: &Path) -> Result<(), CompanionError> {
    let parent = path
        .parent()
        .ok_or_else(|| CompanionError::new(format!("{} has no parent", path.display())))?;
    let mut ancestors = parent.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for directory in ancestors {
        validate_directory(directory, OwnerRequirement::CurrentOrRoot, true)?;
    }
    Ok(())
}

fn validate_source_executable(path: &Path) -> Result<PathBuf, CompanionError> {
    absolute_root(path.as_os_str(), "companion executable")?;
    validate_regular_file(path, OwnerRequirement::Current, None, true)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CompanionError::io("resolve companion executable", path, error))?;
    validate_executable_parent_chain(&canonical)?;
    Ok(canonical)
}

fn temporary_path(destination: &Path, attempt: u32) -> Result<PathBuf, CompanionError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CompanionError::new("destination has no parent"))?;
    let name = destination
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| CompanionError::new("destination name must be UTF-8"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(
        ".{name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        attempt
    )))
}

fn rename_replace(source: &Path, destination: &Path) -> Result<(), CompanionError> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| CompanionError::io("remove old file", destination, error))?;
    }
    fs::rename(source, destination)
        .map_err(|error| CompanionError::io("replace file", destination, error))
}

fn atomic_write(
    root: &Path,
    destination: &Path,
    bytes: &[u8],
    executable: bool,
) -> Result<(), CompanionError> {
    #[cfg(not(unix))]
    let _ = executable;
    validate_private_parent(root, destination, true)?;
    for attempt in 0..16 {
        let temporary = temporary_path(destination, attempt)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        let mut file = match options.open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CompanionError::io(
                    "create temporary file",
                    &temporary,
                    error,
                ));
            }
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(CompanionError::io(
                "write temporary file",
                &temporary,
                error,
            ));
        }
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o700 } else { 0o600 };
            if let Err(error) = fs::set_permissions(&temporary, fs::Permissions::from_mode(mode)) {
                let _ = fs::remove_file(&temporary);
                return Err(CompanionError::io("set permissions", &temporary, error));
            }
        }
        if let Err(error) = rename_replace(&temporary, destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        validate_regular_file(
            destination,
            OwnerRequirement::Current,
            Some(if executable { 0o700 } else { 0o600 }),
            executable,
        )?;
        return Ok(());
    }
    Err(CompanionError::new(format!(
        "could not allocate a temporary file for {}",
        destination.display()
    )))
}

fn atomic_copy(source: &Path, root: &Path, destination: &Path) -> Result<(), CompanionError> {
    let bytes = read_limited(source, 64 * 1024 * 1024)?;
    atomic_write(root, destination, &bytes, true)
}

fn validate_flatpak_binary(path: &Path) -> Result<PathBuf, CompanionError> {
    absolute_root(path.as_os_str(), "flatpak binary")?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| CompanionError::io("resolve flatpak binary", path, error))?;
    absolute_root(canonical.as_os_str(), "resolved flatpak binary")?;
    validate_executable_parent_chain(&canonical)?;
    validate_regular_file(&canonical, OwnerRequirement::CurrentOrRoot, None, true)?;
    Ok(canonical)
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

pub trait FlatpakRuntime {
    fn call_broker(&mut self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError>;
    fn launch_app(&mut self) -> bool;
}

pub fn resolve_flatpak_request<R: FlatpakRuntime>(
    allow_launch: bool,
    runtime: &mut R,
) -> ResolveResult {
    match runtime.call_broker(BrokerOperation::Probe) {
        Ok(result @ ResolveResult::RequestPair { .. }) => return result,
        Ok(ResolveResult::Error {
            error: ResolveError::NotRunning,
        }) => {}
        Ok(_) | Err(_) if !allow_launch => {
            return ResolveResult::Error {
                error: ResolveError::NotRunning,
            };
        }
        Ok(_) | Err(_) => {
            return ResolveResult::Error {
                error: ResolveError::NotInstalled,
            };
        }
    }

    if !allow_launch {
        return ResolveResult::Error {
            error: ResolveError::NotRunning,
        };
    }
    if !runtime.launch_app() {
        return ResolveResult::Error {
            error: ResolveError::NotInstalled,
        };
    }
    match runtime.call_broker(BrokerOperation::WaitForEndpoint) {
        Ok(result @ ResolveResult::RequestPair { .. }) => result,
        Ok(_) | Err(_) => ResolveResult::Error {
            error: ResolveError::LaunchFailed,
        },
    }
}

pub struct FlatpakProcessRuntime {
    flatpak_bin: PathBuf,
}

impl FlatpakProcessRuntime {
    pub fn new(flatpak_bin: PathBuf) -> Self {
        Self { flatpak_bin }
    }

    fn wait_for_child(
        mut child: std::process::Child,
        timeout: Duration,
    ) -> Result<(ExitStatus, Vec<u8>), CompanionError> {
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new("broker stdout pipe unavailable"));
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        if let Err(error) = thread::Builder::new()
            .name("flatpak-broker-output".into())
            .spawn(move || {
                let mut output = Vec::new();
                let maximum = BROKER_HEADER_BYTES + MAX_BROKER_MESSAGE_BYTES + 1;
                let result = stdout
                    .take(maximum as u64)
                    .read_to_end(&mut output)
                    .map(|_| output);
                let _ = sender.send(result);
            })
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new(format!("spawn output reader: {error}")));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| CompanionError::new("broker deadline overflow"))?;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(CHILD_POLL_INTERVAL),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompanionError::new("Flatpak broker timed out"));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompanionError::new(format!(
                        "wait for Flatpak broker: {error}"
                    )));
                }
            }
        };
        let output = receiver
            .recv_timeout(OUTPUT_DRAIN_TIMEOUT)
            .map_err(|_| CompanionError::new("Flatpak broker stdout did not close"))?
            .map_err(|error| CompanionError::new(format!("read Flatpak broker stdout: {error}")))?;
        if output.len() > BROKER_HEADER_BYTES + MAX_BROKER_MESSAGE_BYTES {
            return Err(CompanionError::new("Flatpak broker output exceeded limit"));
        }
        Ok((status, output))
    }

    fn invoke_broker(&self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError> {
        let mut child = Command::new(&self.flatpak_bin)
            .arg("run")
            .arg(format!("--command={FLATPAK_BROKER_COMMAND}"))
            .arg(MOTRIX_FLATPAK_ID)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| CompanionError::new(format!("start Flatpak broker: {error}")))?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new("broker stdin pipe unavailable"));
        };
        if let Err(error) = write_broker_message(&mut stdin, &BrokerRequest { operation }) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new(format!(
                "write broker request: {error}"
            )));
        }
        drop(stdin);
        let timeout = match operation {
            BrokerOperation::Probe => PROBE_PROCESS_TIMEOUT,
            BrokerOperation::WaitForEndpoint => WAIT_PROCESS_TIMEOUT,
        };
        let (status, output) = Self::wait_for_child(child, timeout)?;
        if !status.success() {
            return Err(CompanionError::new(format!(
                "Flatpak broker exited with {status}"
            )));
        }
        let result = decode_broker_response(&output)
            .map_err(|error| CompanionError::new(format!("validate broker response: {error}")))?;
        let expected = matches!(
            (operation, &result),
            (BrokerOperation::Probe, ResolveResult::RequestPair { .. })
                | (
                    BrokerOperation::Probe,
                    ResolveResult::Error {
                        error: ResolveError::NotRunning
                    }
                )
                | (
                    BrokerOperation::WaitForEndpoint,
                    ResolveResult::RequestPair { .. }
                )
                | (
                    BrokerOperation::WaitForEndpoint,
                    ResolveResult::Error {
                        error: ResolveError::LaunchFailed
                    }
                )
        );
        if !expected {
            return Err(CompanionError::new(
                "broker returned a result invalid for the requested operation",
            ));
        }
        Ok(result)
    }
}

impl FlatpakRuntime for FlatpakProcessRuntime {
    fn call_broker(&mut self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError> {
        self.invoke_broker(operation)
    }

    fn launch_app(&mut self) -> bool {
        let mut command = Command::new(&self.flatpak_bin);
        command
            .arg("run")
            .arg(MOTRIX_FLATPAK_ID)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        match command.spawn() {
            Ok(mut child) => {
                thread::spawn(move || {
                    let _ = child.wait();
                });
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::{Value, json};

    use super::{
        BrowserCaller, CompanionError, FlatpakRuntime, ManifestFamily, companion_status,
        embedded_allowlist, install_companion, resolve_companion_paths, resolve_flatpak_request,
        uninstall_companion, validate_browser_caller,
    };
    #[cfg(unix)]
    use super::{
        CompanionCommand, FlatpakProcessRuntime, load_companion_config, parse_companion_command,
    };
    use crate::broker_protocol::BrokerOperation;
    #[cfg(unix)]
    use crate::broker_protocol::encode_broker_message;
    use crate::resolve::{ResolveError, ResolveResult};

    const CHROMIUM_ID: &str = "ibpkjhgpbidfmbmomagmldcdlpbmchgi";
    const FIREFOX_ID: &str = "motrix-extension@motrix.app";
    const NONCE: &str = "AbCdEfGhIjKlMnOpQrStUv";

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let temporary_root =
                fs::canonicalize(std::env::temp_dir()).expect("canonical temporary directory");
            let path = temporary_root.join(format!(
                "motrix-flatpak-companion-{label}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp directory");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn make_executable(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().expect("executable parent")).expect("create parent");
        fs::write(path, contents).expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("make executable");
        }
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set mode");
    }

    #[cfg(unix)]
    fn assert_private_directory_chain(root: &Path, destination: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let parent = destination.parent().expect("destination parent");
        let relative = parent.strip_prefix(root).expect("destination under root");
        let mut directory = root.to_path_buf();
        assert_eq!(
            fs::symlink_metadata(&directory)
                .expect("root metadata")
                .permissions()
                .mode()
                & 0o7777,
            0o700,
            "unexpected mode for {}",
            directory.display()
        );
        for component in relative.components() {
            directory.push(component.as_os_str());
            assert_eq!(
                fs::symlink_metadata(&directory)
                    .expect("directory metadata")
                    .permissions()
                    .mode()
                    & 0o7777,
                0o700,
                "unexpected mode for {}",
                directory.display()
            );
        }
    }

    fn explicit_paths(temp: &TempDir) -> super::CompanionPaths {
        let data = temp.path.join("data");
        let config = temp.path.join("config");
        resolve_companion_paths(
            &temp.path.join("home"),
            Some(data.as_os_str()),
            Some(config.as_os_str()),
        )
        .expect("resolve paths")
    }

    #[test]
    fn resolves_xdg_and_documented_fallback_paths() {
        let temp = TempDir::new("paths");
        let home = temp.path.join("home");
        let fallback = resolve_companion_paths(&home, None, None).expect("fallback paths");
        assert_eq!(
            fallback.binary,
            home.join(".local/share/motrix/native-messaging/motrix-flatpak-native-host")
        );
        assert_eq!(
            fallback.config,
            home.join(".config/motrix/native-messaging/flatpak-companion.json")
        );
        assert_eq!(fallback.manifests.len(), 4);
        assert_eq!(
            fallback
                .manifests
                .iter()
                .filter(|target| target.family == ManifestFamily::Firefox)
                .map(|target| target.path.clone())
                .collect::<Vec<_>>(),
            vec![home.join(".mozilla/native-messaging-hosts/app.motrix.bridge.json")]
        );

        let explicit = explicit_paths(&temp);
        assert!(explicit.binary.starts_with(temp.path.join("data")));
        assert!(explicit.config.starts_with(temp.path.join("config")));
        assert_eq!(
            explicit
                .manifests
                .iter()
                .filter(|target| target.family == ManifestFamily::Chromium)
                .count(),
            3
        );

        let empty_xdg = resolve_companion_paths(&home, Some(OsStr::new("")), Some(OsStr::new("")))
            .expect("empty XDG values use fallbacks");
        assert_eq!(empty_xdg.binary, fallback.binary);
        assert_eq!(empty_xdg.config, fallback.config);
    }

    #[cfg(unix)]
    #[test]
    fn parses_only_the_documented_management_cli() {
        assert_eq!(
            parse_companion_command(&[]).expect("browser mode"),
            CompanionCommand::Browser
        );
        assert_eq!(
            parse_companion_command(&[OsString::from("install")]).expect("default install"),
            CompanionCommand::Install {
                flatpak_bin: PathBuf::from("/usr/bin/flatpak"),
                force: false,
            }
        );
        assert_eq!(
            parse_companion_command(&[
                OsString::from("install"),
                OsString::from("--force"),
                OsString::from("--flatpak-bin"),
                OsString::from("/opt/flatpak/bin/flatpak"),
            ])
            .expect("custom install"),
            CompanionCommand::Install {
                flatpak_bin: PathBuf::from("/opt/flatpak/bin/flatpak"),
                force: true,
            }
        );
        assert!(
            parse_companion_command(&[
                OsString::from("install"),
                OsString::from("--flatpak-bin"),
                OsString::from("relative/flatpak"),
            ])
            .is_err()
        );
        assert!(
            parse_companion_command(&[OsString::from("status"), OsString::from("extra")]).is_err()
        );
    }

    #[test]
    fn validates_exact_browser_caller_shapes_before_broker_access() {
        let temp = TempDir::new("caller");
        let paths = explicit_paths(&temp);
        let allowlist = embedded_allowlist().expect("embedded allowlist");

        for origin in [
            format!("chrome-extension://{CHROMIUM_ID}"),
            format!("chrome-extension://{CHROMIUM_ID}/"),
        ] {
            assert_eq!(
                validate_browser_caller(&[origin.into()], &allowlist, &paths)
                    .expect("Chromium caller"),
                BrowserCaller::Chromium {
                    extension_id: CHROMIUM_ID.into()
                }
            );
        }
        for invalid in [
            format!("chrome-extension://{CHROMIUM_ID}//"),
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".into(),
            format!("https://{CHROMIUM_ID}/"),
        ] {
            assert!(
                validate_browser_caller(&[invalid.into()], &allowlist, &paths).is_err(),
                "accepted invalid Chromium caller"
            );
        }

        let firefox_manifest = paths
            .manifests
            .iter()
            .find(|target| target.family == ManifestFamily::Firefox)
            .expect("Firefox target")
            .path
            .clone();
        assert_eq!(
            validate_browser_caller(
                &[
                    firefox_manifest.clone().into_os_string(),
                    OsString::from(FIREFOX_ID),
                ],
                &allowlist,
                &paths,
            )
            .expect("Firefox caller"),
            BrowserCaller::Firefox {
                extension_id: FIREFOX_ID.into()
            }
        );
        assert!(
            validate_browser_caller(
                &[
                    firefox_manifest
                        .with_file_name("other.json")
                        .into_os_string(),
                    OsString::from(FIREFOX_ID),
                ],
                &allowlist,
                &paths,
            )
            .is_err()
        );
        assert!(validate_browser_caller(&[], &allowlist, &paths).is_err());
        assert!(
            validate_browser_caller(
                &[
                    OsString::from(format!("chrome-extension://{CHROMIUM_ID}/")),
                    OsString::from("unexpected"),
                    OsString::from("argument"),
                ],
                &allowlist,
                &paths,
            )
            .is_err()
        );
    }

    #[test]
    fn install_writes_binary_config_and_all_browser_manifests() {
        let temp = TempDir::new("install");
        let paths = explicit_paths(&temp);
        let source = temp.path.join("source-companion");
        let flatpak = temp.path.join("bin/flatpak");
        make_executable(&source, b"companion-binary");
        make_executable(&flatpak, b"flatpak-binary");
        let allowlist = embedded_allowlist().expect("embedded allowlist");

        install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");
        assert_eq!(
            fs::read(&paths.binary).expect("installed binary"),
            b"companion-binary"
        );
        let config: Value = serde_json::from_slice(&fs::read(&paths.config).expect("config"))
            .expect("parse config");
        assert_eq!(config["schemaVersion"], 1);
        assert_eq!(
            config["flatpakBin"],
            fs::canonicalize(&flatpak)
                .expect("canonical flatpak")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(
            config["installedBinary"],
            paths.binary.to_string_lossy().as_ref()
        );

        for target in &paths.manifests {
            let manifest: Value = serde_json::from_slice(
                &fs::read(&target.path)
                    .unwrap_or_else(|_| panic!("read {}", target.path.display())),
            )
            .expect("parse manifest");
            assert_eq!(manifest["name"], "app.motrix.bridge");
            assert_eq!(manifest["path"], paths.binary.to_string_lossy().as_ref());
            assert_eq!(manifest["type"], "stdio");
            match target.family {
                ManifestFamily::Chromium => assert_eq!(
                    manifest["allowed_origins"],
                    json!([format!("chrome-extension://{CHROMIUM_ID}/")])
                ),
                ManifestFamily::Firefox => {
                    assert_eq!(manifest["allowed_extensions"], json!([FIREFOX_ID]))
                }
            }
        }
        assert!(companion_status(&paths, &allowlist).installed);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.binary)
                    .expect("binary metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&paths.config)
                    .expect("config metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            for target in &paths.manifests {
                assert_eq!(
                    fs::metadata(&target.path)
                        .expect("manifest metadata")
                        .permissions()
                        .mode()
                        & 0o7777,
                    0o600
                );
            }
            assert_private_directory_chain(&paths.data_root, &paths.binary);
            assert_private_directory_chain(&paths.config_root, &paths.config);
            for target in &paths.manifests {
                let root = match target.family {
                    ManifestFamily::Chromium => &paths.config_root,
                    ManifestFamily::Firefox => &paths.home_root,
                };
                assert_private_directory_chain(root, &target.path);
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn install_rejects_symlinked_or_other_writable_private_directories() {
        use std::os::unix::fs::symlink;

        let symlink_temp = TempDir::new("symlink-root");
        let symlink_paths = explicit_paths(&symlink_temp);
        let source = symlink_temp.path.join("source-companion");
        let flatpak = symlink_temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        let redirect = symlink_temp.path.join("redirect");
        fs::create_dir(&redirect).expect("create redirect");
        symlink(&redirect, &symlink_paths.data_root).expect("symlink data root");
        let allowlist = embedded_allowlist().expect("allowlist");
        assert!(install_companion(&symlink_paths, &source, &flatpak, &allowlist, true,).is_err());
        assert!(!redirect.join("motrix").exists());
        assert!(uninstall_companion(&symlink_paths).is_err());

        let writable_temp = TempDir::new("writable-parent");
        let writable_paths = explicit_paths(&writable_temp);
        let source = writable_temp.path.join("source-companion");
        let flatpak = writable_temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        fs::create_dir(&writable_paths.config_root).expect("create config root");
        let insecure = writable_paths.config_root.join("google-chrome");
        fs::create_dir(&insecure).expect("create insecure browser directory");
        set_mode(&insecure, 0o777);
        assert!(install_companion(&writable_paths, &source, &flatpak, &allowlist, true,).is_err());
        assert!(!writable_paths.binary.exists());

        let ancestor_temp = TempDir::new("writable-ancestor");
        let shared = ancestor_temp.path.join("shared");
        fs::create_dir(&shared).expect("create shared ancestor");
        set_mode(&shared, 0o777);
        let data_root = shared.join("victim-data");
        fs::create_dir(&data_root).expect("create private data root");
        set_mode(&data_root, 0o700);
        let ancestor_paths = resolve_companion_paths(
            &ancestor_temp.path.join("home"),
            Some(data_root.as_os_str()),
            Some(ancestor_temp.path.join("config").as_os_str()),
        )
        .expect("resolve paths below writable ancestor");
        let source = ancestor_temp.path.join("source-companion");
        let flatpak = ancestor_temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        assert!(
            install_companion(&ancestor_paths, &source, &flatpak, &allowlist, true).is_err(),
            "a private root below a non-sticky writable ancestor was accepted"
        );
        assert!(!ancestor_paths.binary.exists());
    }

    #[test]
    #[cfg(unix)]
    fn install_validates_source_and_canonicalizes_a_safe_flatpak_binary() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("executables");
        let paths = explicit_paths(&temp);
        let source = temp.path.join("source-companion");
        let flatpak = temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        let allowlist = embedded_allowlist().expect("allowlist");

        set_mode(&source, 0o777);
        assert!(install_companion(&paths, &source, &flatpak, &allowlist, true).is_err());
        set_mode(&source, 0o755);
        set_mode(&flatpak, 0o777);
        assert!(install_companion(&paths, &source, &flatpak, &allowlist, true).is_err());
        set_mode(&flatpak, 0o755);

        let insecure_parent = temp.path.join("insecure-flatpak-parent");
        fs::create_dir(&insecure_parent).expect("create insecure parent");
        set_mode(&insecure_parent, 0o777);
        let insecure_flatpak = insecure_parent.join("flatpak");
        make_executable(&insecure_flatpak, b"flatpak");
        assert!(install_companion(&paths, &source, &insecure_flatpak, &allowlist, true,).is_err());

        let flatpak_link = temp.path.join("flatpak-link");
        symlink(&flatpak, &flatpak_link).expect("create flatpak symlink");
        install_companion(&paths, &source, &flatpak_link, &allowlist, true)
            .expect("install through canonicalized flatpak path");
        let config: Value = serde_json::from_slice(&fs::read(&paths.config).expect("config"))
            .expect("parse config");
        assert_eq!(
            config["flatpakBin"],
            fs::canonicalize(&flatpak)
                .expect("canonical flatpak")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    #[cfg(unix)]
    fn status_load_and_uninstall_fail_closed_for_unsafe_installation_entries() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new("fail-closed");
        let paths = explicit_paths(&temp);
        let source = temp.path.join("source-companion");
        let flatpak = temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        let allowlist = embedded_allowlist().expect("allowlist");
        install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");

        set_mode(&paths.binary, 0o777);
        assert!(!companion_status(&paths, &allowlist).installed);
        assert!(load_companion_config(&paths, &paths.binary).is_err());
        assert!(uninstall_companion(&paths).is_err());
        set_mode(&paths.binary, 0o700);

        fs::remove_file(&paths.config).expect("remove config");
        symlink(paths.config.with_extension("missing"), &paths.config)
            .expect("create dangling config symlink");
        assert!(!companion_status(&paths, &allowlist).installed);
        assert!(load_companion_config(&paths, &paths.binary).is_err());
        assert!(uninstall_companion(&paths).is_err());

        fs::remove_file(&paths.config).expect("remove config symlink");
        install_companion(&paths, &source, &flatpak, &allowlist, true).expect("repair install");
        let manifest = &paths.manifests[0].path;
        fs::remove_file(manifest).expect("remove manifest");
        symlink(manifest.with_extension("missing"), manifest)
            .expect("create dangling manifest symlink");
        assert!(!companion_status(&paths, &allowlist).installed);
        assert!(uninstall_companion(&paths).is_err());
    }

    #[test]
    fn install_refuses_unowned_files_unless_force_is_explicit() {
        let temp = TempDir::new("conflict");
        let paths = explicit_paths(&temp);
        let source = temp.path.join("source-companion");
        let flatpak = temp.path.join("bin/flatpak");
        make_executable(&source, b"new-companion");
        make_executable(&flatpak, b"flatpak");
        let allowlist = embedded_allowlist().expect("embedded allowlist");

        let conflict = &paths.manifests[0].path;
        fs::create_dir_all(conflict.parent().expect("manifest parent")).expect("create parent");
        fs::write(
            conflict,
            br#"{"name":"org.example.foreign","path":"/foreign"}"#,
        )
        .expect("write foreign manifest");
        assert!(install_companion(&paths, &source, &flatpak, &allowlist, false).is_err());
        assert!(!paths.binary.exists());
        install_companion(&paths, &source, &flatpak, &allowlist, true).expect("forced install");

        let second = TempDir::new("binary-conflict");
        let second_paths = explicit_paths(&second);
        fs::create_dir_all(second_paths.binary.parent().expect("binary parent"))
            .expect("create binary parent");
        fs::write(&second_paths.binary, b"foreign-binary").expect("foreign binary");
        assert!(install_companion(&second_paths, &source, &flatpak, &allowlist, false,).is_err());
        assert_eq!(
            fs::read(&second_paths.binary).expect("preserved foreign binary"),
            b"foreign-binary"
        );
    }

    #[test]
    fn uninstall_removes_only_manifests_still_owned_by_the_companion() {
        let temp = TempDir::new("uninstall");
        let paths = explicit_paths(&temp);
        let source = temp.path.join("source-companion");
        let flatpak = temp.path.join("bin/flatpak");
        make_executable(&source, b"companion");
        make_executable(&flatpak, b"flatpak");
        let allowlist = embedded_allowlist().expect("embedded allowlist");
        install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");

        let foreign = &paths.manifests[0].path;
        fs::write(
            foreign,
            br#"{"name":"org.example.foreign","path":"/foreign"}"#,
        )
        .expect("replace one manifest");
        uninstall_companion(&paths).expect("uninstall");

        assert!(foreign.exists(), "foreign manifest must be preserved");
        for target in paths.manifests.iter().skip(1) {
            assert!(!target.path.exists(), "owned manifest was preserved");
        }
        assert!(!paths.config.exists());
        assert!(!paths.binary.exists());
    }

    struct FakeRuntime {
        responses: VecDeque<Result<ResolveResult, CompanionError>>,
        calls: Vec<BrokerOperation>,
        launch_result: bool,
        launch_calls: usize,
    }

    impl FakeRuntime {
        fn new(responses: Vec<Result<ResolveResult, CompanionError>>) -> Self {
            Self {
                responses: responses.into(),
                calls: Vec::new(),
                launch_result: true,
                launch_calls: 0,
            }
        }
    }

    impl FlatpakRuntime for FakeRuntime {
        fn call_broker(
            &mut self,
            operation: BrokerOperation,
        ) -> Result<ResolveResult, CompanionError> {
            self.calls.push(operation);
            self.responses.pop_front().expect("queued broker response")
        }

        fn launch_app(&mut self) -> bool {
            self.launch_calls += 1;
            self.launch_result
        }
    }

    fn error(error: ResolveError) -> ResolveResult {
        ResolveResult::Error { error }
    }

    #[test]
    fn flatpak_resolution_probes_then_launches_then_waits_without_weakening_errors() {
        let pair = ResolveResult::request_pair(55_809, NONCE.into());
        let mut live = FakeRuntime::new(vec![Ok(pair.clone())]);
        assert_eq!(resolve_flatpak_request(true, &mut live), pair);
        assert_eq!(live.calls, vec![BrokerOperation::Probe]);
        assert_eq!(live.launch_calls, 0);

        let mut no_launch = FakeRuntime::new(vec![Ok(error(ResolveError::NotRunning))]);
        assert_eq!(
            resolve_flatpak_request(false, &mut no_launch),
            error(ResolveError::NotRunning)
        );
        assert_eq!(no_launch.launch_calls, 0);

        let pair = ResolveResult::request_pair(55_810, NONCE.into());
        let mut launched =
            FakeRuntime::new(vec![Ok(error(ResolveError::NotRunning)), Ok(pair.clone())]);
        assert_eq!(resolve_flatpak_request(true, &mut launched), pair);
        assert_eq!(
            launched.calls,
            vec![BrokerOperation::Probe, BrokerOperation::WaitForEndpoint]
        );
        assert_eq!(launched.launch_calls, 1);

        let mut unavailable = FakeRuntime::new(vec![Err(CompanionError::new("not installed"))]);
        assert_eq!(
            resolve_flatpak_request(true, &mut unavailable),
            error(ResolveError::NotInstalled)
        );
        assert_eq!(unavailable.launch_calls, 0);

        let mut launch_failed = FakeRuntime::new(vec![
            Ok(error(ResolveError::NotRunning)),
            Err(CompanionError::new("wait failed")),
        ]);
        assert_eq!(
            resolve_flatpak_request(true, &mut launch_failed),
            error(ResolveError::LaunchFailed)
        );
    }

    #[cfg(unix)]
    fn shell_octal(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("\\{byte:03o}")).collect()
    }

    #[cfg(unix)]
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
    }

    #[test]
    #[cfg(unix)]
    fn process_runtime_uses_fixed_flatpak_commands_and_rejects_stdout_pollution() {
        let temp = TempDir::new("runtime-process");
        let flatpak = temp.path.join("flatpak");
        let marker = temp.path.join("launched");
        let response = encode_broker_message(&error(ResolveError::NotRunning))
            .expect("encode broker response");
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$#\" -eq 2 ]; then\n\
               [ \"$1\" = run ] && [ \"$2\" = app.motrix.native ] || exit 91\n\
               : > {}\n\
               exit 0\n\
             fi\n\
             [ \"$#\" -eq 3 ] || exit 92\n\
             [ \"$1\" = run ] || exit 93\n\
             [ \"$2\" = --command=motrix-native-host-broker ] || exit 94\n\
             [ \"$3\" = app.motrix.native ] || exit 95\n\
             cat >/dev/null\n\
             printf '{}'\n",
            shell_quote(&marker),
            shell_octal(&response),
        );
        make_executable(&flatpak, script.as_bytes());

        let mut runtime = FlatpakProcessRuntime::new(flatpak.clone());
        assert_eq!(
            runtime
                .call_broker(BrokerOperation::Probe)
                .expect("probe broker"),
            error(ResolveError::NotRunning)
        );
        assert!(runtime.launch_app());
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists(), "fixed Flatpak launch command was not used");

        let polluted_script = format!(
            "#!/bin/sh\ncat >/dev/null\nprintf '{}x'\n",
            shell_octal(&response)
        );
        make_executable(&flatpak, polluted_script.as_bytes());
        assert!(runtime.call_broker(BrokerOperation::Probe).is_err());

        let unexpected = encode_broker_message(&error(ResolveError::LaunchFailed))
            .expect("encode unexpected response");
        let unexpected_script = format!(
            "#!/bin/sh\ncat >/dev/null\nprintf '{}'\n",
            shell_octal(&unexpected)
        );
        make_executable(&flatpak, unexpected_script.as_bytes());
        assert!(runtime.call_broker(BrokerOperation::Probe).is_err());
    }

    #[test]
    fn allowlist_file_is_strict_and_matches_manifest_contract() {
        let allowlist = embedded_allowlist().expect("embedded allowlist");
        assert_eq!(allowlist.chromium, [CHROMIUM_ID]);
        assert_eq!(allowlist.firefox, [FIREFOX_ID]);
        assert!(!super::is_chromium_extension_id(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA"
        ));
        assert!(!super::is_firefox_extension_id("invalid id@example.com"));
        assert!(super::absolute_root(OsStr::new("relative"), "path").is_err());
    }
}
