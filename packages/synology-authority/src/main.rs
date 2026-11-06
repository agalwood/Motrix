//! One-shot DSM authority bridge. No listener, arbitrary command, file-content
//! operation or persistent state. Only the package UID may invoke it.
#![cfg(target_os = "linux")]

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_INPUT: u64 = 16 * 1024;
const MAX_OUTPUT: usize = 32 * 1024;
const AUTHENTICATE: &str = "/usr/syno/synoman/webman/modules/authenticate.cgi";
const USER: &str = "/usr/syno/sbin/synouser";
const ACL: &str = "/usr/syno/bin/synoacltool";

#[derive(Deserialize, Debug)]
#[serde(tag = "operation", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    Session { context: BTreeMap<String, String> },
    Account { username: String },
    Acl { username: String, path: String },
}

fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}
fn username(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('-')
        && !value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || ":[]\\/".contains(c))
}
fn bounded(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(char::is_control)
}
fn validate_context(context: &BTreeMap<String, String>) -> bool {
    if context.keys().any(|key| {
        !matches!(
            key.as_str(),
            "HTTP_COOKIE"
                | "REMOTE_ADDR"
                | "SERVER_ADDR"
                | "SERVER_PORT"
                | "HTTPS"
                | "REQUEST_SCHEME"
                | "HTTP_HOST"
                | "HTTP_USER_AGENT"
                | "HTTP_X_SYNO_TOKEN"
                | "REQUEST_METHOD"
                | "SERVER_PROTOCOL"
                | "GATEWAY_INTERFACE"
                | "SCRIPT_NAME"
                | "REQUEST_URI"
        )
    }) {
        return false;
    }
    let get = |key| context.get(key).map(String::as_str).unwrap_or("");
    let scheme = get("REQUEST_SCHEME");
    bounded(get("HTTP_COOKIE"), 8192)
        && !get("HTTP_COOKIE").is_empty()
        && get("REMOTE_ADDR").parse::<std::net::IpAddr>().is_ok()
        && get("SERVER_ADDR").parse::<std::net::IpAddr>().is_ok()
        && get("SERVER_PORT").parse::<u16>().is_ok_and(|port| port > 0)
        && matches!(scheme, "http" | "https")
        && get("HTTPS") == if scheme == "https" { "on" } else { "" }
        && get("REQUEST_METHOD") == "GET"
        && get("SERVER_PROTOCOL") == "HTTP/1.1"
        && get("GATEWAY_INTERFACE") == "CGI/1.1"
        && get("SCRIPT_NAME") == "/webman/modules/authenticate.cgi"
        && get("REQUEST_URI") == "/webman/modules/authenticate.cgi"
        && bounded(get("HTTP_HOST"), 512)
        && bounded(get("HTTP_USER_AGENT"), 2048)
        && bounded(get("HTTP_X_SYNO_TOKEN"), 4096)
}
fn nas_path(value: &str) -> bool {
    if !bounded(value, 4096) || !value.starts_with('/') {
        return false;
    }
    let parts: Vec<_> = value.split('/').collect();
    parts.len() >= 3
        && parts[1].strip_prefix("volume").is_some_and(|n| {
            !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
        })
        && parts[2..]
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != "..")
}
fn trusted_program(path: &str, system_uid: u32) -> io::Result<()> {
    // Check the canonical executable and its ancestors, not package-writable code.
    for part in Path::new(path).ancestors() {
        let info = fs::symlink_metadata(part)?;
        if (info.uid() != 0 && info.uid() != system_uid)
            || (!info.file_type().is_symlink() && info.mode() & 0o022 != 0)
        {
            return Err(invalid());
        }
    }
    let canonical = fs::canonicalize(path)?;
    for part in canonical.ancestors() {
        let info = fs::metadata(part)?;
        if (info.uid() != 0 && info.uid() != system_uid) || info.mode() & 0o022 != 0 {
            return Err(invalid());
        }
    }
    if !fs::metadata(canonical)?.is_file() {
        return Err(invalid());
    }
    Ok(())
}
fn hold_path(path: &str) -> io::Result<File> {
    if !nas_path(path) {
        return Err(invalid());
    }
    // Resolve each component from an open parent before elevating. Never follow
    // a symlink, and do not traverse anything unavailable to the package user.
    let mut held = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open("/")?;
    let components: Vec<_> = Path::new(path).components().collect();
    for (index, component) in components.iter().enumerate().skip(1) {
        let Component::Normal(name) = component else {
            return Err(invalid());
        };
        let next = format!(
            "/proc/self/fd/{}/{}",
            held.as_raw_fd(),
            name.to_str().ok_or_else(invalid)?
        );
        held = OpenOptions::new()
            .read(true)
            .custom_flags(
                libc::O_PATH
                    | libc::O_NOFOLLOW
                    | if index + 1 < components.len() {
                        libc::O_DIRECTORY
                    } else {
                        0
                    },
            )
            .open(next)?;
        if held.metadata()?.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    if fs::read_link(format!("/proc/self/fd/{}", held.as_raw_fd()))? != Path::new(path) {
        return Err(invalid());
    }
    Ok(held)
}
fn checked(result: libc::c_int) -> io::Result<()> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn harden() -> io::Result<()> {
    unsafe {
        // An untrusted caller may have ignored or blocked these before exec.
        for signal in [libc::SIGALRM, libc::SIGCHLD, libc::SIGPIPE] {
            if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                return Err(io::Error::last_os_error());
            }
        }
        let mut signals = std::mem::zeroed::<libc::sigset_t>();
        checked(libc::sigemptyset(&mut signals))?;
        checked(libc::sigprocmask(
            libc::SIG_SETMASK,
            &signals,
            std::ptr::null_mut(),
        ))?;
        checked(libc::prctl(libc::PR_SET_DUMPABLE, 0))?;
        let core = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        checked(libc::setrlimit(libc::RLIMIT_CORE, &core))?;
        libc::alarm(6); // Also bounds an incomplete/malicious stdin request.
    }
    Ok(())
}
fn monitor_privileges(parent: libc::pid_t) -> io::Result<()> {
    // Enter only after validation and package-user path acquisition. A package
    // caller must not SIGSTOP the deadline monitor while its root child runs.
    unsafe {
        checked(libc::setgroups(0, std::ptr::null()))?;
        checked(libc::setresgid(0, 0, 0))?;
        checked(libc::setresuid(0, 0, 0))?;
        checked(libc::prctl(libc::PR_SET_DUMPABLE, 0))?;
        checked(libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL))?;
        if libc::getppid() != parent {
            return Err(invalid());
        }
    }
    Ok(())
}
unsafe fn child_privileges(parent: libc::pid_t, held: Option<RawFd>) -> io::Result<()> {
    // File capabilities are used only by this compiled broker. The application
    // never changes UID. The child needs UID 0 for DSM's private authority APIs.
    unsafe {
        checked(libc::setgroups(0, std::ptr::null()))?;
        checked(libc::setresgid(0, 0, 0))?;
        checked(libc::setresuid(0, 0, 0))?;
        // Keep only filesystem access capabilities in the exec bounding set;
        // no mount, network administration, ptrace, setuid, setgid or setfcap.
        for cap in 0..64 {
            if cap == 1 || cap == 2 {
                continue;
            } // DAC_OVERRIDE, DAC_READ_SEARCH
            if libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINVAL) {
                    return Err(error);
                }
            }
        }
        checked(libc::prctl(libc::PR_SET_DUMPABLE, 0))?;
        checked(libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL))?;
        if libc::getppid() != parent {
            return Err(invalid());
        }
        let cpu = libc::rlimit {
            rlim_cur: 3,
            rlim_max: 4,
        };
        checked(libc::setrlimit(libc::RLIMIT_CPU, &cpu))?;
        libc::alarm(4);
        if let Some(fd) = held {
            checked(libc::fcntl(fd, libc::F_SETFD, 0))?;
        }
    }
    Ok(())
}
fn command(
    request: &Request,
    held: Option<&File>,
    system_uid: u32,
    caller_parent: libc::pid_t,
) -> io::Result<Vec<u8>> {
    let mut process = match request {
        Request::Session { context } => {
            if !validate_context(context) {
                return Err(invalid());
            }
            trusted_program(AUTHENTICATE, system_uid)?;
            let mut process = Command::new(AUTHENTICATE);
            process.env_clear().envs(context);
            process
        }
        Request::Account { username: name } => {
            if !username(name) {
                return Err(invalid());
            }
            trusted_program(USER, system_uid)?;
            let mut process = Command::new(USER);
            process.env_clear().args(["--get", name]);
            process
        }
        Request::Acl {
            username: name,
            path,
        } => {
            if !username(name) || !nas_path(path) {
                return Err(invalid());
            }
            let file = held.ok_or_else(invalid)?;
            trusted_program(ACL, system_uid)?;
            let mut process = Command::new(ACL);
            process.env_clear().args([
                "-get-perm",
                &format!("/proc/self/fd/{}", file.as_raw_fd()),
                name,
            ]);
            process
        }
    };
    process
        .env("PATH", "/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    monitor_privileges(caller_parent)?;
    let parent = unsafe { libc::getpid() };
    let descriptor = held.map(AsRawFd::as_raw_fd);
    unsafe {
        process.pre_exec(move || child_privileges(parent, descriptor));
    }
    let mut child = process.spawn()?;
    let mut output = child.stdout.take().ok_or_else(invalid)?;
    unsafe {
        checked(libc::fcntl(
            output.as_raw_fd(),
            libc::F_SETFL,
            libc::O_NONBLOCK,
        ))?;
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match output.read(&mut chunk) {
            Ok(0) => {}
            Ok(count) => bytes.extend_from_slice(&chunk[..count]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
        if bytes.len() > MAX_OUTPUT || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                std::process::exit(status.code().filter(|c| *c > 0 && *c <= 255).unwrap_or(125));
            }
            // The fixed commands have exited; drain only already-buffered data.
            loop {
                match output.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        bytes.extend_from_slice(&chunk[..count]);
                        if bytes.len() > MAX_OUTPUT {
                            return Err(invalid());
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(error),
                }
            }
            return Ok(bytes);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
// Group-looking text in an editable profile field is not authority. Only the
// unique final Member Of block, with its exact declared count, can grant admin.
fn administrator_group(value: &str) -> bool {
    let lines: Vec<_> = value
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let headers: Vec<_> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let rest = line
                .strip_prefix("Member Of")?
                .trim_start()
                .strip_prefix(':')?
                .trim();
            Some((index, rest))
        })
        .collect();
    if headers.len() != 1 {
        return false;
    }
    let (index, rest) = headers[0];
    let Some(number) = rest.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return false;
    };
    let Ok(count) = number.parse::<usize>() else {
        return false;
    };
    let groups = &lines[index + 1..];
    if count == 0 || count > 1024 || groups.len() != count {
        return false;
    }
    let valid = groups.iter().all(|line| {
        line.strip_prefix('(')
            .and_then(|s| s.split_once(") "))
            .is_some_and(|(id, name)| id.parse::<u32>().is_ok() && !name.is_empty())
    });
    valid && groups.contains(&"(101) administrators")
}

fn filtered(request: &Request, bytes: &[u8]) -> io::Result<String> {
    let value = std::str::from_utf8(bytes).map_err(|_| invalid())?.trim();
    match request {
        Request::Session { .. } if username(value) => Ok(value.to_owned()),
        Request::Account { username: name } => {
            // Do not return email, home paths, full names or other profile data.
            let mut lines: Vec<_> = value
                .lines()
                .map(str::trim)
                .filter(|line| {
                    let line = line.trim();
                    ["User Name", "User Type", "User uid", "Expired"]
                        .iter()
                        .any(|key| {
                            line.strip_prefix(key)
                                .is_some_and(|rest| rest.trim_start().starts_with(':'))
                        })
                })
                .collect();
            if lines.len() < 4 || !username(name) {
                return Err(invalid());
            }
            if administrator_group(value) {
                lines.push("(101) administrators");
            }
            Ok(lines.join("\n"))
        }
        Request::Acl { .. } => {
            let mask = value
                .strip_prefix("Final permission: [")
                .and_then(|s| s.strip_suffix(']'))
                .ok_or_else(invalid)?;
            if mask.len() != 13 || !mask.bytes().all(|b| b"rwxpdDaARWcCo-".contains(&b)) {
                return Err(invalid());
            }
            Ok(value.to_owned())
        }
        _ => Err(invalid()),
    }
}
fn main_result() -> io::Result<()> {
    harden()?;
    let caller_parent = unsafe { libc::getppid() };
    let caller = unsafe { libc::getuid() };
    let executable = fs::metadata("/proc/self/exe")?;
    // DSM installs this tool owner-only for the package UID. Copying or writing
    // the file clears kernel file capabilities; no user database is read here.
    if std::env::args_os().len() != 1
        || caller == 0
        || executable.uid() != caller
        || executable.mode() & 0o7077 != 0
    {
        return Err(invalid());
    }
    // DSM's reserved system account owns authenticate.cgi; verified on DSM 7.4.1.
    let system_uid = 1;
    let mut input = Vec::new();
    io::stdin().take(MAX_INPUT + 1).read_to_end(&mut input)?;
    if input.len() as u64 > MAX_INPUT {
        return Err(invalid());
    }
    let request: Request = serde_json::from_slice(&input).map_err(|_| invalid())?;
    let held = match &request {
        Request::Acl { path, .. } => Some(hold_path(path)?),
        _ => None,
    };
    let output = command(&request, held.as_ref(), system_uid, caller_parent)?;
    io::stdout().write_all(filtered(&request, &output)?.as_bytes())
}
fn main() {
    if main_result().is_err() {
        std::process::exit(126);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_command_and_environment_injection() {
        assert!(serde_json::from_str::<Request>(r#"{"operation":"exec","command":"sh"}"#).is_err());
        assert!(
            serde_json::from_str::<Request>(
                r#"{"operation":"account","username":"alice","command":"sh"}"#
            )
            .is_err()
        );
        for name in ["", "--help", "alice\nroot", "DOMAIN\\user", "../root"] {
            assert!(!username(name));
        }
        let context = BTreeMap::from([("LD_PRELOAD".into(), "/tmp/inject.so".into())]);
        assert!(!validate_context(&context));
    }
    #[test]
    fn confines_acl_paths_to_nas_volumes() {
        for path in [
            "/etc/shadow",
            "/volume1",
            "/volume1/../etc",
            "/volume1//data",
            "/volume1/data\n",
            "/volume01/data",
        ] {
            assert!(!nas_path(path));
        }
        assert!(nas_path("/volume1/motrix/file"));
    }
    #[test]
    fn removes_unneeded_account_profile_fields() {
        let request = Request::Account {
            username: "alice".into(),
        };
        let output = filtered(&request, b"User Name : [alice]\nUser Type : [AUTH_LOCAL]\nUser uid : [1700]\nExpired : [false]\nUser Mail : [private@example.test]\nUser Dir : [/private]\n(101) administrators").unwrap();
        assert!(!output.contains("private"));
        assert!(output.contains("Expired : [false]"));
    }
    #[test]
    fn profile_text_cannot_forge_administrator_membership() {
        assert!(administrator_group(
            "User Name : [alice]\nMember Of : [2]\n(100) users\n(101) administrators"
        ));
        assert!(!administrator_group(
            "Fullname : [fake\n(101) administrators\n]\nMember Of : [1]\n(100) users"
        ));
        assert!(!administrator_group(
            "Fullname : [fake\nMember Of : [1]\n(101) administrators\n]\nMember Of : [1]\n(100) users"
        ));
        assert!(!administrator_group(
            "Member Of : [1]\n(100) users\n(101) administrators"
        ));
    }
}
