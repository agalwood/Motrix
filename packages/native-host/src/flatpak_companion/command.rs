use std::ffi::OsString;
use std::path::PathBuf;

use super::allowlist::NativeMessagingAllowlist;
use super::paths::{CompanionPaths, ManifestFamily, absolute_root};
use super::{CompanionError, DEFAULT_FLATPAK_BIN};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompanionCommand {
    Browser,
    Install { flatpak_bin: PathBuf, force: bool },
    Status,
    Uninstall,
    Help,
    Version,
}

pub fn parse_companion_command(args: &[OsString]) -> Result<CompanionCommand, CompanionError> {
    let Some(first) = args.first().and_then(|value| value.to_str()) else {
        return Ok(CompanionCommand::Browser);
    };
    match first {
        "install" => {
            let mut flatpak_bin = None;
            let mut force = false;
            let mut index = 1;
            while index < args.len() {
                let flag = args[index]
                    .to_str()
                    .ok_or_else(|| CompanionError::new("install arguments must be UTF-8"))?;
                match flag {
                    "--force" if !force => force = true,
                    "--force" => return Err(CompanionError::new("--force provided twice")),
                    "--flatpak-bin" if flatpak_bin.is_none() => {
                        index += 1;
                        let value = args
                            .get(index)
                            .ok_or_else(|| CompanionError::new("--flatpak-bin requires a value"))?;
                        flatpak_bin = Some(absolute_root(value, "--flatpak-bin")?);
                    }
                    "--flatpak-bin" => {
                        return Err(CompanionError::new("--flatpak-bin provided twice"));
                    }
                    _ => {
                        return Err(CompanionError::new(format!(
                            "unknown install argument: {flag}"
                        )));
                    }
                }
                index += 1;
            }
            Ok(CompanionCommand::Install {
                flatpak_bin: flatpak_bin.unwrap_or_else(|| PathBuf::from(DEFAULT_FLATPAK_BIN)),
                force,
            })
        }
        "status" if args.len() == 1 => Ok(CompanionCommand::Status),
        "uninstall" if args.len() == 1 => Ok(CompanionCommand::Uninstall),
        "--help" if args.len() == 1 => Ok(CompanionCommand::Help),
        "--version" if args.len() == 1 => Ok(CompanionCommand::Version),
        "status" | "uninstall" | "--help" | "--version" => {
            Err(CompanionError::new(format!("{first} takes no arguments")))
        }
        _ => Ok(CompanionCommand::Browser),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserCaller {
    Chromium { extension_id: String },
    Firefox { extension_id: String },
}

pub fn validate_browser_caller(
    args: &[OsString],
    allowlist: &NativeMessagingAllowlist,
    paths: &CompanionPaths,
) -> Result<BrowserCaller, CompanionError> {
    if args.len() == 1 {
        let origin = args[0]
            .to_str()
            .ok_or_else(|| CompanionError::new("Chromium caller origin must be UTF-8"))?;
        let extension_id = origin
            .strip_prefix("chrome-extension://")
            .map(|value| value.strip_suffix('/').unwrap_or(value))
            .filter(|value| !value.contains('/'))
            .ok_or_else(|| CompanionError::new("invalid Chromium caller origin"))?;
        if !allowlist
            .chromium
            .iter()
            .any(|allowed| allowed == extension_id)
        {
            return Err(CompanionError::new("Chromium caller is not allowlisted"));
        }
        return Ok(BrowserCaller::Chromium {
            extension_id: extension_id.into(),
        });
    }

    if args.len() == 2 {
        let manifest_path = PathBuf::from(&args[0]);
        let expected_manifest = paths
            .manifests
            .iter()
            .find(|target| target.family == ManifestFamily::Firefox)
            .map(|target| &target.path);
        if !manifest_path.is_absolute() || Some(&manifest_path) != expected_manifest {
            return Err(CompanionError::new("unexpected Firefox manifest path"));
        }
        let extension_id = args[1]
            .to_str()
            .ok_or_else(|| CompanionError::new("Firefox caller ID must be UTF-8"))?;
        if !allowlist
            .firefox
            .iter()
            .any(|allowed| allowed == extension_id)
        {
            return Err(CompanionError::new("Firefox caller is not allowlisted"));
        }
        return Ok(BrowserCaller::Firefox {
            extension_id: extension_id.into(),
        });
    }

    Err(CompanionError::new("missing or malformed browser caller"))
}
