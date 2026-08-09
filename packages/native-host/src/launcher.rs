use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use crate::MOTRIX_FLATPAK_ID;
use crate::user_data::{NativeHostPlatform, absolute_directory_from_env, current_platform};

const SNAPCTL: &str = "/usr/bin/snapctl";
const SNAP_LAUNCH_URI: &str = "motrix://bridge/native-host";
const FLATPAK_MOTRIX_LAUNCHER: &str = "/app/bin/start-motrix";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapLaunchDecision {
    NotSnap,
    InvalidEnvironment,
    Launch(LaunchCommand),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FlatpakLaunchDecision {
    NotFlatpak,
    InvalidEnvironment,
    Launch(LaunchCommand),
}

pub fn flatpak_launch_decision(
    platform: NativeHostPlatform,
    flatpak_id: Option<&OsStr>,
) -> FlatpakLaunchDecision {
    if platform != NativeHostPlatform::Linux {
        return FlatpakLaunchDecision::NotFlatpak;
    }
    let Some(flatpak_id) = flatpak_id else {
        return FlatpakLaunchDecision::NotFlatpak;
    };
    if flatpak_id != OsStr::new(MOTRIX_FLATPAK_ID) {
        return FlatpakLaunchDecision::InvalidEnvironment;
    }
    FlatpakLaunchDecision::Launch(LaunchCommand {
        program: PathBuf::from(FLATPAK_MOTRIX_LAUNCHER),
        args: Vec::new(),
    })
}

pub fn snap_launch_decision(
    platform: NativeHostPlatform,
    snap_root: Option<&OsStr>,
) -> SnapLaunchDecision {
    if platform != NativeHostPlatform::Linux {
        return SnapLaunchDecision::NotSnap;
    }
    let Some(snap_root) = snap_root else {
        return SnapLaunchDecision::NotSnap;
    };
    if absolute_directory_from_env(snap_root).is_none() {
        return SnapLaunchDecision::InvalidEnvironment;
    }
    SnapLaunchDecision::Launch(LaunchCommand {
        program: PathBuf::from(SNAPCTL),
        args: vec![OsString::from("user-open"), OsString::from(SNAP_LAUNCH_URI)],
    })
}

pub fn motrix_candidates(
    platform: NativeHostPlatform,
    home: Option<&Path>,
    local_app_data: Option<&OsStr>,
) -> Vec<PathBuf> {
    match platform {
        NativeHostPlatform::Darwin => {
            let mut candidates = vec![PathBuf::from("/Applications/Motrix.app")];
            if let Some(home) = home {
                candidates.push(home.join("Applications").join("Motrix.app"));
            }
            candidates
        }
        NativeHostPlatform::Linux => vec![
            PathBuf::from("/usr/bin/motrix"),
            PathBuf::from("/opt/Motrix/motrix"),
            PathBuf::from("/usr/local/bin/motrix"),
        ],
        NativeHostPlatform::Win32 => {
            let mut candidates = vec![PathBuf::from(r"C:\Program Files\Motrix\Motrix.exe")];
            if let Some(local_app_data) = local_app_data
                && !local_app_data.to_string_lossy().trim().is_empty()
            {
                candidates.push(
                    PathBuf::from(local_app_data)
                        .join("Programs")
                        .join("Motrix")
                        .join("Motrix.exe"),
                );
            }
            candidates
        }
    }
}

pub fn find_motrix_path(
    platform: NativeHostPlatform,
    home: Option<&Path>,
    local_app_data: Option<&OsStr>,
) -> Option<PathBuf> {
    motrix_candidates(platform, home, local_app_data)
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn configure_detached(command: &mut Command) {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
}

fn spawn_detached(spec: LaunchCommand) -> bool {
    let mut command = Command::new(spec.program);
    command.args(spec.args);
    configure_detached(&mut command);
    match command.spawn() {
        Ok(mut child) => {
            // Dropping std::process::Child does not reap it on Unix. The host can
            // remain open for the lifetime of the browser NM port, so reap in a
            // detached thread if the launched process exits first. Process exit
            // does not wait for this thread when the browser closes stdin.
            thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

pub fn launch_motrix() -> bool {
    let platform = current_platform();
    match flatpak_launch_decision(platform, std::env::var_os("FLATPAK_ID").as_deref()) {
        FlatpakLaunchDecision::Launch(spec) => return spawn_detached(spec),
        FlatpakLaunchDecision::InvalidEnvironment => return false,
        FlatpakLaunchDecision::NotFlatpak => {}
    }
    match snap_launch_decision(platform, std::env::var_os("SNAP").as_deref()) {
        SnapLaunchDecision::Launch(spec) => return spawn_detached(spec),
        SnapLaunchDecision::InvalidEnvironment => return false,
        SnapLaunchDecision::NotSnap => {}
    }

    let home = home::home_dir();
    let local_app_data = std::env::var_os("LOCALAPPDATA");
    let Some(path) = find_motrix_path(platform, home.as_deref(), local_app_data.as_deref()) else {
        return false;
    };

    let spec = if platform == NativeHostPlatform::Darwin {
        LaunchCommand {
            program: PathBuf::from("/usr/bin/open"),
            args: vec![OsString::from("-a"), path.into_os_string()],
        }
    } else {
        LaunchCommand {
            program: path,
            args: Vec::new(),
        }
    };
    spawn_detached(spec)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use super::LaunchCommand;
    use super::{
        FlatpakLaunchDecision, SnapLaunchDecision, flatpak_launch_decision, motrix_candidates,
        snap_launch_decision,
    };
    use crate::user_data::NativeHostPlatform;

    #[test]
    fn preserves_macos_candidate_order() {
        assert_eq!(
            motrix_candidates(
                NativeHostPlatform::Darwin,
                Some(Path::new("/Users/me")),
                None,
            ),
            vec![
                PathBuf::from("/Applications/Motrix.app"),
                PathBuf::from("/Users/me/Applications/Motrix.app"),
            ]
        );
    }

    #[test]
    fn preserves_linux_candidate_order() {
        assert_eq!(
            motrix_candidates(NativeHostPlatform::Linux, None, None),
            vec![
                PathBuf::from("/usr/bin/motrix"),
                PathBuf::from("/opt/Motrix/motrix"),
                PathBuf::from("/usr/local/bin/motrix"),
            ]
        );
    }

    #[test]
    fn preserves_windows_candidate_order() {
        assert_eq!(
            motrix_candidates(
                NativeHostPlatform::Win32,
                None,
                Some(OsStr::new("C:/Users/me/AppData/Local")),
            ),
            vec![
                PathBuf::from(r"C:\Program Files\Motrix\Motrix.exe"),
                PathBuf::from("C:/Users/me/AppData/Local")
                    .join("Programs")
                    .join("Motrix")
                    .join("Motrix.exe"),
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn flatpak_launch_uses_the_in_sandbox_wrapper() {
        assert_eq!(
            flatpak_launch_decision(
                NativeHostPlatform::Linux,
                Some(OsStr::new("app.motrix.native")),
            ),
            FlatpakLaunchDecision::Launch(LaunchCommand {
                program: PathBuf::from("/app/bin/start-motrix"),
                args: Vec::new(),
            })
        );
    }

    #[test]
    fn malformed_flatpak_environment_fails_closed() {
        for invalid in [
            "",
            " ",
            "org.example.Other",
            "app.motrix.native/../../other",
        ] {
            assert_eq!(
                flatpak_launch_decision(NativeHostPlatform::Linux, Some(OsStr::new(invalid)),),
                FlatpakLaunchDecision::InvalidEnvironment,
            );
        }
    }

    #[test]
    fn non_flatpak_and_non_linux_launches_keep_the_native_path() {
        assert_eq!(
            flatpak_launch_decision(NativeHostPlatform::Linux, None),
            FlatpakLaunchDecision::NotFlatpak
        );
        assert_eq!(
            flatpak_launch_decision(
                NativeHostPlatform::Darwin,
                Some(OsStr::new("app.motrix.native")),
            ),
            FlatpakLaunchDecision::NotFlatpak
        );
    }

    #[test]
    #[cfg(unix)]
    fn snap_launch_uses_the_user_open_portal_command() {
        assert_eq!(
            snap_launch_decision(
                NativeHostPlatform::Linux,
                Some(OsStr::new("/snap/motrix/current")),
            ),
            SnapLaunchDecision::Launch(LaunchCommand {
                program: PathBuf::from("/usr/bin/snapctl"),
                args: vec![
                    OsStr::new("user-open").to_os_string(),
                    OsStr::new("motrix://bridge/native-host").to_os_string(),
                ],
            })
        );
    }

    #[test]
    #[cfg(unix)]
    fn malformed_snap_environment_fails_closed() {
        for invalid in ["", " ", "relative/snap", "/", "/snap/motrix/../other"] {
            assert_eq!(
                snap_launch_decision(NativeHostPlatform::Linux, Some(OsStr::new(invalid)),),
                SnapLaunchDecision::InvalidEnvironment,
            );
        }
    }

    #[test]
    fn non_snap_and_non_linux_launches_keep_the_native_path() {
        assert_eq!(
            snap_launch_decision(NativeHostPlatform::Linux, None),
            SnapLaunchDecision::NotSnap
        );
        assert_eq!(
            snap_launch_decision(
                NativeHostPlatform::Darwin,
                Some(OsStr::new("/snap/motrix/current")),
            ),
            SnapLaunchDecision::NotSnap
        );
    }
}
