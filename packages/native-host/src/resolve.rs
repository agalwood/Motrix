use std::cmp::min;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::endpoint::EndpointFile;
use crate::ticket::NmTicket;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
pub const LAUNCH_POLL_TIMEOUT: Duration = Duration::from_secs(15);
pub const LAUNCH_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// NM wire protocol version (`docs/bridge-pairing-protocol.md` §9.1), echoed
/// in every `requestPair` reply. Distinct from [`crate::ticket::TICKET_PROTOCOL_VERSION`]:
/// the two happen to share the same value in v1, but one names the outer NM
/// exchange and the other is a MAC-covered ticket field.
pub const NM_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ResolveResult {
    RequestPair {
        action: &'static str,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        port: u16,
        nonce: String,
        #[serde(rename = "nmTicket", skip_serializing_if = "Option::is_none")]
        nm_ticket: Option<NmTicket>,
    },
    Error {
        error: ResolveError,
    },
}

impl ResolveResult {
    /// A ticketless `requestPair` reply (legacy callers, or a bootstrap
    /// caller missing a trusted input for minting).
    pub fn request_pair(port: u16, nonce: String) -> Self {
        Self::RequestPair {
            action: "requestPair",
            protocol_version: NM_PROTOCOL_VERSION,
            port,
            nonce,
            nm_ticket: None,
        }
    }

