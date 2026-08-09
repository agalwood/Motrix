use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use motrix_native_host::protocol::{MAX_MESSAGE_BYTES, read_message, write_message};
use motrix_native_host::user_data::{current_platform, resolve_native_host_user_data_dir};
use serde_json::{Value, json};

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
            "motrix-native-host-{label}-{}-{id}",
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

fn user_data_for(home: &Path, app_data: &Path) -> PathBuf {
    resolve_native_host_user_data_dir(current_platform(), home, Some(app_data.as_os_str()))
}

fn run_host(home: &Path, app_data: &Path, wire: &[u8]) -> Output {
    run_host_with_bridge_override(home, app_data, wire, None)
}

fn run_host_with_bridge_override(
    home: &Path,
    app_data: &Path,
    wire: &[u8],
    bridge_data_dir: Option<&Path>,
) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_motrix-native-host"));
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", app_data)
        .env("LOCALAPPDATA", home.join("AppData").join("Local"))
        .env_remove("MOTRIX_BRIDGE_DATA_DIR")
        .env_remove("FLATPAK_ID")
        .env_remove("SNAP")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(bridge_data_dir) = bridge_data_dir {
        command.env("MOTRIX_BRIDGE_DATA_DIR", bridge_data_dir);
    }
    let mut child = command.spawn().expect("spawn native host");
    child
        .stdin
        .take()
        .expect("native host stdin")
        .write_all(wire)
        .expect("write native messaging input");
    child.wait_with_output().expect("wait for native host")
}

fn encode(value: &Value) -> Vec<u8> {
    let mut wire = Vec::new();
    write_message(&mut wire, value).expect("encode native message");
    wire
}

fn decode_only_frame(stdout: &[u8]) -> Value {
    let mut cursor = Cursor::new(stdout);
    let value = read_message(&mut cursor).expect("decode native host response");
    assert_eq!(
        cursor.position() as usize,
        stdout.len(),
        "stdout contained bytes outside the protocol frame"
    );
    value
}

fn serve_chunked_nonce() -> (u16, JoinHandle<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake bridge");
    let port = listener.local_addr().expect("fake bridge address").port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept native host probe");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set fake bridge timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 256];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).expect("read native host request");
            assert_ne!(read, 0, "native host closed before request headers");
            request.extend_from_slice(&buffer[..read]);
        }

        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        let split = 11;
        let first = &body[..split];
        let second = &body[split..];
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n{first}\r\n{:X}\r\n{second}\r\n0\r\n\r\n",
            first.len(),
            second.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write chunked nonce response");
        String::from_utf8(request).expect("request is ASCII")
    });
    (port, handle)
}

#[test]
fn subprocess_returns_exact_pair_frame_and_never_logs_nonce_or_local_token() {
    let temp = TempDir::new("success");
    let app_data = temp.path.join("Roaming");
    let user_data = user_data_for(&temp.path, &app_data);
    let bridge_dir = user_data.join("bridge");
    fs::create_dir_all(&bridge_dir).expect("create bridge directory");
    fs::write(bridge_dir.join(".nh-debug"), b"").expect("enable debug log");

    let (port, server) = serve_chunked_nonce();
    fs::write(
        bridge_dir.join("endpoint.json"),
        format!(r#"{{"port":{port},"pid":1,"writtenAt":0,"localToken":"endpoint-secret"}}"#),
    )
    .expect("write endpoint");

    let output = run_host(
        &temp.path,
        &app_data,
        &encode(&json!({ "action": "start", "allowLaunch": false })),
    );
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_only_frame(&output.stdout),
        json!({ "action": "requestPair", "port": port, "nonce": NONCE })
    );

    let request = server.join().expect("fake bridge thread");
    assert!(request.starts_with("GET /nonce HTTP/1.1\r\n"));
    let log = fs::read_to_string(user_data.join("logs").join("native-host.log"))
        .expect("read native host debug log");
    assert!(log.contains("nonce=[redacted]"));
    assert!(!log.contains(NONCE));
    assert!(!log.contains("endpoint-secret"));
}

#[test]
fn subprocess_reads_endpoint_from_the_shared_bridge_override() {
    let temp = TempDir::new("shared-bridge");
    let app_data = temp.path.join("Roaming");
    let bridge_dir = temp.path.join("snap").join("common").join("bridge");
    fs::create_dir_all(&bridge_dir).expect("create shared bridge directory");

    let (port, server) = serve_chunked_nonce();
    fs::write(
        bridge_dir.join("endpoint.json"),
        format!(r#"{{"port":{port},"pid":1,"writtenAt":0}}"#),
    )
    .expect("write endpoint");

    let output = run_host_with_bridge_override(
        &temp.path,
        &app_data,
        &encode(&json!({ "allowLaunch": false })),
        Some(&bridge_dir),
    );
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_only_frame(&output.stdout),
        json!({ "action": "requestPair", "port": port, "nonce": NONCE })
    );
    server.join().expect("fake bridge thread");
}

#[test]
fn subprocess_preserves_array_input_and_not_running_error() {
    let temp = TempDir::new("array");
    let app_data = temp.path.join("Roaming");
    let output = run_host(&temp.path, &app_data, &encode(&json!([])));
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_only_frame(&output.stdout),
        json!({ "error": "motrix-not-running" })
    );
}

#[test]
fn subprocess_bounds_and_ignores_trailing_native_messaging_input() {
    let temp = TempDir::new("trailing");
    let app_data = temp.path.join("Roaming");
    let mut wire = encode(&json!({ "allowLaunch": false }));
    wire.extend(vec![b'x'; MAX_MESSAGE_BYTES + 1]);

    let output = run_host(&temp.path, &app_data, &wire);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_only_frame(&output.stdout),
        json!({ "error": "motrix-not-running" })
    );
}

#[test]
fn subprocess_rejects_primitive_malformed_truncated_and_oversized_input() {
    let temp = TempDir::new("invalid");
    let app_data = temp.path.join("Roaming");

    let primitive = run_host(&temp.path, &app_data, &encode(&json!("start")));
    assert!(!primitive.status.success());
    assert!(primitive.stdout.is_empty());

    let mut malformed = 1_u32.to_le_bytes().to_vec();
    malformed.push(b'{');
    let malformed = run_host(&temp.path, &app_data, &malformed);
    assert!(!malformed.status.success());
    assert!(malformed.stdout.is_empty());

    let truncated = run_host(&temp.path, &app_data, &[1, 0, 0]);
    assert!(!truncated.status.success());
    assert!(truncated.stdout.is_empty());

    let oversized = run_host(
        &temp.path,
        &app_data,
        &((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes(),
    );
    assert!(!oversized.status.success());
    assert!(oversized.stdout.is_empty());
}
