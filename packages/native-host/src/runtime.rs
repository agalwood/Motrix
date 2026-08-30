use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use crate::endpoint::{EndpointFile, read_endpoint};
use crate::launcher::launch_motrix;
use crate::probe::{fetch_nonce, probe_liveness};
use crate::resolve::{
    LAUNCH_POLL_INTERVAL, LAUNCH_POLL_TIMEOUT, ResolveDeps, ResolveError, ResolveResult,
    poll_launched_endpoint, resolve_endpoint,
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

    fn probe_liveness(&mut self, port: u16, timeout: Duration) -> bool {
        probe_liveness(port, timeout)
    }

    fn fetch_nonce(&mut self, port: u16, timeout: Duration) -> Option<String> {
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

// There is deliberately no general-purpose `resolve_direct` helper here.
//
// One existed and was deleted: a `pub fn resolve_direct(allow_launch,
// bridge_data)` that resolved the endpoint and answered
// `ResolveResult::request_pair(..)`. It had no callers, and it was a trap
// rather than merely dead code. `main.rs`'s live path does the same
// resolution but branches on `HostRequest::Bootstrap` to mint a §9.2 ticket
// and answers `request_pair_with_ticket`. So the deleted helper read as a
// tidier, better-named version of that block while silently dropping
// attestation — a future refactor replacing `main.rs` with a call to it would
// type-check, read cleanly, keep every unit test green, and make every
// extension resolve to `unverified`, putting the `official` /
// `attested-non-official` tiers permanently out of reach. Only the three
// integration tests would have caught it.
//
// If a ticketless direct resolve is ever genuinely wanted, write it at the
// call site where the ticketless choice is visible, the way `probe_bridge`
// below does.

/// The broker's `Probe` operation: resolve the recorded endpoint without any
/// launch capability, since only the host-side companion can start a Flatpak
/// app. Delegating to [`resolve_endpoint`] with `allow_launch = false` keeps
/// the "liveness, then exactly one nonce" sequence in one place instead of
/// mirroring it here, where it could drift.
///
/// Deliberately ticketless (`request_pair`, never `request_pair_with_ticket`):
/// the broker has no caller identity to attest — the browser talks to the
/// companion, not to it — so the reply resolves to `unverified` by design.
///
/// A live bridge that refuses a nonce reports `NotRunning`, which the
/// companion cannot distinguish from a bridge that is down, so it will launch
/// and call `WaitForEndpoint`, fetching a second nonce. Bounded (two per
/// resolution, never a loop) but real; removing it needs a broker-protocol
/// response that separates the two, which the current versioned stdio
/// contract cannot express without breaking older companions.
pub fn probe_bridge(bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    match resolve_endpoint(false, &mut deps) {
        Ok(resolved) => ResolveResult::request_pair(resolved.endpoint.port, resolved.nonce),
        Err(_) => ResolveResult::Error {
            error: ResolveError::NotRunning,
        },
    }
}

pub fn wait_for_bridge(bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    match poll_launched_endpoint(&mut deps, LAUNCH_POLL_TIMEOUT, LAUNCH_POLL_INTERVAL) {
        Some(resolved) => ResolveResult::request_pair(resolved.endpoint.port, resolved.nonce),
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
