use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::{
    BrowserCaller, CompanionError, FlatpakRuntime, ManifestFamily, companion_status,
    embedded_allowlist, install_companion, resolve_companion_paths, resolve_flatpak_request,
    uninstall_companion, validate_browser_caller,
};
#[cfg(unix)]
use super::{
    CompanionCommand, FlatpakProcessRuntime, load_companion_config, parse_companion_command,
};
use crate::broker_protocol::BrokerOperation;
#[cfg(unix)]
use crate::broker_protocol::encode_broker_message;
use crate::resolve::{ResolveError, ResolveResult};

const CHROMIUM_ID: &str = "lggbokfckofcgjndaboioakcmincinpo";
const EDGE_ID: &str = "efcflljngohddnmfmebiamigoikmdfbf";
const FIREFOX_ID: &str = "motrix-extension@motrix.app";
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
        let temporary_root =
            fs::canonicalize(std::env::temp_dir()).expect("canonical temporary directory");
        let path = temporary_root.join(format!(
            "motrix-flatpak-companion-{label}-{}-{id}",
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
    fs::create_dir_all(path.parent().expect("executable parent")).expect("create parent");
    fs::write(path, contents).expect("write executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("make executable");
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set mode");
}

#[cfg(unix)]
fn assert_private_directory_chain(root: &Path, destination: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let parent = destination.parent().expect("destination parent");
    let relative = parent.strip_prefix(root).expect("destination under root");
    let mut directory = root.to_path_buf();
    assert_eq!(
        fs::symlink_metadata(&directory)
            .expect("root metadata")
            .permissions()
            .mode()
            & 0o7777,
        0o700,
        "unexpected mode for {}",
        directory.display()
    );
    for component in relative.components() {
        directory.push(component.as_os_str());
        assert_eq!(
            fs::symlink_metadata(&directory)
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o7777,
            0o700,
            "unexpected mode for {}",
            directory.display()
        );
    }
}

fn explicit_paths(temp: &TempDir) -> super::CompanionPaths {
    let data = temp.path.join("data");
    let config = temp.path.join("config");
    resolve_companion_paths(
        &temp.path.join("home"),
        Some(data.as_os_str()),
        Some(config.as_os_str()),
    )
    .expect("resolve paths")
}

#[test]
fn resolves_xdg_and_documented_fallback_paths() {
    let temp = TempDir::new("paths");
    let home = temp.path.join("home");
    let fallback = resolve_companion_paths(&home, None, None).expect("fallback paths");
    assert_eq!(
        fallback.binary,
        home.join(".local/share/motrix/native-messaging/motrix-flatpak-native-host")
    );
    assert_eq!(
        fallback.config,
        home.join(".config/motrix/native-messaging/flatpak-companion.json")
    );
    assert_eq!(fallback.manifests.len(), 4);
    assert_eq!(
        fallback
            .manifests
            .iter()
            .filter(|target| target.family == ManifestFamily::Firefox)
            .map(|target| target.path.clone())
            .collect::<Vec<_>>(),
        vec![home.join(".mozilla/native-messaging-hosts/app.motrix.bridge.json")]
    );

    let explicit = explicit_paths(&temp);
    assert!(explicit.binary.starts_with(temp.path.join("data")));
    assert!(explicit.config.starts_with(temp.path.join("config")));
    assert_eq!(
        explicit
            .manifests
            .iter()
            .filter(|target| target.family == ManifestFamily::Chromium)
            .count(),
        3
    );

    let empty_xdg = resolve_companion_paths(&home, Some(OsStr::new("")), Some(OsStr::new("")))
        .expect("empty XDG values use fallbacks");
    assert_eq!(empty_xdg.binary, fallback.binary);
    assert_eq!(empty_xdg.config, fallback.config);
}

#[cfg(unix)]
#[test]
fn parses_only_the_documented_management_cli() {
    assert_eq!(
        parse_companion_command(&[]).expect("browser mode"),
        CompanionCommand::Browser
    );
    assert_eq!(
        parse_companion_command(&[OsString::from("install")]).expect("default install"),
        CompanionCommand::Install {
            flatpak_bin: PathBuf::from("/usr/bin/flatpak"),
            force: false,
        }
    );
    assert_eq!(
        parse_companion_command(&[
            OsString::from("install"),
            OsString::from("--force"),
            OsString::from("--flatpak-bin"),
            OsString::from("/opt/flatpak/bin/flatpak"),
        ])
        .expect("custom install"),
        CompanionCommand::Install {
            flatpak_bin: PathBuf::from("/opt/flatpak/bin/flatpak"),
            force: true,
        }
    );
    assert!(
        parse_companion_command(&[
            OsString::from("install"),
            OsString::from("--flatpak-bin"),
            OsString::from("relative/flatpak"),
        ])
        .is_err()
    );
    assert!(parse_companion_command(&[OsString::from("status"), OsString::from("extra")]).is_err());
}

#[test]
fn validates_exact_browser_caller_shapes_before_broker_access() {
    let temp = TempDir::new("caller");
    let paths = explicit_paths(&temp);
    let allowlist = embedded_allowlist().expect("embedded allowlist");

    for extension_id in [CHROMIUM_ID, EDGE_ID] {
        for origin in [
            format!("chrome-extension://{extension_id}"),
            format!("chrome-extension://{extension_id}/"),
        ] {
            assert_eq!(
                validate_browser_caller(&[origin.into()], &allowlist, &paths)
                    .expect("Chromium caller"),
                BrowserCaller::Chromium {
                    extension_id: extension_id.into()
                }
            );
        }
    }
    for invalid in [
        format!("chrome-extension://{CHROMIUM_ID}//"),
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".into(),
        format!("https://{CHROMIUM_ID}/"),
    ] {
        assert!(
            validate_browser_caller(&[invalid.into()], &allowlist, &paths).is_err(),
            "accepted invalid Chromium caller"
        );
    }

    let firefox_manifest = paths
        .manifests
        .iter()
        .find(|target| target.family == ManifestFamily::Firefox)
        .expect("Firefox target")
        .path
        .clone();
    assert_eq!(
        validate_browser_caller(
            &[
                firefox_manifest.clone().into_os_string(),
                OsString::from(FIREFOX_ID),
            ],
            &allowlist,
            &paths,
        )
        .expect("Firefox caller"),
        BrowserCaller::Firefox {
            extension_id: FIREFOX_ID.into()
        }
    );
    assert!(
        validate_browser_caller(
            &[
                firefox_manifest
                    .with_file_name("other.json")
                    .into_os_string(),
                OsString::from(FIREFOX_ID),
            ],
            &allowlist,
            &paths,
        )
        .is_err()
    );
    assert!(validate_browser_caller(&[], &allowlist, &paths).is_err());
    assert!(
        validate_browser_caller(
            &[
                OsString::from(format!("chrome-extension://{CHROMIUM_ID}/")),
                OsString::from("unexpected"),
                OsString::from("argument"),
            ],
            &allowlist,
            &paths,
        )
        .is_err()
    );
}

#[test]
fn install_writes_binary_config_and_all_browser_manifests() {
    let temp = TempDir::new("install");
    let paths = explicit_paths(&temp);
    let source = temp.path.join("source-companion");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&source, b"companion-binary");
    make_executable(&flatpak, b"flatpak-binary");
    let allowlist = embedded_allowlist().expect("embedded allowlist");

    install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");
    assert_eq!(
        fs::read(&paths.binary).expect("installed binary"),
        b"companion-binary"
    );
    let config: Value =
        serde_json::from_slice(&fs::read(&paths.config).expect("config")).expect("parse config");
    assert_eq!(config["schemaVersion"], 1);
    assert_eq!(
        config["flatpakBin"],
        fs::canonicalize(&flatpak)
            .expect("canonical flatpak")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        config["installedBinary"],
        paths.binary.to_string_lossy().as_ref()
    );

    for target in &paths.manifests {
        let manifest: Value = serde_json::from_slice(
            &fs::read(&target.path).unwrap_or_else(|_| panic!("read {}", target.path.display())),
        )
        .expect("parse manifest");
        assert_eq!(manifest["name"], "app.motrix.bridge");
        assert_eq!(manifest["path"], paths.binary.to_string_lossy().as_ref());
        assert_eq!(manifest["type"], "stdio");
        match target.family {
            ManifestFamily::Chromium => assert_eq!(
                manifest["allowed_origins"],
                json!([
                    format!("chrome-extension://{CHROMIUM_ID}/"),
                    format!("chrome-extension://{EDGE_ID}/")
                ])
            ),
            ManifestFamily::Firefox => {
                assert_eq!(manifest["allowed_extensions"], json!([FIREFOX_ID]))
            }
        }
    }
    assert!(companion_status(&paths, &allowlist).installed);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&paths.binary)
                .expect("binary metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&paths.config)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for target in &paths.manifests {
            assert_eq!(
                fs::metadata(&target.path)
                    .expect("manifest metadata")
                    .permissions()
                    .mode()
                    & 0o7777,
                0o600
            );
        }
        assert_private_directory_chain(&paths.data_root, &paths.binary);
        assert_private_directory_chain(&paths.config_root, &paths.config);
        for target in &paths.manifests {
            let root = match target.family {
                ManifestFamily::Chromium => &paths.config_root,
                ManifestFamily::Firefox => &paths.home_root,
            };
            assert_private_directory_chain(root, &target.path);
        }
    }
}

