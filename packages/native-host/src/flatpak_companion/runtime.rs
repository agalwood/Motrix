use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use super::{CompanionError, FLATPAK_BROKER_COMMAND, MOTRIX_FLATPAK_ID};
use crate::broker_protocol::{
    BROKER_HEADER_BYTES, BrokerOperation, BrokerRequest, MAX_BROKER_MESSAGE_BYTES,
    decode_broker_response, write_broker_message,
};
use crate::resolve::{ResolveError, ResolveResult};

const PROBE_PROCESS_TIMEOUT: Duration = Duration::from_secs(10);
// The broker's endpoint polling deadline is independently fixed at 15s. Give
// Flatpak process startup enough headroom without extending that security
// boundary on slower hosts.
const WAIT_PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub trait FlatpakRuntime {
    fn call_broker(&mut self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError>;
    fn launch_app(&mut self) -> bool;
}

pub fn resolve_flatpak_request<R: FlatpakRuntime>(
    allow_launch: bool,
    runtime: &mut R,
) -> ResolveResult {
    match runtime.call_broker(BrokerOperation::Probe) {
        Ok(result @ ResolveResult::RequestPair { .. }) => return result,
        Ok(ResolveResult::Error {
            error: ResolveError::NotRunning,
        }) => {}
        Ok(_) | Err(_) if !allow_launch => {
            return ResolveResult::Error {
                error: ResolveError::NotRunning,
            };
        }
        Ok(_) | Err(_) => {
            return ResolveResult::Error {
                error: ResolveError::NotInstalled,
            };
        }
    }

    if !allow_launch {
        return ResolveResult::Error {
            error: ResolveError::NotRunning,
        };
    }
    if !runtime.launch_app() {
        return ResolveResult::Error {
            error: ResolveError::NotInstalled,
        };
    }
    match runtime.call_broker(BrokerOperation::WaitForEndpoint) {
        Ok(result @ ResolveResult::RequestPair { .. }) => result,
        Ok(_) | Err(_) => ResolveResult::Error {
            error: ResolveError::LaunchFailed,
        },
    }
}

pub struct FlatpakProcessRuntime {
    flatpak_bin: PathBuf,
}

impl FlatpakProcessRuntime {
    pub fn new(flatpak_bin: PathBuf) -> Self {
        Self { flatpak_bin }
    }

    fn wait_for_child(
        mut child: std::process::Child,
        timeout: Duration,
    ) -> Result<(ExitStatus, Vec<u8>), CompanionError> {
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new("broker stdout pipe unavailable"));
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        if let Err(error) = thread::Builder::new()
            .name("flatpak-broker-output".into())
            .spawn(move || {
                let mut output = Vec::new();
                let maximum = BROKER_HEADER_BYTES + MAX_BROKER_MESSAGE_BYTES + 1;
                let result = stdout
                    .take(maximum as u64)
                    .read_to_end(&mut output)
                    .map(|_| output);
                let _ = sender.send(result);
            })
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new(format!("spawn output reader: {error}")));
        }

        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| CompanionError::new("broker deadline overflow"))?;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(CHILD_POLL_INTERVAL),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompanionError::new("Flatpak broker timed out"));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CompanionError::new(format!(
                        "wait for Flatpak broker: {error}"
                    )));
                }
            }
        };
        let output = receiver
            .recv_timeout(OUTPUT_DRAIN_TIMEOUT)
            .map_err(|_| CompanionError::new("Flatpak broker stdout did not close"))?
            .map_err(|error| CompanionError::new(format!("read Flatpak broker stdout: {error}")))?;
        if output.len() > BROKER_HEADER_BYTES + MAX_BROKER_MESSAGE_BYTES {
            return Err(CompanionError::new("Flatpak broker output exceeded limit"));
        }
        Ok((status, output))
    }

    fn invoke_broker(&self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError> {
        let mut child = Command::new(&self.flatpak_bin)
            .arg("run")
            .arg(format!("--command={FLATPAK_BROKER_COMMAND}"))
            .arg(MOTRIX_FLATPAK_ID)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| CompanionError::new(format!("start Flatpak broker: {error}")))?;
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new("broker stdin pipe unavailable"));
        };
        if let Err(error) = write_broker_message(&mut stdin, &BrokerRequest { operation }) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CompanionError::new(format!(
                "write broker request: {error}"
            )));
        }
        drop(stdin);
        let timeout = match operation {
            BrokerOperation::Probe => PROBE_PROCESS_TIMEOUT,
            BrokerOperation::WaitForEndpoint => WAIT_PROCESS_TIMEOUT,
        };
        let (status, output) = Self::wait_for_child(child, timeout)?;
        if !status.success() {
            return Err(CompanionError::new(format!(
                "Flatpak broker exited with {status}"
            )));
        }
        let result = decode_broker_response(&output)
            .map_err(|error| CompanionError::new(format!("validate broker response: {error}")))?;
        let expected = matches!(
            (operation, &result),
            (BrokerOperation::Probe, ResolveResult::RequestPair { .. })
                | (
                    BrokerOperation::Probe,
                    ResolveResult::Error {
                        error: ResolveError::NotRunning
                    }
                )
                | (
                    BrokerOperation::WaitForEndpoint,
                    ResolveResult::RequestPair { .. }
                )
                | (
                    BrokerOperation::WaitForEndpoint,
                    ResolveResult::Error {
                        error: ResolveError::LaunchFailed
                    }
                )
        );
        if !expected {
            return Err(CompanionError::new(
                "broker returned a result invalid for the requested operation",
            ));
        }
        Ok(result)
    }
}

impl FlatpakRuntime for FlatpakProcessRuntime {
    fn call_broker(&mut self, operation: BrokerOperation) -> Result<ResolveResult, CompanionError> {
        self.invoke_broker(operation)
    }

    fn launch_app(&mut self) -> bool {
        let mut command = Command::new(&self.flatpak_bin);
        command
            .arg("run")
            .arg(MOTRIX_FLATPAK_ID)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        match command.spawn() {
            Ok(mut child) => {
                thread::spawn(move || {
                    let _ = child.wait();
                });
                true
            }
            Err(_) => false,
        }
    }
}