    /// A `requestPair` reply carrying a minted NM attestation ticket (§9.1).
    pub fn request_pair_with_ticket(port: u16, nonce: String, ticket: NmTicket) -> Self {
        Self::RequestPair {
            action: "requestPair",
            protocol_version: NM_PROTOCOL_VERSION,
            port,
            nonce,
            nm_ticket: Some(ticket),
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

/// A `endpoint.json` whose recorded port answered a liveness probe and then
/// yielded a fresh one-shot nonce.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedEndpoint {
    pub endpoint: EndpointFile,
    pub nonce: String,
}

pub trait ResolveDeps {
    fn read_endpoint(&mut self) -> Option<EndpointFile>;
    /// Cheap, unauthenticated, Motrix-shaped liveness check (spec §4.1
    /// `GET /discovery`). Callers probe this on every poll iteration; it
    /// never consumes a nonce.
    fn probe_liveness(&mut self, port: u16, timeout: Duration) -> bool;
    /// One-shot nonce acquisition (spec §4.2 `POST /nonce`). Callers must
    /// call this only once liveness is already known, and at most once per
    /// resolution — the server caps outstanding nonces and rate-limits
    /// issuance.
    fn fetch_nonce(&mut self, port: u16, timeout: Duration) -> Option<String>;
    fn launch(&mut self) -> bool;
    fn now(&self) -> Instant;
    fn sleep(&mut self, duration: Duration);
}

/// Resolves the recorded endpoint, launching Motrix first when the caller
/// allows it and the bridge is not already up.
///
/// A successful liveness probe settles the whole resolution: the bridge is
/// running, so there is nothing to launch, and the single [`ResolveDeps::
/// fetch_nonce`] call that follows is the only one this resolution makes —
/// whichever way it goes. Falling through to `launch()` after a failed nonce
/// fetch would fetch a second nonce from `poll_launched_endpoint` and wake an
/// app that is already awake, and it would do so in precisely the state where
/// that is most harmful: `fetch_nonce` answers `None` for any non-2xx reply,
/// which is what the §4.2 outstanding-nonce cap and issuance rate limit
/// return. A retry there amplifies the load that caused the refusal.
///
/// `NotRunning` is therefore also what a live bridge that will not issue a
/// nonce reports, matching what `allow_launch = false` already returned for
/// that state: the flag decides whether to launch, not what a nonce failure
/// means. The three-code NM error vocabulary (§9.1) has no "running but
/// unavailable" member, and `NotRunning` is the one that keeps the caller's
/// remedy — try again — correct.
pub fn resolve_endpoint<D: ResolveDeps>(
    allow_launch: bool,
    deps: &mut D,
) -> Result<ResolvedEndpoint, ResolveError> {
    if let Some(endpoint) = deps.read_endpoint()
        && deps.probe_liveness(endpoint.port, PROBE_TIMEOUT)
    {
        return deps
            .fetch_nonce(endpoint.port, PROBE_TIMEOUT)
            .map(|nonce| ResolvedEndpoint { endpoint, nonce })
            .ok_or(ResolveError::NotRunning);
    }

    if !allow_launch {
        return Err(ResolveError::NotRunning);
    }
    if !deps.launch() {
        return Err(ResolveError::NotInstalled);
    }

    poll_launched_endpoint(deps, LAUNCH_POLL_TIMEOUT, LAUNCH_POLL_INTERVAL)
        .ok_or(ResolveError::LaunchFailed)
}

pub fn poll_launched_endpoint<D: ResolveDeps>(
    deps: &mut D,
    timeout: Duration,
    interval: Duration,
) -> Option<ResolvedEndpoint> {
    let deadline = deps.now().checked_add(timeout)?;

    loop {
        let remaining = deadline.saturating_duration_since(deps.now());
        if remaining.is_zero() {
            return None;
        }

        if let Some(endpoint) = deps.read_endpoint() {
            let liveness_budget = min(
                PROBE_TIMEOUT,
                deadline.saturating_duration_since(deps.now()),
            );
            if liveness_budget.is_zero() {
                return None;
            }
            if deps.probe_liveness(endpoint.port, liveness_budget) {
                // The bridge is alive: fetch exactly one nonce, bounded by
                // whatever deadline remains, and return either way — wake
                // polling must never burn more than one nonce per launch.
                let nonce_budget = min(
                    PROBE_TIMEOUT,
                    deadline.saturating_duration_since(deps.now()),
                );
                if nonce_budget.is_zero() {
                    return None;
                }
                return deps
                    .fetch_nonce(endpoint.port, nonce_budget)
                    .map(|nonce| ResolvedEndpoint { endpoint, nonce });
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
        LAUNCH_POLL_TIMEOUT, PROBE_TIMEOUT, ResolveDeps, ResolveError, ResolveResult,
        poll_launched_endpoint, resolve_endpoint,
    };
    use crate::endpoint::EndpointFile;

    struct FakeDeps {
        endpoints: VecDeque<Option<EndpointFile>>,
        liveness: VecDeque<bool>,
        nonces: VecDeque<Option<String>>,
        launch_result: bool,
        launch_calls: usize,
        liveness_calls: Vec<(u16, Duration)>,
        nonce_calls: Vec<(u16, Duration)>,
        elapsed: Duration,
        probe_cost: Duration,
        sleeps: Vec<Duration>,
        origin: Instant,
    }

    impl FakeDeps {
        fn new() -> Self {
            Self {
                endpoints: VecDeque::new(),
                liveness: VecDeque::new(),
                nonces: VecDeque::new(),
                launch_result: true,
                launch_calls: 0,
                liveness_calls: Vec::new(),
                nonce_calls: Vec::new(),
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

        fn probe_liveness(&mut self, port: u16, timeout: Duration) -> bool {
            self.liveness_calls.push((port, timeout));
            self.elapsed += self.probe_cost.min(timeout);
            self.liveness.pop_front().unwrap_or(false)
        }

        fn fetch_nonce(&mut self, port: u16, timeout: Duration) -> Option<String> {
            self.nonce_calls.push((port, timeout));
            self.elapsed += self.probe_cost.min(timeout);
            self.nonces.pop_front().flatten()
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
    fn live_endpoint_probes_liveness_then_fetches_one_nonce() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(true);
        deps.nonces.push_back(Some("nonce-live".into()));

        let resolved = resolve_endpoint(true, &mut deps).expect("resolves");
        assert_eq!(resolved.endpoint.port, 100);
        assert_eq!(resolved.nonce, "nonce-live");
        assert_eq!(deps.launch_calls, 0);
        assert_eq!(deps.liveness_calls, vec![(100, PROBE_TIMEOUT)]);
        assert_eq!(deps.nonce_calls.len(), 1);
    }

    #[test]
    fn dead_endpoint_without_user_intent_never_launches() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(false);

        assert_eq!(
            resolve_endpoint(false, &mut deps),
            Err(ResolveError::NotRunning)
        );
        assert_eq!(deps.launch_calls, 0);
        assert!(
            deps.nonce_calls.is_empty(),
            "a dead endpoint never fetches a nonce"
        );
    }

    #[test]
    fn reports_not_installed_when_launcher_cannot_start_motrix() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(None);
        deps.launch_result = false;

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            Err(ResolveError::NotInstalled)
        );
        assert_eq!(deps.launch_calls, 1);
    }

    #[test]
    fn launch_poll_probes_liveness_only_and_fetches_nonce_once_at_the_end() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(None); // initial read: not running
        deps.endpoints.push_back(None); // poll #1: no endpoint yet
        deps.endpoints.push_back(endpoint(200)); // poll #2
        deps.liveness.push_back(true);
        deps.nonces.push_back(Some("nonce-new".into()));

        let resolved = resolve_endpoint(true, &mut deps).expect("resolves");
        assert_eq!(resolved.endpoint.port, 200);
        assert_eq!(resolved.nonce, "nonce-new");
        assert_eq!(deps.launch_calls, 1);
        assert_eq!(
            deps.nonce_calls.len(),
            1,
            "wake polling must not burn nonces"
        );
    }

    #[test]
    fn incompatible_recorded_endpoint_does_not_block_user_requested_launch() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(false);
        deps.endpoints.push_back(endpoint(200));
        deps.liveness.push_back(true);
        deps.nonces.push_back(Some("nonce-new".into()));

        let resolved = resolve_endpoint(true, &mut deps).expect("resolves after launch");
        assert_eq!(resolved.endpoint.port, 200);
        assert_eq!(deps.launch_calls, 1);
        assert_eq!(
            deps.liveness_calls,
            vec![(100, PROBE_TIMEOUT), (200, PROBE_TIMEOUT)]
        );
        assert_eq!(deps.nonce_calls.len(), 1);
    }

    #[test]
    fn live_endpoint_with_failed_nonce_fetch_is_not_a_pair() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(true);
        deps.nonces.push_back(None);
        assert_eq!(
            resolve_endpoint(false, &mut deps),
            Err(ResolveError::NotRunning)
        );
    }

    #[test]
    fn live_endpoint_with_failed_nonce_fetch_never_launches_or_refetches() {
        // The §4.2 outstanding-nonce cap and issuance rate limit answer 429 or
        // 503, which `fetch_nonce` reports as `None` — so this is the state in
        // which a retry would amplify the very load that caused the refusal.
        // A passing liveness probe settles the resolution: one nonce fetch, no
        // launch, whatever the fetch answers.
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(true);
        deps.nonces.push_back(None);
        // Would be consumed by a second attempt, and must not be.
        deps.endpoints.push_back(endpoint(100));
        deps.liveness.push_back(true);
        deps.nonces.push_back(Some("second-nonce".into()));

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            Err(ResolveError::NotRunning)
        );
        assert_eq!(
            deps.nonce_calls.len(),
            1,
            "one resolution must never burn two nonces"
        );
        assert_eq!(
            deps.launch_calls, 0,
            "a live bridge must never be launched again"
        );
    }