#[test]
#[cfg(unix)]
fn install_rejects_symlinked_or_other_writable_private_directories() {
    use std::os::unix::fs::symlink;

    let symlink_temp = TempDir::new("symlink-root");
    let symlink_paths = explicit_paths(&symlink_temp);
    let source = symlink_temp.path.join("source-companion");
    let flatpak = symlink_temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    let redirect = symlink_temp.path.join("redirect");
    fs::create_dir(&redirect).expect("create redirect");
    symlink(&redirect, &symlink_paths.data_root).expect("symlink data root");
    let allowlist = embedded_allowlist().expect("allowlist");
    assert!(install_companion(&symlink_paths, &source, &flatpak, &allowlist, true,).is_err());
    assert!(!redirect.join("motrix").exists());
    assert!(uninstall_companion(&symlink_paths).is_err());

    let writable_temp = TempDir::new("writable-parent");
    let writable_paths = explicit_paths(&writable_temp);
    let source = writable_temp.path.join("source-companion");
    let flatpak = writable_temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    fs::create_dir(&writable_paths.config_root).expect("create config root");
    let insecure = writable_paths.config_root.join("google-chrome");
    fs::create_dir(&insecure).expect("create insecure browser directory");
    set_mode(&insecure, 0o777);
    assert!(install_companion(&writable_paths, &source, &flatpak, &allowlist, true,).is_err());
    assert!(!writable_paths.binary.exists());

    let ancestor_temp = TempDir::new("writable-ancestor");
    let shared = ancestor_temp.path.join("shared");
    fs::create_dir(&shared).expect("create shared ancestor");
    set_mode(&shared, 0o777);
    let data_root = shared.join("victim-data");
    fs::create_dir(&data_root).expect("create private data root");
    set_mode(&data_root, 0o700);
    let ancestor_paths = resolve_companion_paths(
        &ancestor_temp.path.join("home"),
        Some(data_root.as_os_str()),
        Some(ancestor_temp.path.join("config").as_os_str()),
    )
    .expect("resolve paths below writable ancestor");
    let source = ancestor_temp.path.join("source-companion");
    let flatpak = ancestor_temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    assert!(
        install_companion(&ancestor_paths, &source, &flatpak, &allowlist, true).is_err(),
        "a private root below a non-sticky writable ancestor was accepted"
    );
    assert!(!ancestor_paths.binary.exists());
}

