use std::cmp::min;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::endpoint::EndpointFile;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
pub const LAUNCH_POLL_TIMEOUT: Duration = Duration::from_secs(15);
pub const LAUNCH_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ResolveResult {
    RequestPair {
        action: &'static str,
        port: u16,
        nonce: String,
    },
    Error {
        error: ResolveError,
    },
}

impl ResolveResult {
    pub fn request_pair(port: u16, nonce: String) -> Self {
        Self::RequestPair {
            action: "requestPair",
            port,
            nonce,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ResolveError {
    #[serde(rename = "motrix-not-running")]
    NotRunning,
    #[serde(rename = "motrix-not-installed")]
    NotInstalled,
    #[serde(rename = "motrix-launch-failed")]
    LaunchFailed,
}

pub trait ResolveDeps {
    fn read_endpoint(&mut self) -> Option<EndpointFile>;
    fn probe(&mut self, port: u16, timeout: Duration) -> Option<String>;
    fn launch(&mut self) -> bool;
    fn now(&self) -> Instant;
    fn sleep(&mut self, duration: Duration);
}

pub fn resolve_endpoint<D: ResolveDeps>(allow_launch: bool, deps: &mut D) -> ResolveResult {
    if let Some(endpoint) = deps.read_endpoint()
        && let Some(nonce) = deps.probe(endpoint.port, PROBE_TIMEOUT)
    {
        return ResolveResult::request_pair(endpoint.port, nonce);
    }

    if !allow_launch {
        return ResolveResult::Error {
            error: ResolveError::NotRunning,
        };
    }
    if !deps.launch() {
        return ResolveResult::Error {
            error: ResolveError::NotInstalled,
        };
    }

    match poll_launched_endpoint(deps, LAUNCH_POLL_TIMEOUT, LAUNCH_POLL_INTERVAL) {
        Some((port, nonce)) => ResolveResult::request_pair(port, nonce),
        None => ResolveResult::Error {
            error: ResolveError::LaunchFailed,
        },
    }
}

pub fn poll_launched_endpoint<D: ResolveDeps>(
    deps: &mut D,
    timeout: Duration,
    interval: Duration,
) -> Option<(u16, String)> {
    let deadline = deps.now().checked_add(timeout)?;

    loop {
        let remaining = deadline.saturating_duration_since(deps.now());
        if remaining.is_zero() {
            return None;
        }

        if let Some(endpoint) = deps.read_endpoint() {
            let probe_budget = min(
                PROBE_TIMEOUT,
                deadline.saturating_duration_since(deps.now()),
            );
            if probe_budget.is_zero() {
                return None;
            }
            if let Some(nonce) = deps.probe(endpoint.port, probe_budget) {
                return Some((endpoint.port, nonce));
            }
        }

        let remaining = deadline.saturating_duration_since(deps.now());
        if remaining.is_zero() {
            return None;
        }
        deps.sleep(min(interval, remaining));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};

    use super::{
        LAUNCH_POLL_INTERVAL, LAUNCH_POLL_TIMEOUT, PROBE_TIMEOUT, ResolveDeps, ResolveError,
        ResolveResult, poll_launched_endpoint, resolve_endpoint,
    };
    use crate::endpoint::EndpointFile;

    struct FakeDeps {
        endpoints: VecDeque<Option<EndpointFile>>,
        probes: VecDeque<Option<String>>,
        launch_result: bool,
        launch_calls: usize,
        probe_calls: Vec<(u16, Duration)>,
        elapsed: Duration,
        probe_cost: Duration,
        sleeps: Vec<Duration>,
        origin: Instant,
    }

    impl FakeDeps {
        fn new() -> Self {
            Self {
                endpoints: VecDeque::new(),
                probes: VecDeque::new(),
                launch_result: true,
                launch_calls: 0,
                probe_calls: Vec::new(),
                elapsed: Duration::ZERO,
                probe_cost: Duration::ZERO,
                sleeps: Vec::new(),
                origin: Instant::now(),
            }
        }
    }

    impl ResolveDeps for FakeDeps {
        fn read_endpoint(&mut self) -> Option<EndpointFile> {
            self.endpoints.pop_front().flatten()
        }

        fn probe(&mut self, port: u16, timeout: Duration) -> Option<String> {
            self.probe_calls.push((port, timeout));
            self.elapsed += self.probe_cost.min(timeout);
            self.probes.pop_front().flatten()
        }

        fn launch(&mut self) -> bool {
            self.launch_calls += 1;
            self.launch_result
        }

        fn now(&self) -> Instant {
            self.origin + self.elapsed
        }

        fn sleep(&mut self, duration: Duration) {
            self.sleeps.push(duration);
            self.elapsed += duration;
        }
    }

    fn endpoint(port: u16) -> Option<EndpointFile> {
        Some(EndpointFile {
            port,
            local_token: None,
            generation: None,
        })
    }

    #[test]
    fn live_endpoint_returns_pair_response_without_launching() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.probes.push_back(Some("nonce-live".into()));

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            ResolveResult::request_pair(100, "nonce-live".into())
        );
        assert_eq!(deps.launch_calls, 0);
        assert_eq!(deps.probe_calls, vec![(100, PROBE_TIMEOUT)]);
    }

    #[test]
    fn dead_endpoint_without_user_intent_never_launches() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.probes.push_back(None);

        assert_eq!(
            resolve_endpoint(false, &mut deps),
            ResolveResult::Error {
                error: ResolveError::NotRunning
            }
        );
        assert_eq!(deps.launch_calls, 0);
    }

    #[test]
    fn reports_not_installed_when_launcher_cannot_start_motrix() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(None);
        deps.launch_result = false;

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            ResolveResult::Error {
                error: ResolveError::NotInstalled
            }
        );
        assert_eq!(deps.launch_calls, 1);
    }

    #[test]
    fn launch_poll_rereads_endpoint_and_returns_fresh_port_and_nonce() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(None);
        deps.endpoints.push_back(None);
        deps.endpoints.push_back(endpoint(200));
        deps.probes.push_back(Some("nonce-new".into()));

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            ResolveResult::request_pair(200, "nonce-new".into())
        );
        assert_eq!(deps.launch_calls, 1);
        assert_eq!(deps.sleeps, vec![LAUNCH_POLL_INTERVAL]);
    }

    #[test]
    fn launch_poll_uses_absolute_deadline_without_final_overshoot() {
        let mut deps = FakeDeps::new();
        deps.probe_cost = PROBE_TIMEOUT;
        deps.endpoints.push_back(None); // Initial liveness check.
        for _ in 0..32 {
            deps.endpoints.push_back(endpoint(300));
            deps.probes.push_back(None);
        }

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            ResolveResult::Error {
                error: ResolveError::LaunchFailed
            }
        );
        assert_eq!(deps.elapsed, LAUNCH_POLL_TIMEOUT);
        assert!(
            deps.probe_calls
                .iter()
                .all(|(_, budget)| *budget <= PROBE_TIMEOUT)
        );
    }

    #[test]
    fn zero_timeout_poll_does_not_read_or_probe() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(42));
        deps.probes.push_back(Some("unused".into()));
        assert_eq!(
            poll_launched_endpoint(&mut deps, Duration::ZERO, Duration::from_millis(1)),
            None
        );
        assert!(deps.probe_calls.is_empty());
        assert_eq!(deps.endpoints.len(), 1);
    }
}
