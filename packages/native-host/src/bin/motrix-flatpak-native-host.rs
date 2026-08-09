use std::ffi::OsString;
use std::process::ExitCode;

use motrix_native_host::flatpak_companion::{CompanionCommand, parse_companion_command};
#[cfg(target_os = "linux")]
use motrix_native_host::flatpak_companion::{
    companion_status, current_companion_paths, embedded_allowlist, uninstall_companion,
};

const HELP: &str = "\
Motrix Flatpak Native Messaging companion

Usage:
  motrix-flatpak-native-host install [--flatpak-bin /absolute/path] [--force]
  motrix-flatpak-native-host status
  motrix-flatpak-native-host uninstall
  motrix-flatpak-native-host --help
  motrix-flatpak-native-host --version

Browser Native Messaging mode is reserved for validated browser caller arguments.
";

#[cfg(target_os = "linux")]
fn run_browser(args: &[OsString]) -> Result<ExitCode, String> {
    use std::io::{self, Read};

    use motrix_native_host::flatpak_companion::{
        FlatpakProcessRuntime, load_companion_config, resolve_flatpak_request,
        validate_browser_caller,
    };
    use motrix_native_host::parse_allow_launch;
    use motrix_native_host::protocol::{
        INPUT_TIMEOUT, MAX_MESSAGE_BYTES, read_message_with_timeout, write_message,
    };
    use motrix_native_host::resolve::{ResolveError, ResolveResult};

    let paths = current_companion_paths().map_err(|error| error.to_string())?;
    let allowlist = embedded_allowlist().map_err(|error| error.to_string())?;
    validate_browser_caller(args, &allowlist, &paths).map_err(|error| error.to_string())?;

    let input = read_message_with_timeout(io::stdin(), INPUT_TIMEOUT)
        .map_err(|error| format!("read Native Messaging request: {error}"))?;
    let allow_launch = parse_allow_launch(&input)
        .ok_or_else(|| "Native Messaging request must be a JSON object or array".to_owned())?;

    let current_executable =
        std::env::current_exe().map_err(|error| format!("resolve current executable: {error}"))?;
    let result = match load_companion_config(&paths, &current_executable) {
        Ok(config) => {
            let mut runtime = FlatpakProcessRuntime::new(config.flatpak_bin().to_path_buf());
            resolve_flatpak_request(allow_launch, &mut runtime)
        }
        Err(error) => {
            eprintln!("motrix-flatpak-native-host: unavailable installation: {error}");
            ResolveResult::Error {
                error: ResolveError::NotInstalled,
            }
        }
    };

    let stdout = io::stdout();
    write_message(&mut stdout.lock(), &result)
        .map_err(|error| format!("write Native Messaging response: {error}"))?;

    // Match the direct host's one-shot behavior while bounding unexpected
    // trailing input. The response is flushed before waiting for browser EOF.
    let stdin = io::stdin();
    let mut stdin_lock = stdin.lock();
    let mut trailing = stdin_lock
        .by_ref()
        .take((MAX_MESSAGE_BYTES.saturating_add(1)) as u64);
    let _ = io::copy(&mut trailing, &mut io::sink());
    Ok(ExitCode::SUCCESS)
}

#[cfg(not(target_os = "linux"))]
fn run_browser(_args: &[OsString]) -> Result<ExitCode, String> {
    Err("the Flatpak companion is only supported on Linux".into())
}

#[cfg(target_os = "linux")]
fn run_command(command: CompanionCommand, args: &[OsString]) -> Result<ExitCode, String> {
    use motrix_native_host::flatpak_companion::install_companion;

    match command {
        CompanionCommand::Browser => run_browser(args),
        CompanionCommand::Install { flatpak_bin, force } => {
            let paths = current_companion_paths().map_err(|error| error.to_string())?;
            let allowlist = embedded_allowlist().map_err(|error| error.to_string())?;
            let executable = std::env::current_exe()
                .map_err(|error| format!("resolve current executable: {error}"))?;
            install_companion(&paths, &executable, &flatpak_bin, &allowlist, force)
                .map_err(|error| error.to_string())?;
            println!("installed {}", paths.binary.display());
            Ok(ExitCode::SUCCESS)
        }
        CompanionCommand::Status => {
            let paths = current_companion_paths().map_err(|error| error.to_string())?;
            let allowlist = embedded_allowlist().map_err(|error| error.to_string())?;
            let status = companion_status(&paths, &allowlist);
            if status.installed {
                println!("installed");
                Ok(ExitCode::SUCCESS)
            } else {
                println!("not installed");
                for issue in status.issues {
                    println!("- {issue}");
                }
                Ok(ExitCode::FAILURE)
            }
        }
        CompanionCommand::Uninstall => {
            let paths = current_companion_paths().map_err(|error| error.to_string())?;
            uninstall_companion(&paths).map_err(|error| error.to_string())?;
            println!("uninstalled");
            Ok(ExitCode::SUCCESS)
        }
        CompanionCommand::Help => {
            print!("{HELP}");
            Ok(ExitCode::SUCCESS)
        }
        CompanionCommand::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(ExitCode::SUCCESS)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run_command(command: CompanionCommand, args: &[OsString]) -> Result<ExitCode, String> {
    match command {
        CompanionCommand::Help => {
            print!("{HELP}");
            Ok(ExitCode::SUCCESS)
        }
        CompanionCommand::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(ExitCode::SUCCESS)
        }
        CompanionCommand::Browser => run_browser(args),
        CompanionCommand::Install { .. }
        | CompanionCommand::Status
        | CompanionCommand::Uninstall => {
            Err("the Flatpak companion is only supported on Linux".into())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let command = match parse_companion_command(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("motrix-flatpak-native-host: {error}");
            eprintln!("{HELP}");
            return ExitCode::from(2);
        }
    };
    match run_command(command, &args) {
        Ok(status) => status,
        Err(error) => {
            eprintln!("motrix-flatpak-native-host: {error}");
            ExitCode::FAILURE
        }
    }
}