#[test]
#[cfg(unix)]
fn install_validates_source_and_canonicalizes_a_safe_flatpak_binary() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new("executables");
    let paths = explicit_paths(&temp);
    let source = temp.path.join("source-companion");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    let allowlist = embedded_allowlist().expect("allowlist");

    set_mode(&source, 0o777);
    assert!(install_companion(&paths, &source, &flatpak, &allowlist, true).is_err());
    set_mode(&source, 0o755);
    set_mode(&flatpak, 0o777);
    assert!(install_companion(&paths, &source, &flatpak, &allowlist, true).is_err());
    set_mode(&flatpak, 0o755);

    let insecure_parent = temp.path.join("insecure-flatpak-parent");
    fs::create_dir(&insecure_parent).expect("create insecure parent");
    set_mode(&insecure_parent, 0o777);
    let insecure_flatpak = insecure_parent.join("flatpak");
    make_executable(&insecure_flatpak, b"flatpak");
    assert!(install_companion(&paths, &source, &insecure_flatpak, &allowlist, true,).is_err());

    let flatpak_link = temp.path.join("flatpak-link");
    symlink(&flatpak, &flatpak_link).expect("create flatpak symlink");
    install_companion(&paths, &source, &flatpak_link, &allowlist, true)
        .expect("install through canonicalized flatpak path");
    let config: Value =
        serde_json::from_slice(&fs::read(&paths.config).expect("config")).expect("parse config");
    assert_eq!(
        config["flatpakBin"],
        fs::canonicalize(&flatpak)
            .expect("canonical flatpak")
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
#[cfg(unix)]
fn status_load_and_uninstall_fail_closed_for_unsafe_installation_entries() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new("fail-closed");
    let paths = explicit_paths(&temp);
    let source = temp.path.join("source-companion");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    let allowlist = embedded_allowlist().expect("allowlist");
    install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");

    set_mode(&paths.binary, 0o777);
    assert!(!companion_status(&paths, &allowlist).installed);
    assert!(load_companion_config(&paths, &paths.binary).is_err());
    assert!(uninstall_companion(&paths).is_err());
    set_mode(&paths.binary, 0o700);

    fs::remove_file(&paths.config).expect("remove config");
    symlink(paths.config.with_extension("missing"), &paths.config)
        .expect("create dangling config symlink");
    assert!(!companion_status(&paths, &allowlist).installed);
    assert!(load_companion_config(&paths, &paths.binary).is_err());
    assert!(uninstall_companion(&paths).is_err());

    fs::remove_file(&paths.config).expect("remove config symlink");
    install_companion(&paths, &source, &flatpak, &allowlist, true).expect("repair install");
    let manifest = &paths.manifests[0].path;
    fs::remove_file(manifest).expect("remove manifest");
    symlink(manifest.with_extension("missing"), manifest)
        .expect("create dangling manifest symlink");
    assert!(!companion_status(&paths, &allowlist).installed);
    assert!(uninstall_companion(&paths).is_err());
}

