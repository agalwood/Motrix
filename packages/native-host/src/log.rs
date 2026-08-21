use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::resolve::ResolveResult;

pub const MAX_LOG_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default)]
pub struct NativeHostLogger {
    path: Option<PathBuf>,
}

impl NativeHostLogger {
    pub fn from_user_data(base: Option<&Path>) -> Self {
        let bridge_data = base.map(|path| path.join("bridge"));
        Self::from_bridge_data(bridge_data.as_deref())
    }

    pub fn from_bridge_data(bridge_data: Option<&Path>) -> Self {
        let Some(bridge_data) = bridge_data else {
            return Self::default();
        };
        if !bridge_data.join(".nh-debug").exists() {
            return Self::default();
        }

        let Some(base) = bridge_data.parent() else {
            return Self::default();
        };
        let path = base.join("logs").join("native-host.log");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if path
            .metadata()
            .is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES)
        {
            let _ = fs::write(&path, b"");
        }
        Self { path: Some(path) }
    }

    pub fn log(&self, message: &str) {
        let Some(path) = &self.path else {
            return;
        };
        let timestamp = humantime::format_rfc3339_seconds(SystemTime::now());
        let sanitized = message.replace(['\r', '\n'], " ");
        let line = format!("{timestamp} pid={} {sanitized}\n", std::process::id());
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    pub fn log_resolve_result(&self, result: &ResolveResult) {
        match result {
            ResolveResult::RequestPair {
                port, nm_ticket, ..
            } => {
                let ticket = if nm_ticket.is_some() {
                    "present"
                } else {
                    "absent"
                };
                self.log(&format!(
                    "resolve -> requestPair port={port} nonce=[redacted] ticket={ticket}"
                ));
            }
            ResolveResult::Error { error } => {
                self.log(&format!("resolve -> error={error:?}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{MAX_LOG_BYTES, NativeHostLogger};
    use crate::resolve::ResolveResult;

    fn temp_dir() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "motrix-native-host-log-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp directory");
        dir
    }

    #[test]
    fn logging_is_disabled_without_debug_sentinel() {
        let base = temp_dir();
        NativeHostLogger::from_user_data(Some(&base)).log("should not exist");
        assert!(!base.join("logs").join("native-host.log").exists());
    }

    #[test]
    fn enabled_logger_redacts_nonce_and_sanitizes_lines() {
        let base = temp_dir();
        fs::create_dir_all(base.join("bridge")).expect("create bridge directory");
        fs::write(base.join("bridge").join(".nh-debug"), b"").expect("write sentinel");

        let logger = NativeHostLogger::from_user_data(Some(&base));
        logger.log("spawned\nsecond line");
        logger.log_resolve_result(&ResolveResult::request_pair(
            55_809,
            "secret-nonce-value".into(),
        ));

        let text =
            fs::read_to_string(base.join("logs").join("native-host.log")).expect("read debug log");
        assert!(text.contains("spawned second line"));
        assert!(text.contains("nonce=[redacted]"));
        assert!(text.contains("ticket=absent"));
        assert!(!text.contains("secret-nonce-value"));
    }

    #[test]
    fn enabled_logger_reports_ticket_present_without_leaking_ticket_material() {
        use crate::ticket::NmTicket;

        let base = temp_dir();
        fs::create_dir_all(base.join("bridge")).expect("create bridge directory");
        fs::write(base.join("bridge").join(".nh-debug"), b"").expect("write sentinel");

        let ticket = NmTicket {
            v: 1,
            purpose: "mbp1-attestation",
            protocol_version: 1,
            server_generation: "gen-1".into(),
            browser: "chromium".into(),
            caller_id: "ibpkjhgpbidfmbmomagmldcdlpbmchgi".into(),
            exp: 1_755_600_000,
            binding_pub: "SECRETPUB".into(),
            mac: "SECRETMAC".into(),
        };

        let logger = NativeHostLogger::from_user_data(Some(&base));
        logger.log_resolve_result(&ResolveResult::request_pair_with_ticket(
            55_809,
            "secret-nonce-value".into(),
            ticket,
        ));

        let text =
            fs::read_to_string(base.join("logs").join("native-host.log")).expect("read debug log");
        assert!(text.contains("ticket=present"));
        assert!(!text.contains("secret-nonce-value"));
        assert!(!text.contains("SECRETMAC"));
        assert!(!text.contains("SECRETPUB"));
    }

    #[test]
    fn oversized_log_is_truncated_on_initialization() {
        let base = temp_dir();
        fs::create_dir_all(base.join("bridge")).expect("create bridge directory");
        fs::create_dir_all(base.join("logs")).expect("create logs directory");
        fs::write(base.join("bridge").join(".nh-debug"), b"").expect("write sentinel");
        fs::write(
            base.join("logs").join("native-host.log"),
            vec![b'x'; MAX_LOG_BYTES as usize + 1],
        )
        .expect("write oversized log");

        let logger = NativeHostLogger::from_user_data(Some(&base));
        logger.log("after truncate");
        let log_path = base.join("logs").join("native-host.log");
        assert!(fs::metadata(&log_path).expect("log metadata").len() < MAX_LOG_BYTES);
        assert!(
            fs::read_to_string(log_path)
                .expect("read truncated log")
                .contains("after truncate")
        );
    }

    #[test]
    fn bridge_override_controls_debug_sentinel_and_log_root() {
        let base = temp_dir().join("flatpak-config").join("motrix");
        let bridge_data = base.join("bridge");
        fs::create_dir_all(&bridge_data).expect("create bridge directory");
        fs::write(bridge_data.join(".nh-debug"), b"").expect("write sentinel");

        NativeHostLogger::from_bridge_data(Some(&bridge_data)).log("flatpak bridge");

        assert!(
            fs::read_to_string(base.join("logs").join("native-host.log"))
                .expect("read override log")
                .contains("flatpak bridge")
        );
    }
}
