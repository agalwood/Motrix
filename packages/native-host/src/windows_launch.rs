//! Same-package activation through the fixed, bounded Windows platform helper.
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::windows_package::PackageProfile;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchDecision {
    Direct,
    Package,
    Reject,
}

pub fn launch_decision(package: &PackageProfile, has_override: bool) -> LaunchDecision {
    match package {
        Ok(None) => LaunchDecision::Direct,
        Ok(Some(_)) if !has_override => LaunchDecision::Package,
        Ok(Some(_)) | Err(_) => LaunchDecision::Reject,
    }
}

pub fn helper_path(executable: &Path) -> Option<PathBuf> {
    if !executable.is_absolute()
        || !executable
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case("motrix-native-host.exe")
    {
        return None;
    }
    let directory = executable.parent()?;
    if directory.file_name()? != "bin" || directory.parent()?.file_name()? != "resources" {
        return None;
    }
    Some(directory.join("motrix-windows-platform.exe"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchReply {
    version: u8,
    ok: bool,
    #[serde(rename = "packageIdentityPresent")]
    package_identity_present: bool,
    launched: bool,
}

pub fn accepted_reply(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > 1024 {
        return false;
    }
    serde_json::from_slice::<LaunchReply>(bytes).is_ok_and(|reply| {
        reply.version == 1 && reply.ok && reply.package_identity_present && reply.launched
    })
}

#[cfg(not(windows))]
pub fn launch() -> bool {
    false
}

#[cfg(windows)]
pub fn launch() -> bool {
    let Some(helper) = std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(helper_path)
    else {
        return false;
    };
    if !std::fs::symlink_metadata(&helper).is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    windows::invoke(
        std::process::Command::new(helper),
        std::time::Duration::from_secs(5),
    )
}

#[cfg(windows)]
mod windows {
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::ptr;
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, GetLastError};
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    const REQUEST: &[u8] = b"{\"version\":1,\"op\":\"main_launch\"}\n";
    const MAX_REPLY: usize = 1024;

    fn stop(child: &mut Child) {
        // Kill only the helper. An application activated by Windows must not
        // inherit a kill-on-close job that terminates it when the host returns.
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(10)),
            }
        }
    }

    pub(super) fn invoke(mut command: Command, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut child) = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
        else {
            return false;
        };
        let result = (|| {
            // The small fixed request fits the fresh anonymous pipe's
            // buffer. No user-controlled input or command-line arguments.
            child.stdin.take()?.write_all(REQUEST).ok()?;
            let mut stdout = child.stdout.take()?;
            let mut bytes = Vec::new();
            let mut eof = false;
            let mut status = None;
            while Instant::now() < deadline {
                if !eof {
                    let mut available = 0;
                    // SAFETY: stdout owns this pipe handle. Only this thread
                    // reads it. Peek avoids a blocking ReadFile/reader thread
                    // that could outlive a timed-out helper or inherited pipe.
                    let success = unsafe {
                        PeekNamedPipe(
                            stdout.as_raw_handle(),
                            ptr::null_mut(),
                            0,
                            ptr::null_mut(),
                            &mut available,
                            ptr::null_mut(),
                        )
                    };
                    if success == 0 {
                        if unsafe { GetLastError() } != ERROR_BROKEN_PIPE {
                            return None;
                        }
                        eof = true;
                    } else if available > 0 {
                        if bytes.len() >= MAX_REPLY {
                            return None;
                        }
                        let mut buffer = [0u8; MAX_REPLY + 1];
                        let count = (available as usize)
                            .min(buffer.len())
                            .min(MAX_REPLY + 1 - bytes.len());
                        let read = stdout.read(&mut buffer[..count]).ok()?;
                        if read == 0 {
                            return None;
                        }
                        bytes.extend_from_slice(&buffer[..read]);
                        if bytes.len() > MAX_REPLY {
                            return None;
                        }
                    }
                }
                if status.is_none() {
                    status = child.try_wait().ok()?;
                }
                if eof && let Some(status) = status {
                    return Some(status.success() && super::accepted_reply(&bytes));
                }
                thread::sleep(Duration::from_millis(10));
            }
            None
        })();
        if child.try_wait().ok().flatten().is_none() {
            stop(&mut child);
        }
        result.unwrap_or(false)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use base64::Engine;
        use base64::engine::general_purpose::STANDARD;

        fn fixture(script: &str) -> Command {
            let executable = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let encoded = STANDARD.encode(
                script
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            );
            let mut command = Command::new(executable);
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded,
            ]);
            command
        }

        #[test]
        fn accepts_one_complete_helper_response_and_drains_after_exit() {
            assert!(invoke(
                fixture(
                    "[Console]::Out.WriteLine('{\"version\":1,\"ok\":true,\"packageIdentityPresent\":true,\"launched\":true}')"
                ),
                Duration::from_secs(10)
            ));
        }

        #[test]
        fn rejects_failed_exit_oversized_output_and_unclosed_process() {
            for script in [
                "[Console]::Out.WriteLine('{}'); exit 1",
                "[Console]::Out.Write('x' * 2048)",
            ] {
                assert!(!invoke(fixture(script), Duration::from_secs(10)));
            }
            let before = Instant::now();
            assert!(!invoke(
                fixture("Start-Sleep -Seconds 30"),
                Duration::from_millis(100)
            ));
            assert!(before.elapsed() < Duration::from_secs(5));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_package::PackageError;

    #[test]
    fn only_verified_package_without_overrides_can_activate() {
        let profile = Ok(Some(PathBuf::from("Store-profile")));
        assert_eq!(launch_decision(&profile, false), LaunchDecision::Package);
        assert_eq!(launch_decision(&profile, true), LaunchDecision::Reject);
        for error in [
            PackageError::Identity,
            PackageError::Application,
            PackageError::Profile,
        ] {
            assert_eq!(launch_decision(&Err(error), false), LaunchDecision::Reject);
            assert_eq!(launch_decision(&Err(error), true), LaunchDecision::Reject);
        }
        for has_override in [false, true] {
            assert_eq!(
                launch_decision(&Ok(None), has_override),
                LaunchDecision::Direct
            );
        }
    }

    #[test]
    fn helper_is_a_fixed_sibling_of_the_actual_packaged_native_host() {
        let root = std::env::temp_dir().join("package/app/resources/bin");
        assert_eq!(
            helper_path(&root.join("motrix-native-host.exe")),
            Some(root.join("motrix-windows-platform.exe"))
        );
        assert!(helper_path(Path::new("motrix-native-host.exe")).is_none());
        assert!(helper_path(&root.join("other.exe")).is_none());
        assert!(helper_path(&std::env::temp_dir().join("motrix-native-host.exe")).is_none());
    }

    #[test]
    fn requires_an_exact_successful_bounded_response() {
        let valid = br#"{"version":1,"ok":true,"packageIdentityPresent":true,"launched":true}"#;
        assert!(accepted_reply(valid));
        for value in [
            &b""[..], &b"{}"[..], &b"null"[..], &b"\xff"[..],
            &br#"{"version":1,"ok":false,"code":"no_package_identity"}"#[..],
            &br#"{"version":1,"ok":true,"packageIdentityPresent":false,"launched":true}"#[..],
            &br#"{"version":1,"ok":true,"packageIdentityPresent":true,"launched":false}"#[..],
            &br#"{"version":2,"ok":true,"packageIdentityPresent":true,"launched":true}"#[..],
            &br#"{"version":1,"ok":true,"packageIdentityPresent":true,"launched":true,"path":"other.exe"}"#[..],
            &br#"{"version":1,"ok":true,"ok":true,"packageIdentityPresent":true,"launched":true}"#[..],
        ] { assert!(!accepted_reply(value)); }
        assert!(!accepted_reply(
            &[valid.as_slice(), valid.as_slice()].concat()
        ));
        assert!(!accepted_reply(
            &[valid.as_slice(), &vec![b' '; 1024]].concat()
        ));
    }
}
