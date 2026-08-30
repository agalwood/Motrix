#![cfg(target_os = "linux")]

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use motrix_native_host::broker_protocol::encode_broker_message;
use motrix_native_host::protocol::{read_message, write_message};
use motrix_native_host::resolve::{ResolveError, ResolveResult};
use serde_json::{Value, json};

const CHROMIUM_ID: &str = "ibpkjhgpbidfmbmomagmldcdlpbmchgi";

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
            "motrix-flatpak-host-{label}-{}-{id}",
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
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(path.parent().expect("executable parent")).expect("create parent");
    fs::write(path, contents).expect("write executable");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("make executable");
}

fn shell_octal(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("\\{byte:03o}")).collect()
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn command_with_home(program: &Path, temp: &TempDir) -> Command {
    let mut command = Command::new(program);
    command
        .env("HOME", temp.path.join("home"))
        .env("XDG_DATA_HOME", temp.path.join("data"))
        .env("XDG_CONFIG_HOME", temp.path.join("config"))
        .env_remove("FLATPAK_ID")
        .env_remove("MOTRIX_BRIDGE_DATA_DIR");
    command
}

fn install_companion(temp: &TempDir, flatpak: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_BIN_EXE_motrix-flatpak-native-host"));
    let output = command_with_home(source, temp)
        .arg("install")
        .arg("--flatpak-bin")
        .arg(flatpak)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run companion install");
    assert!(
        output.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    temp.path
        .join("data/motrix/native-messaging/motrix-flatpak-native-host")
}

fn install_companion_with_umask(temp: &TempDir, flatpak: &Path, umask: &str) -> PathBuf {
    let source = Path::new(env!("CARGO_BIN_EXE_motrix-flatpak-native-host"));
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("umask {umask}; exec \"$@\""))
        .arg("motrix-flatpak-install")
        .arg(source)
        .arg("install")
        .arg("--flatpak-bin")
        .arg(flatpak)
        .env("HOME", temp.path.join("home"))
        .env("XDG_DATA_HOME", temp.path.join("data"))
        .env("XDG_CONFIG_HOME", temp.path.join("config"))
        .env_remove("FLATPAK_ID")
        .env_remove("MOTRIX_BRIDGE_DATA_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run companion install through shell");
    assert!(
        output.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    temp.path
        .join("data/motrix/native-messaging/motrix-flatpak-native-host")
}

fn assert_mode(path: &Path, expected: u32) {
    use std::os::unix::fs::PermissionsExt;

    assert_eq!(
        fs::symlink_metadata(path)
            .unwrap_or_else(|_| panic!("metadata for {}", path.display()))
            .permissions()
            .mode()
            & 0o7777,
        expected,
        "unexpected mode for {}",
        path.display()
    );
}

fn browser_wire(allow_launch: bool) -> Vec<u8> {
    let mut wire = Vec::new();
    write_message(&mut wire, &json!({ "allowLaunch": allow_launch }))
        .expect("encode browser frame");
    wire
}

fn run_browser(installed: &Path, temp: &TempDir, origin: &str, wire: &[u8]) -> Output {
    let mut child = command_with_home(installed, temp)
        .arg(origin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn installed companion");
    let mut stdin = child.stdin.take().expect("companion stdin");
    if let Err(error) = stdin.write_all(wire) {
        drop(stdin);
        let output = child.wait_with_output().expect("wait for failed companion");
        panic!(
            "write browser frame: {error}; status: {}; stderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    drop(stdin);
    child.wait_with_output().expect("wait for companion")
}

fn decode_only_browser_frame(stdout: &[u8]) -> Value {
    let mut cursor = Cursor::new(stdout);
    let result = read_message(&mut cursor).expect("decode browser response");
    assert_eq!(
        cursor.position() as usize,
        stdout.len(),
        "companion stdout contained bytes outside the browser protocol frame"
    );
    result
}

#[test]
fn install_uses_private_modes_even_with_a_permissive_umask() {
    let temp = TempDir::new("umask");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&flatpak, b"#!/bin/sh\nexit 0\n");
    let installed = install_companion_with_umask(&temp, &flatpak, "000");

    for directory in [
        temp.path.join("home"),
        temp.path.join("home/.mozilla"),
        temp.path.join("home/.mozilla/native-messaging-hosts"),
        temp.path.join("data"),
        temp.path.join("data/motrix"),
        temp.path.join("data/motrix/native-messaging"),
        temp.path.join("config"),
        temp.path.join("config/motrix"),
        temp.path.join("config/motrix/native-messaging"),
        temp.path.join("config/google-chrome"),
        temp.path.join("config/google-chrome/NativeMessagingHosts"),
        temp.path.join("config/chromium"),
        temp.path.join("config/chromium/NativeMessagingHosts"),
        temp.path.join("config/microsoft-edge"),
        temp.path.join("config/microsoft-edge/NativeMessagingHosts"),
    ] {
        assert_mode(&directory, 0o700);
    }
    assert_mode(&installed, 0o700);
    assert_mode(
        &temp
            .path
            .join("config/motrix/native-messaging/flatpak-companion.json"),
        0o600,
    );
    for manifest in [
        temp.path
            .join("config/google-chrome/NativeMessagingHosts/app.motrix.bridge.json"),
        temp.path
            .join("config/chromium/NativeMessagingHosts/app.motrix.bridge.json"),
        temp.path
            .join("config/microsoft-edge/NativeMessagingHosts/app.motrix.bridge.json"),
        temp.path
            .join("home/.mozilla/native-messaging-hosts/app.motrix.bridge.json"),
    ] {
        assert_mode(&manifest, 0o600);
    }
}

#[test]
fn installed_companion_validates_caller_and_reencodes_broker_output() {
    let temp = TempDir::new("browser");
    let flatpak = temp.path.join("bin/flatpak");
    let invoked = temp.path.join("flatpak-invoked");
    let private_response = encode_broker_message(&ResolveResult::Error {
        error: ResolveError::NotRunning,
    })
    .expect("encode private response");
    let script = format!(
        "#!/bin/sh\n\
         [ \"$#\" -eq 3 ] || exit 91\n\
         [ \"$1\" = run ] || exit 92\n\
         [ \"$2\" = --command=motrix-native-host-broker ] || exit 93\n\
         [ \"$3\" = app.motrix.native ] || exit 94\n\
         printf x >> {}\n\
         cat >/dev/null\n\
         printf '{}'\n",
        shell_quote(&invoked),
        shell_octal(&private_response),
    );
    make_executable(&flatpak, script.as_bytes());
    let installed = install_companion(&temp, &flatpak);

    let output = run_browser(
        &installed,
        &temp,
        &format!("chrome-extension://{CHROMIUM_ID}/"),
        &browser_wire(false),
    );
    assert!(
        output.status.success(),
        "browser mode failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        decode_only_browser_frame(&output.stdout),
        json!({ "error": "motrix-not-running" })
    );
    assert_eq!(fs::read(&invoked).expect("invocation marker"), b"x");

    let rejected = run_browser(
        &installed,
        &temp,
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        &browser_wire(false),
    );
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    assert_eq!(
        fs::read(&invoked).expect("unchanged invocation marker"),
        b"x",
        "untrusted caller reached Flatpak"
    );

    let pair = ResolveResult::request_pair(55_809, "AbCdEfGhIjKlMnOpQrStUv".into());
    let mut polluted = encode_broker_message(&pair).expect("encode private pair");
    polluted.push(b'x');
    let polluted_script = format!(
        "#!/bin/sh\ncat >/dev/null\nprintf '{}'\n",
        shell_octal(&polluted)
    );
    make_executable(&flatpak, polluted_script.as_bytes());
    let output = run_browser(
        &installed,
        &temp,
        &format!("chrome-extension://{CHROMIUM_ID}"),
        &browser_wire(false),
    );
    assert!(output.status.success());
    assert_eq!(
        decode_only_browser_frame(&output.stdout),
        json!({ "error": "motrix-not-running" }),
        "polluted private stdout must not be forwarded"
    );
}
