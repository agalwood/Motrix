//! The AppImage copy uses a distinct executable name and an owner-only sidecar.
//! This is a local launch configuration, not a Native Messaging protocol version.
use std::fs::{self, File};
use std::io::{Read, Seek};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::endpoint::{effective_user_id, is_owner_only};
use crate::launcher::spawn_configured;

pub const HOST_NAME: &str = "motrix-appimage-native-host";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppImageConfig {
    schema_version: u32,
    install_id: String,
    consent: String,
    enabled: bool,
    app_image_path: PathBuf,
    pub user_data_dir: PathBuf,
    pub bridge_data_dir: PathBuf,
    arch: String,
    host_sha256: String,
    app_image_sha256: String,
    manifests: Vec<ManifestReceipt>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestReceipt {
    path: PathBuf,
    sha256: String,
}

fn valid_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|s| !s.chars().any(char::is_control))
        && !path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn safe_parents(path: &Path) -> Option<()> {
    for parent in path.ancestors().skip(1) {
        let stat = fs::symlink_metadata(parent).ok()?;
        let sticky_root = stat.uid() == 0 && stat.mode() & 0o1000 != 0;
        if !stat.is_dir()
            || (stat.uid() != 0 && stat.uid() != effective_user_id())
            || (stat.mode() & 0o022 != 0 && !sticky_root)
        {
            return None;
        }
    }
    Some(())
}

fn hash_executable(file: &mut File, arch: &str) -> Option<String> {
    let before = file.metadata().ok()?;
    if !before.is_file()
        || before.uid() != effective_user_id()
        || before.mode() & 0o022 != 0
        || before.mode() & 0o111 == 0
    {
        return None;
    }
    let mut header = [0_u8; 20];
    file.read_exact(&mut header).ok()?;
    let machine = match arch {
        "x64" => 62,
        "arm64" => 183,
        _ => return None,
    };
    if &header[..4] != b"\x7fELF"
        || header[4] != 2
        || header[5] != 1
        || u16::from_le_bytes([header[18], header[19]]) != machine
    {
        return None;
    }
    file.rewind().ok()?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut total = 0_u64;
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > 2_u64.pow(31) || Instant::now() > deadline {
            return None;
        }
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().ok()?;
    if before.size() != after.size()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.mtime() != after.mtime()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return None;
    }
    Some(format!("{:x}", hash.finalize()))
}

impl AppImageConfig {
    fn read(executable: &Path) -> Option<Self> {
        safe_parents(executable)?;
        let config_path = executable.parent()?.join("appimage.json");
        if !fs::symlink_metadata(&config_path).ok()?.is_file() {
            return None;
        }
        let file = File::open(config_path).ok()?;
        if !is_owner_only(&file) || file.metadata().ok()?.len() > 16 * 1024 {
            return None;
        }
        let config: Self = serde_json::from_reader(file.take(16 * 1024 + 1)).ok()?;
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let valid_id = config.install_id.len() == 36
            && config.install_id.bytes().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit()
                }
            });
        if config.schema_version != 1
            || !valid_id
            || config.consent != "accepted"
            || !config.enabled
            || config.arch != architecture
            || !valid_path(&config.app_image_path)
            || !valid_path(&config.user_data_dir)
            || !valid_path(&config.bridge_data_dir)
            || !valid_hash(&config.host_sha256)
            || !valid_hash(&config.app_image_sha256)
            || config.manifests.len() > 4
            || config
                .manifests
                .iter()
                .any(|m| !valid_path(&m.path) || !valid_hash(&m.sha256))
        {
            return None;
        }
        // Hash the executing inode, including during an atomic replacement.
        // Opening the executable's old pathname could read the new version.
        let mut running = File::open("/proc/self/exe").ok()?;
        if hash_executable(&mut running, &config.arch)? != config.host_sha256 {
            return None;
        }
        Some(config)
    }

    pub fn launch(&self) -> bool {
        self.launch_checked().unwrap_or(false)
    }

    fn launch_checked(&self) -> Option<bool> {
        safe_parents(&self.app_image_path)?;
        if fs::canonicalize(&self.app_image_path).ok()? != self.app_image_path {
            return None;
        }
        let mut file = File::open(&self.app_image_path).ok()?;
        if hash_executable(&mut file, &self.arch)? != self.app_image_sha256 {
            return None;
        }
        let opened = file.metadata().ok()?;
        let named = fs::symlink_metadata(&self.app_image_path).ok()?;
        if !named.is_file() || opened.dev() != named.dev() || opened.ino() != named.ino() {
            return None;
        }
        let mut command = Command::new(&self.app_image_path);
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy();
            if key.starts_with("APPIMAGE")
                || key == "APPDIR"
                || key == "ARGV0"
                || key.starts_with("LD_")
                || key.starts_with("NODE_")
                || key.starts_with("ELECTRON_")
                || key == "SNAP"
                || key == "FLATPAK_ID"
            {
                command.env_remove(name);
            }
        }
        command
            .env("MOTRIX_USER_DATA", &self.user_data_dir)
            .env("MOTRIX_BRIDGE_DATA_DIR", &self.bridge_data_dir);
        Some(spawn_configured(command))
    }
}

