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

#[cfg(unix)]
fn set_endpoint_owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .expect("chmod endpoint fixture to 0600");
}

#[cfg(windows)]
fn set_endpoint_owner_only(path: &Path) {
    let identity = Command::new("whoami").output().expect("run whoami");
    assert!(identity.status.success(), "whoami failed");
    let user = String::from_utf8(identity.stdout)
        .expect("whoami emits UTF-8")
        .trim()
        .to_owned();

    for args in [
        vec!["/setowner", user.as_str()],
        vec!["/inheritance:r"],
        vec!["/grant:r", &format!("{user}:F")],
    ] {
        let status = Command::new("icacls")
            .arg(path)
            .args(&args)
            .status()
            .expect("run icacls");
        assert!(status.success(), "icacls {args:?} failed");
    }
}

fn run_host(home: &Path, app_data: &Path, wire: &[u8]) -> Output {
    run_host_with_options(home, app_data, wire, None, &[])
}

fn run_host_with_bridge_override(
    home: &Path,
    app_data: &Path,
    wire: &[u8],
    bridge_data_dir: Option<&Path>,
) -> Output {
    run_host_with_options(home, app_data, wire, bridge_data_dir, &[])
}

/// Runs the host with extra post-argv0 arguments, mimicking the browser
/// caller identity Chromium/Firefox pass over Native Messaging (§9.1).
fn run_host_with_argv(home: &Path, app_data: &Path, wire: &[u8], argv: &[&str]) -> Output {
    run_host_with_options(home, app_data, wire, None, argv)
}

fn run_host_with_options(
    home: &Path,
    app_data: &Path,
    wire: &[u8],
    bridge_data_dir: Option<&Path>,
    argv: &[&str],
) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_motrix-native-host"));
    command
        .args(argv)
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

/// Reads one HTTP request's headers off `stream` and returns the raw bytes
/// read so far as text (the caller only inspects the request line/headers,
/// never a body, matching every request this fake bridge answers).
fn read_request_head(stream: &mut std::net::TcpStream) -> String {
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
    String::from_utf8(request).expect("request is ASCII")
}

/// A fake bridge that answers up to `requests` sequential connections: a
/// `GET /discovery` liveness probe gets a 200 JSON discovery body, and a
/// `POST /nonce` (which must carry `X-Motrix-Bridge: 1`) gets the chunked
/// nonce body. Returns every request's text, in arrival order, so callers
/// can assert both the liveness probe and the nonce fetch (Task B6/B8).
fn serve_bridge(requests: usize) -> (u16, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake bridge");
    let port = listener.local_addr().expect("fake bridge address").port();
    let handle = thread::spawn(move || {
        let mut captured = Vec::with_capacity(requests);
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().expect("accept fake bridge connection");
            let request = read_request_head(&mut stream);

            if request.starts_with("GET /discovery HTTP/1.1\r\n") {
                let discovery_body = r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"i","appVersion":"2.0.0"}"#;
                let discovery_response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{discovery_body}",
                    discovery_body.len()
                );
                stream
                    .write_all(discovery_response.as_bytes())
                    .expect("write discovery response");
            } else {
                assert!(
                    request.starts_with("POST /nonce HTTP/1.1\r\n"),
                    "expected a discovery probe or a nonce fetch, got: {request}"
                );
                assert!(
                    request.contains("\r\nX-Motrix-Bridge: 1\r\n"),
                    "nonce fetch is missing the X-Motrix-Bridge header: {request}"
                );
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
            }
            captured.push(request);
        }
        captured
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

    let (port, server) = serve_bridge(2);
    let endpoint_path = bridge_dir.join("endpoint.json");
    fs::write(
        &endpoint_path,
        format!(r#"{{"port":{port},"pid":1,"writtenAt":0,"localToken":"endpoint-secret"}}"#),
    )
    .expect("write endpoint");
    // Mirror the shell's real 0600 write (spec §9.1) so the host actually
    // reads `localToken` here rather than dropping it via a lax-permission
    // fallback — the point of this test is that a read token still never
    // reaches the log, not that it goes unread.
    set_endpoint_owner_only(&endpoint_path);

    let output = run_host(
        &temp.path,
        &app_data,
        &encode(&json!({ "action": "start", "allowLaunch": false })),
    );
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        decode_only_frame(&output.stdout),
        json!({ "action": "requestPair", "protocolVersion": 1, "port": port, "nonce": NONCE })
    );

    let requests = server.join().expect("fake bridge thread");
    assert!(requests[0].starts_with("GET /discovery HTTP/1.1\r\n"));
    assert!(requests[1].starts_with("POST /nonce HTTP/1.1\r\n"));
    assert!(requests[1].contains("\r\nX-Motrix-Bridge: 1\r\n"));
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

    let (port, server) = serve_bridge(2);
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
        json!({ "action": "requestPair", "protocolVersion": 1, "port": port, "nonce": NONCE })
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

// binding pub = 32 bytes of 0x07, base64url no-pad (spec §9.1/§9.2).
const BOOTSTRAP_BINDING_PUB: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const BOOTSTRAP_CALLER_ARGV: &str = "chrome-extension://ibpkjhgpbidfmbmomagmldcdlpbmchgi/";

fn bootstrap_wire(allow_launch: bool) -> Vec<u8> {
    encode(&json!({
        "action": "bootstrap",
        "protocolVersion": 1,
        "bindingPub": BOOTSTRAP_BINDING_PUB,
        "allowLaunch": allow_launch,
    }))
}

