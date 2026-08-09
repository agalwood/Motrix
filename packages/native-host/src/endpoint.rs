use std::fs::File;
use std::io::{Read, Take};
use std::path::Path;

use serde::Deserialize;

pub const MAX_ENDPOINT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub struct EndpointFile {
    pub port: u16,
}

pub fn read_endpoint(file_path: &Path) -> Option<EndpointFile> {
    let file = File::open(file_path).ok()?;
    let mut limited: Take<File> = file.take((MAX_ENDPOINT_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_ENDPOINT_BYTES {
        return None;
    }
    let endpoint: EndpointFile = serde_json::from_slice(&bytes).ok()?;
    (endpoint.port != 0).then_some(endpoint)
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
    fn parses_endpoint_and_ignores_local_token() {
        let path = temp_file("endpoint.json");
        fs::write(
            &path,
            br#"{"port":55809,"pid":"ignored","writtenAt":null,"localToken":"must-not-leak"}"#,
        )
        .expect("write endpoint fixture");
        assert_eq!(read_endpoint(&path), Some(EndpointFile { port: 55_809 }));
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
