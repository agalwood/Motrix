use std::fmt;
use std::path::Path;

mod allowlist;
mod command;
mod installation;
mod manifest;
mod paths;
mod runtime;
mod secure_fs;
#[cfg(test)]
mod tests;

pub use crate::MOTRIX_FLATPAK_ID;
pub use allowlist::{NativeMessagingAllowlist, embedded_allowlist};
pub use command::{
    BrowserCaller, CompanionCommand, parse_companion_command, validate_browser_caller,
};
pub use installation::{
    CompanionConfig, CompanionStatus, companion_status, install_companion, load_companion_config,
    uninstall_companion,
};
pub use paths::{
    CompanionPaths, ManifestFamily, ManifestTarget, current_companion_paths,
    resolve_companion_paths,
};
pub use runtime::{FlatpakProcessRuntime, FlatpakRuntime, resolve_flatpak_request};

pub const FLATPAK_BROKER_COMMAND: &str = "motrix-native-host-broker";
pub const FLATPAK_COMPANION_BINARY: &str = "motrix-flatpak-native-host";
pub const NATIVE_MESSAGING_HOST_NAME: &str = "app.motrix.bridge";
pub const DEFAULT_FLATPAK_BIN: &str = "/usr/bin/flatpak";

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

#[cfg(test)]
use allowlist::{is_chromium_extension_id, is_firefox_extension_id};
#[cfg(test)]
use paths::absolute_root;
