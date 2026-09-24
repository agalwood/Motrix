use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::allowlist::NativeMessagingAllowlist;
use super::paths::{ManifestFamily, ManifestTarget};
use super::secure_fs::read_limited;
use super::{CompanionError, NATIVE_MESSAGING_HOST_NAME};
use crate::broker_protocol::MAX_BROKER_MESSAGE_BYTES;

const MANIFEST_DESCRIPTION: &str = "Motrix browser download bridge";

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

pub(super) fn manifest_bytes(
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

pub(super) fn manifest_points_to(path: &Path, binary: &Path) -> bool {
    let Ok(bytes) = read_limited(path, MAX_BROKER_MESSAGE_BYTES as u64) else {
        return false;
    };
    serde_json::from_slice::<ManifestOwnership>(&bytes).is_ok_and(|manifest| {
        manifest.name == NATIVE_MESSAGING_HOST_NAME && manifest.path == binary
    })
}