#[test]
fn bootstrap_request_returns_ticketed_pair_frame_and_never_leaks_secrets() {
    let temp = TempDir::new("bootstrap");
    let app_data = temp.path.join("Roaming");
    let user_data = user_data_for(&temp.path, &app_data);
    let bridge_dir = user_data.join("bridge");
    fs::create_dir_all(&bridge_dir).expect("create bridge directory");
    fs::write(bridge_dir.join(".nh-debug"), b"").expect("enable debug log");

    let (port, server) = serve_bridge(2); // /discovery then POST /nonce
    let endpoint_path = bridge_dir.join("endpoint.json");
    fs::write(
        &endpoint_path,
        format!(
            r#"{{"port":{port},"pid":1,"writtenAt":0,"localToken":"endpoint-secret","generation":"gen-1"}}"#
        ),
    )
    .expect("write endpoint");
    set_endpoint_owner_only(&endpoint_path);

    let output = run_host_with_argv(
        &temp.path,
        &app_data,
        &bootstrap_wire(false),
        &[BOOTSTRAP_CALLER_ARGV],
    );
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let frame = decode_only_frame(&output.stdout);
    assert_eq!(frame["action"], "requestPair");
    assert_eq!(frame["protocolVersion"], 1);
    assert_eq!(frame["port"], u64::from(port));
    let ticket = &frame["nmTicket"];
    assert_eq!(ticket["v"], 1);
    assert_eq!(ticket["purpose"], "mbp1-attestation");
    assert_eq!(ticket["callerId"], "ibpkjhgpbidfmbmomagmldcdlpbmchgi");
    assert_eq!(ticket["browser"], "chromium");
    assert_eq!(ticket["bindingPub"], BOOTSTRAP_BINDING_PUB);
    let exp = ticket["exp"].as_u64().expect("exp");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    assert!(exp > now && exp <= now + 61, "exp must be now + 60s");

    let requests = server.join().expect("fake bridge");
    assert!(requests[0].starts_with("GET /discovery HTTP/1.1\r\n"));
    assert!(requests[1].starts_with("POST /nonce HTTP/1.1\r\n"));
    assert!(requests[1].contains("\r\nX-Motrix-Bridge: 1\r\n"));

    let log = fs::read_to_string(user_data.join("logs").join("native-host.log")).expect("log");
    assert!(log.contains("ticket=present"));
    assert!(!log.contains("endpoint-secret"));
    assert!(!log.contains(ticket["mac"].as_str().expect("mac")));
}

#[cfg(unix)]
#[test]
fn bootstrap_request_degrades_to_ticketless_when_endpoint_file_is_lax() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("bootstrap-lax-endpoint");
    let app_data = temp.path.join("Roaming");
    let user_data = user_data_for(&temp.path, &app_data);
    let bridge_dir = user_data.join("bridge");
    fs::create_dir_all(&bridge_dir).expect("create bridge directory");

    let (port, server) = serve_bridge(2);
    let endpoint_path = bridge_dir.join("endpoint.json");
    fs::write(
        &endpoint_path,
        format!(
            r#"{{"port":{port},"pid":1,"writtenAt":0,"localToken":"endpoint-secret","generation":"gen-1"}}"#
        ),
    )
    .expect("write endpoint");
    // Group/world-readable: the 0600 owner-only check fails, so the host
    // must drop `localToken`/`generation` and reply ticketless rather than
    // trusting an unverified credential (§9.1's attestation root).
    fs::set_permissions(&endpoint_path, fs::Permissions::from_mode(0o644))
        .expect("chmod endpoint fixture to 0644");

    let output = run_host_with_argv(
        &temp.path,
        &app_data,
        &bootstrap_wire(false),
        &[BOOTSTRAP_CALLER_ARGV],
    );
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let frame = decode_only_frame(&output.stdout);
    assert_eq!(frame["action"], "requestPair");
    assert_eq!(frame["port"], u64::from(port));
    assert!(
        frame.get("nmTicket").is_none(),
        "a lax-permission endpoint file must degrade to ticketless, got: {frame}"
    );

    server.join().expect("fake bridge");
}

#[test]
fn bootstrap_request_degrades_to_ticketless_without_caller_identity() {
    let temp = TempDir::new("bootstrap-no-caller");
    let app_data = temp.path.join("Roaming");
    let user_data = user_data_for(&temp.path, &app_data);
    let bridge_dir = user_data.join("bridge");
    fs::create_dir_all(&bridge_dir).expect("create bridge directory");

    let (port, server) = serve_bridge(2);
    let endpoint_path = bridge_dir.join("endpoint.json");
    fs::write(
        &endpoint_path,
        format!(
            r#"{{"port":{port},"pid":1,"writtenAt":0,"localToken":"endpoint-secret","generation":"gen-1"}}"#
        ),
    )
    .expect("write endpoint");
    set_endpoint_owner_only(&endpoint_path);

    // No argv at all: the host cannot extract a caller identity, so it must
    // never fabricate one — it degrades to ticketless instead of minting.
    let output = run_host_with_argv(&temp.path, &app_data, &bootstrap_wire(false), &[]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let frame = decode_only_frame(&output.stdout);
    assert_eq!(frame["action"], "requestPair");
    assert_eq!(frame["port"], u64::from(port));
    assert!(
        frame.get("nmTicket").is_none(),
        "a missing caller identity must degrade to ticketless, got: {frame}"
    );

    server.join().expect("fake bridge");
}
