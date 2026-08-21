use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use crate::endpoint::{EndpointFile, read_endpoint};
use crate::launcher::launch_motrix;
use crate::probe::fetch_nonce;
use crate::resolve::{
    LAUNCH_POLL_INTERVAL, LAUNCH_POLL_TIMEOUT, PROBE_TIMEOUT, ResolveDeps, ResolveError,
    ResolveResult, poll_launched_endpoint, resolve_endpoint,
};
use crate::user_data::bridge_endpoint_path;

/// Production dependencies shared by the direct Native Messaging host and the
/// Flatpak broker. The broker only calls the probe/poll functions below, so it
/// never exercises the launch capability.
pub struct SystemResolveDeps {
    endpoint_path: Option<PathBuf>,
}

impl SystemResolveDeps {
    pub fn from_bridge_data(bridge_data: Option<&Path>) -> Self {
        Self {
            endpoint_path: bridge_data.map(bridge_endpoint_path),
        }
    }
}

impl ResolveDeps for SystemResolveDeps {
    fn read_endpoint(&mut self) -> Option<EndpointFile> {
        self.endpoint_path.as_deref().and_then(read_endpoint)
    }

    fn probe(&mut self, port: u16, timeout: Duration) -> Option<String> {
        fetch_nonce(port, timeout)
    }

    fn launch(&mut self) -> bool {
        launch_motrix()
    }

    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&mut self, duration: Duration) {
        thread::sleep(duration);
    }
}

pub fn resolve_direct(allow_launch: bool, bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    resolve_endpoint(allow_launch, &mut deps)
}

pub fn probe_bridge(bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    if let Some(endpoint) = deps.read_endpoint()
        && let Some(nonce) = deps.probe(endpoint.port, PROBE_TIMEOUT)
    {
        return ResolveResult::request_pair(endpoint.port, nonce);
    }
    ResolveResult::Error {
        error: ResolveError::NotRunning,
    }
}

pub fn wait_for_bridge(bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    match poll_launched_endpoint(&mut deps, LAUNCH_POLL_TIMEOUT, LAUNCH_POLL_INTERVAL) {
        Some((port, nonce)) => ResolveResult::request_pair(port, nonce),
        None => ResolveResult::Error {
            error: ResolveError::LaunchFailed,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::probe_bridge;
    use crate::resolve::{ResolveError, ResolveResult};

    #[test]
    fn missing_bridge_fails_without_launching() {
        assert_eq!(
            probe_bridge(None),
            ResolveResult::Error {
                error: ResolveError::NotRunning,
            }
        );
    }
}
