use std::fs::File;
use std::io::{Read, Take};
use std::path::Path;

use serde::Deserialize;

pub const MAX_ENDPOINT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct EndpointFile {
    pub port: u16,
    #[serde(rename = "localToken", default)]
    pub local_token: Option<String>,
    #[serde(default)]
    pub generation: Option<String>,
}

#[cfg(unix)]
fn effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }

    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { geteuid() }
}

/// Spec §9.1: `endpoint.json`'s 0600 owner-only mode *is* the attestation
/// root. Reads metadata from the already-open handle, avoiding a TOCTOU
/// window between checking the file and reading its contents.
#[cfg(unix)]
fn is_owner_only(file: &File) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let Ok(metadata) = file.metadata() else {
        return false;
    };
    metadata.uid() == effective_user_id() && metadata.permissions().mode() & 0o077 == 0
}

/// On Windows, `%APPDATA%` ACLs are the documented boundary in place of a
/// Unix owner/mode check; `localToken`/`generation` pass through unchecked.
pub fn read_endpoint(file_path: &Path) -> Option<EndpointFile> {
    let file = File::open(file_path).ok()?;
    #[cfg(unix)]
    let owner_only = is_owner_only(&file);
    let mut limited: Take<File> = file.take((MAX_ENDPOINT_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_ENDPOINT_BYTES {
        return None;
    }
    let mut endpoint: EndpointFile = serde_json::from_slice(&bytes).ok()?;
    if endpoint.port == 0 {
        return None;
    }
    // Degrade, don't fail: a non-0600 file still reports its port so the
    // host can bootstrap, but cannot serve as the attestation root, so the
    // ticket-minting fields are dropped rather than trusted.
    #[cfg(unix)]
    if !owner_only {
        endpoint.local_token = None;
        endpoint.generation = None;
    }
    Some(endpoint)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{EndpointFile, MAX_ENDPOINT_BYTES, read_endpoint};

    fn temp_file(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "motrix-native-host-endpoint-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp directory");
        dir.join(name)
    }

    #[test]
    fn returns_none_for_missing_or_malformed_file() {
        let missing = temp_file("missing.json");
        assert_eq!(read_endpoint(&missing), None);

        let malformed = temp_file("malformed.json");
        fs::write(&malformed, b"{").expect("write malformed fixture");
        assert_eq!(read_endpoint(&malformed), None);
    }

    #[test]
    fn parses_local_token_and_generation_from_owner_only_file() {
        let path = temp_file("endpoint.json");
        fs::write(
            &path,
            br#"{"port":55809,"pid":1,"writtenAt":0,"localToken":"tok-abc","generation":"gen-1"}"#,
        )
        .expect("write endpoint fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 0600");
        }
        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token.as_deref(), Some("tok-abc"));
        assert_eq!(endpoint.generation.as_deref(), Some("gen-1"));
    }

    #[cfg(unix)]
    #[test]
    fn group_readable_file_keeps_port_but_drops_token_fields() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_file("endpoint-lax.json");
        fs::write(
            &path,
            br#"{"port":55809,"localToken":"tok-abc","generation":"gen-1"}"#,
        )
        .expect("write endpoint fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod 0644");
        let endpoint = read_endpoint(&path).expect("endpoint parses");
        assert_eq!(endpoint.port, 55_809);
        assert_eq!(endpoint.local_token, None);
        assert_eq!(endpoint.generation, None);
    }

    #[test]
    fn missing_token_fields_deserialize_as_none() {
        let path = temp_file("endpoint-min.json");
        fs::write(&path, br#"{"port":55809}"#).expect("write endpoint fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 0600");
        }
        assert_eq!(
            read_endpoint(&path),
            Some(EndpointFile {
                port: 55_809,
                local_token: None,
                generation: None
            })
        );
    }

    #[test]
    fn rejects_zero_negative_fractional_and_out_of_range_ports() {
        for (index, value) in ["0", "-1", "1.5", "65536", "\"80\""].iter().enumerate() {
            let path = temp_file(&format!("invalid-{index}.json"));
            fs::write(&path, format!(r#"{{"port":{value}}}"#))
                .expect("write invalid endpoint fixture");
            assert_eq!(read_endpoint(&path), None, "accepted port {value}");
        }
    }

    #[test]
    fn rejects_oversized_endpoint_file() {
        let path = temp_file("oversized.json");
        let mut file = File::create(&path).expect("create oversized fixture");
        file.write_all(&vec![b' '; MAX_ENDPOINT_BYTES + 1])
            .expect("write oversized fixture");
        assert_eq!(read_endpoint(&path), None);
    }
}