#[test]
fn install_refuses_unowned_files_unless_force_is_explicit() {
    let temp = TempDir::new("conflict");
    let paths = explicit_paths(&temp);
    let source = temp.path.join("source-companion");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&source, b"new-companion");
    make_executable(&flatpak, b"flatpak");
    let allowlist = embedded_allowlist().expect("embedded allowlist");

    let conflict = &paths.manifests[0].path;
    fs::create_dir_all(conflict.parent().expect("manifest parent")).expect("create parent");
    fs::write(
        conflict,
        br#"{"name":"org.example.foreign","path":"/foreign"}"#,
    )
    .expect("write foreign manifest");
    assert!(install_companion(&paths, &source, &flatpak, &allowlist, false).is_err());
    assert!(!paths.binary.exists());
    install_companion(&paths, &source, &flatpak, &allowlist, true).expect("forced install");

    let second = TempDir::new("binary-conflict");
    let second_paths = explicit_paths(&second);
    fs::create_dir_all(second_paths.binary.parent().expect("binary parent"))
        .expect("create binary parent");
    fs::write(&second_paths.binary, b"foreign-binary").expect("foreign binary");
    assert!(install_companion(&second_paths, &source, &flatpak, &allowlist, false,).is_err());
    assert_eq!(
        fs::read(&second_paths.binary).expect("preserved foreign binary"),
        b"foreign-binary"
    );
}

#[test]
fn uninstall_removes_only_manifests_still_owned_by_the_companion() {
    let temp = TempDir::new("uninstall");
    let paths = explicit_paths(&temp);
    let source = temp.path.join("source-companion");
    let flatpak = temp.path.join("bin/flatpak");
    make_executable(&source, b"companion");
    make_executable(&flatpak, b"flatpak");
    let allowlist = embedded_allowlist().expect("embedded allowlist");
    install_companion(&paths, &source, &flatpak, &allowlist, false).expect("install");

    let foreign = &paths.manifests[0].path;
    fs::write(
        foreign,
        br#"{"name":"org.example.foreign","path":"/foreign"}"#,
    )
    .expect("replace one manifest");
    uninstall_companion(&paths).expect("uninstall");

    assert!(foreign.exists(), "foreign manifest must be preserved");
    for target in paths.manifests.iter().skip(1) {
        assert!(!target.path.exists(), "owned manifest was preserved");
    }
    assert!(!paths.config.exists());
    assert!(!paths.binary.exists());
}

struct FakeRuntime {
    responses: VecDeque<Result<ResolveResult, CompanionError>>,
    calls: Vec<BrokerOperation>,
    launch_result: bool,
    launch_calls: usize,
}

impl FakeRuntime {
    fn new(responses: Vec<Result<ResolveResult, CompanionError>>) -> Self {
        Self {
            responses: responses.into(),
            calls: Vec::new(),
            launch_result: true,
            launch_calls: 0,
        }
    }
}