    #[test]
    fn launch_poll_uses_absolute_deadline_without_final_overshoot() {
        let mut deps = FakeDeps::new();
        deps.probe_cost = PROBE_TIMEOUT;
        deps.endpoints.push_back(None); // Initial liveness check.
        for _ in 0..32 {
            deps.endpoints.push_back(endpoint(300));
            deps.liveness.push_back(false);
        }

        assert_eq!(
            resolve_endpoint(true, &mut deps),
            Err(ResolveError::LaunchFailed)
        );
        assert_eq!(deps.elapsed, LAUNCH_POLL_TIMEOUT);
        assert!(
            deps.liveness_calls
                .iter()
                .all(|(_, budget)| *budget <= PROBE_TIMEOUT)
        );
        assert!(
            deps.nonce_calls.is_empty(),
            "liveness never succeeded, so no nonce should ever be fetched"
        );
    }

    #[test]
    fn request_pair_serializes_protocol_version_and_omits_absent_ticket() {
        let json = serde_json::to_value(ResolveResult::request_pair(
            55_809,
            "n0nceAbCdEfGhIj".into(),
        ))
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({ "action": "requestPair", "protocolVersion": 1, "port": 55809, "nonce": "n0nceAbCdEfGhIj" })
        );
    }

    #[test]
    fn zero_timeout_poll_does_not_read_or_probe() {
        let mut deps = FakeDeps::new();
        deps.endpoints.push_back(endpoint(42));
        deps.liveness.push_back(true);
        deps.nonces.push_back(Some("unused".into()));
        assert_eq!(
            poll_launched_endpoint(&mut deps, Duration::ZERO, Duration::from_millis(1)),
            None
        );
        assert!(deps.liveness_calls.is_empty());
        assert!(deps.nonce_calls.is_empty());
        assert_eq!(deps.endpoints.len(), 1);
    }
}