/// `Err` is a broken AppImage installation, never permission to use system paths.
pub fn load_current() -> Result<Option<AppImageConfig>, &'static str> {
    let executable = std::env::current_exe().map_err(|_| "executable unavailable")?;
    let name = executable
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.strip_suffix(" (deleted)").unwrap_or(name) != HOST_NAME {
        return Ok(None);
    }
    AppImageConfig::read(&executable)
        .map(Some)
        .ok_or("AppImage configuration invalid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        directory: PathBuf,
        executable: PathBuf,
        config: serde_json::Value,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "motrix-appimage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            let executable = directory.join(HOST_NAME);
            let arch = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                _ => "x64",
            };
            let current = std::env::current_exe().unwrap();
            let sha = hash_executable(&mut File::open(&current).unwrap(), arch).unwrap();
            let config = serde_json::json!({
                "schemaVersion": 1, "installId": "ae55c69c-0480-4df4-a12b-38dc3a724c14",
                "consent": "accepted", "enabled": true, "appImagePath": current,
                "userDataDir": directory, "bridgeDataDir": directory.join("bridge"),
                "arch": arch, "hostSha256": sha, "appImageSha256": sha, "manifests": [],
            });
            Self {
                directory,
                executable,
                config,
            }
        }
        fn save(&self) {
            let path = self.directory.join("appimage.json");
            fs::write(&path, serde_json::to_vec(&self.config).unwrap()).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn loads_private_config_for_the_running_inode() {
        let fixture = Fixture::new();
        fixture.save();
        let config = AppImageConfig::read(&fixture.executable).unwrap();
        assert_eq!(config.bridge_data_dir, fixture.directory.join("bridge"));
    }

    #[test]
    fn rejects_disabled_unknown_or_mismatched_installations() {
        for (field, value) in [
            ("enabled", serde_json::json!(false)),
            ("consent", serde_json::json!("declined")),
            ("schemaVersion", serde_json::json!(2)),
            ("hostSha256", serde_json::json!("0".repeat(64))),
            ("appImagePath", serde_json::json!("relative/image")),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut fixture = Fixture::new();
            fixture.config[field] = value;
            fixture.save();
            assert!(
                AppImageConfig::read(&fixture.executable).is_none(),
                "{field}"
            );
        }
    }

    #[test]
    fn rejects_readable_config_and_symlink_config() {
        let fixture = Fixture::new();
        fixture.save();
        let path = fixture.directory.join("appimage.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(AppImageConfig::read(&fixture.executable).is_none());
        let other = fixture.directory.join("other.json");
        fs::rename(&path, &other).unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(AppImageConfig::read(&fixture.executable).is_none());
    }
}
