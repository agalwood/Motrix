#![cfg(target_os = "linux")]

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use motrix_native_host::broker_protocol::{
    BrokerOperation, BrokerRequest, decode_broker_response, encode_broker_message,
};
use motrix_native_host::resolve::{ResolveError, ResolveResult};
use serde_json::json;

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
        let path = std::env::temp_dir().join(format!(
            "motrix-flatpak-broker-{label}-{}-{id}",
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

fn run_broker(config_home: &std::path::Path, flatpak_id: &str, wire: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_motrix-native-host-broker"))
        .env("FLATPAK_ID", flatpak_id)
        .env("XDG_CONFIG_HOME", config_home)
        .env("HOME", config_home.join("host-home-must-not-be-used"))
        .env_remove("MOTRIX_BRIDGE_DATA_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Flatpak broker");
    // The broker validates FLATPAK_ID and XDG_CONFIG_HOME before reading any
    // stdin, so on a rejected environment it may exit without ever consuming
    // input; losing that race surfaces here as EPIPE. That early exit is part
    // of the contract under test — every case still asserts on exit status and
    // stdout — so only a BrokenPipe write failure is tolerated.
    if let Err(error) = child.stdin.take().expect("broker stdin").write_all(wire) {
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe,
            "write broker input: {error}"
        );
    }
    child.wait_with_output().expect("wait for broker")
}

fn probe_request() -> Vec<u8> {
    encode_broker_message(&BrokerRequest {
        operation: BrokerOperation::Probe,
    })
    .expect("encode probe")
}

fn read_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set read timeout");
    let mut request = Vec::new();
    let mut buffer = [0_u8; 256];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).expect("read request");
        assert_ne!(read, 0, "broker closed before request headers");
        request.extend_from_slice(&buffer[..read]);
    }
    request
}

/// The broker's `probe_bridge` (Task B6) makes a liveness probe before the
/// nonce fetch, exactly like the direct host: `GET /discovery` first, then a
/// `POST /nonce` (which must carry `X-Motrix-Bridge: 1`). Answers both, on
/// two separate connections, since `probe.rs` opens a fresh one per request.
fn serve_bridge() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake bridge");
    let port = listener.local_addr().expect("fake bridge address").port();
    let handle = thread::spawn(move || {
        let (mut discovery_stream, _) = listener.accept().expect("accept discovery probe");
        let discovery_request = read_request(&mut discovery_stream);
        assert!(
            discovery_request.starts_with(b"GET /discovery HTTP/1.1\r\n"),
            "expected a liveness probe before the nonce fetch"
        );
        let discovery_body =
            r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"i","appVersion":"2.0.0"}"#;
        write!(
            discovery_stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{discovery_body}",
            discovery_body.len()
        )
        .expect("write discovery response");

        let (mut nonce_stream, _) = listener.accept().expect("accept broker probe");
        let request = read_request(&mut nonce_stream);
        assert!(request.starts_with(b"POST /nonce HTTP/1.1\r\n"));
        let bridge_header = b"\r\nX-Motrix-Bridge: 1\r\n";
        assert!(
            request
                .windows(bridge_header.len())
                .any(|window| window == bridge_header),
            "nonce fetch is missing the X-Motrix-Bridge header"
        );
        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        write!(
            nonce_stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("write nonce response");
    });
    (port, handle)
}

#[test]
fn broker_probes_only_the_flatpak_xdg_bridge_and_returns_one_exact_frame() {
    let temp = TempDir::new("pair");
    let config_home = temp.path.join("config");
    let bridge = config_home.join("motrix/bridge");
    fs::create_dir_all(&bridge).expect("create bridge directory");
    let (port, server) = serve_bridge();
    fs::write(
        bridge.join("endpoint.json"),
        format!(r#"{{"port":{port},"pid":1,"writtenAt":0}}"#),
    )
    .expect("write endpoint");

    let output = run_broker(&config_home, "app.motrix.native", &probe_request());
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_broker_response(&output.stdout).expect("decode exact broker response"),
        ResolveResult::request_pair(port, NONCE.into())
    );
    server.join().expect("bridge thread");
}

#[test]
fn broker_returns_not_running_without_launching() {
    let temp = TempDir::new("not-running");
    let config_home = temp.path.join("config");
    let output = run_broker(&config_home, "app.motrix.native", &probe_request());
    assert!(output.status.success());
    assert_eq!(
        decode_broker_response(&output.stdout).expect("decode broker response"),
        ResolveResult::Error {
            error: ResolveError::NotRunning
        }
    );
}

#[test]
fn broker_rejects_wrong_identity_unknown_fields_and_trailing_bytes_without_stdout() {
    let temp = TempDir::new("invalid");
    let config_home = temp.path.join("config");

    let wrong_id = run_broker(&config_home, "org.example.Other", &probe_request());
    assert!(!wrong_id.status.success());
    assert!(wrong_id.stdout.is_empty());

    let unknown = encode_broker_message(&json!({
        "operation": "probe",
        "allowLaunch": true,
    }))
    .expect("encode unknown field");
    let unknown = run_broker(&config_home, "app.motrix.native", &unknown);
    assert!(!unknown.status.success());
    assert!(unknown.stdout.is_empty());

    let mut trailing = probe_request();
    trailing.push(b'x');
    let trailing = run_broker(&config_home, "app.motrix.native", &trailing);
    assert!(!trailing.status.success());
    assert!(trailing.stdout.is_empty());
}