impl FlatpakRuntime for FakeRuntime {
    fn call_broker(&mut self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError> {
        self.calls.push(operation);
        self.responses.pop_front().expect("queued broker response")
    }

    fn launch_app(&mut self) -> bool {
        self.launch_calls += 1;
        self.launch_result
    }
}

fn error(error: ResolveError) -> ResolveResult {
    ResolveResult::Error { error }
}

#[test]
fn flatpak_resolution_probes_then_launches_then_waits_without_weakening_errors() {
    let pair = ResolveResult::request_pair(55_809, NONCE.into());
    let mut live = FakeRuntime::new(vec![Ok(pair.clone())]);
    assert_eq!(resolve_flatpak_request(true, &mut live), pair);
    assert_eq!(live.calls, vec![BrokerOperation::Probe]);
    assert_eq!(live.launch_calls, 0);

    let mut no_launch = FakeRuntime::new(vec![Ok(error(ResolveError::NotRunning))]);
    assert_eq!(
        resolve_flatpak_request(false, &mut no_launch),
        error(ResolveError::NotRunning)
    );
    assert_eq!(no_launch.launch_calls, 0);

    let pair = ResolveResult::request_pair(55_810, NONCE.into());
    let mut launched =
        FakeRuntime::new(vec![Ok(error(ResolveError::NotRunning)), Ok(pair.clone())]);
    assert_eq!(resolve_flatpak_request(true, &mut launched), pair);
    assert_eq!(
        launched.calls,
        vec![BrokerOperation::Probe, BrokerOperation::WaitForEndpoint]
    );
    assert_eq!(launched.launch_calls, 1);

    let mut unavailable = FakeRuntime::new(vec![Err(CompanionError::new("not installed"))]);
    assert_eq!(
        resolve_flatpak_request(true, &mut unavailable),
        error(ResolveError::NotInstalled)
    );
    assert_eq!(unavailable.launch_calls, 0);

    let mut launch_failed = FakeRuntime::new(vec![
        Ok(error(ResolveError::NotRunning)),
        Err(CompanionError::new("wait failed")),
    ]);
    assert_eq!(
        resolve_flatpak_request(true, &mut launch_failed),
        error(ResolveError::LaunchFailed)
    );
}

#[cfg(unix)]
fn shell_octal(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("\\{byte:03o}")).collect()
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

#[test]
#[cfg(unix)]
fn process_runtime_uses_fixed_flatpak_commands_and_rejects_stdout_pollution() {
    let temp = TempDir::new("runtime-process");
    let flatpak = temp.path.join("flatpak");
    let marker = temp.path.join("launched");
    let response =
        encode_broker_message(&error(ResolveError::NotRunning)).expect("encode broker response");
    let script = format!(
        "#!/bin/sh\n\
         if [ \"$#\" -eq 2 ]; then\n\
           [ \"$1\" = run ] && [ \"$2\" = app.motrix.native ] || exit 91\n\
           : > {}\n\
           exit 0\n\
         fi\n\
         [ \"$#\" -eq 3 ] || exit 92\n\
         [ \"$1\" = run ] || exit 93\n\
         [ \"$2\" = --command=motrix-native-host-broker ] || exit 94\n\
         [ \"$3\" = app.motrix.native ] || exit 95\n\
         cat >/dev/null\n\
         printf '{}'\n",
        shell_quote(&marker),
        shell_octal(&response),
    );
    make_executable(&flatpak, script.as_bytes());

    let mut runtime = FlatpakProcessRuntime::new(flatpak.clone());
    assert_eq!(
        runtime
            .call_broker(BrokerOperation::Probe)
            .expect("probe broker"),
        error(ResolveError::NotRunning)
    );
    assert!(runtime.launch_app());
    for _ in 0..100 {
        if marker.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(marker.exists(), "fixed Flatpak launch command was not used");

    let polluted_script = format!(
        "#!/bin/sh\ncat >/dev/null\nprintf '{}x'\n",
        shell_octal(&response)
    );
    make_executable(&flatpak, polluted_script.as_bytes());
    assert!(runtime.call_broker(BrokerOperation::Probe).is_err());

    let unexpected = encode_broker_message(&error(ResolveError::LaunchFailed))
        .expect("encode unexpected response");
    let unexpected_script = format!(
        "#!/bin/sh\ncat >/dev/null\nprintf '{}'\n",
        shell_octal(&unexpected)
    );
    make_executable(&flatpak, unexpected_script.as_bytes());
    assert!(runtime.call_broker(BrokerOperation::Probe).is_err());
}

#[test]
fn allowlist_file_is_strict_and_matches_manifest_contract() {
    let allowlist = embedded_allowlist().expect("embedded allowlist");
    assert_eq!(allowlist.chromium, [CHROMIUM_ID, EDGE_ID]);
    assert_eq!(allowlist.firefox, [FIREFOX_ID]);
    assert!(!super::is_chromium_extension_id(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA"
    ));
    assert!(!super::is_firefox_extension_id("invalid id@example.com"));
    assert!(super::absolute_root(OsStr::new("relative"), "path").is_err());
}
