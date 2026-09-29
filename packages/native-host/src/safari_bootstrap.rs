//! Static-library entry point for the signed Safari XPC service.
//!
//! This is not a Native Messaging argv mode. The embedding service MUST verify
//! the caller's Apple Team, extension identifier, App Group, and user before
//! invoking this function. No identity or endpoint path is accepted from JSON.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::canonical::base64url_decode;
use crate::resolve::{
    ProbeError, ResolveDeps, ResolveError, ResolveResult, probe_endpoint, resolve_endpoint,
};
use crate::runtime::SystemResolveDeps;
use crate::ticket::{TICKET_LIFETIME_SECONDS, TicketInputs, mint_ticket};
use crate::user_data::{native_host_bridge_data_dir, native_host_user_data_dir};

const MAX_BYTES: usize = 16 * 1024;
const SAFARI_CALLER_ID: &str = "app.motrix.safari.extension";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    action: String,
    protocol_version: u32,
    binding_pub: String,
    allow_launch: bool,
}

fn error(code: &str) -> Value {
    json!({"error": code, "protocolVersion": 1})
}

fn resolve<D: ResolveDeps>(
    request: &[u8],
    deps: &mut D,
    now: Option<u64>,
    bridge_not_running: &mut bool,
) -> Value {
    *bridge_not_running = false;
    let Ok(request) = serde_json::from_slice::<Request>(request) else {
        return error("invalid-request");
    };
    let binding: Option<[u8; 32]> =
        base64url_decode(&request.binding_pub).and_then(|bytes| bytes.try_into().ok());
    let Some(binding) = binding else {
        return error("invalid-request");
    };
    if request.action != "bootstrap" || request.protocol_version != 1 {
        return error("invalid-request");
    }
    let resolved = if request.allow_launch {
        // Preserve the original v1 ABI's explicit launch behavior.
        match resolve_endpoint(true, deps) {
            Ok(resolved) => resolved,
            Err(ResolveError::NotRunning) => return error("bootstrap-unavailable"),
            Err(ResolveError::NotInstalled | ResolveError::LaunchFailed) => {
                return error("launch-denied");
            }
        }
    } else {
        match probe_endpoint(deps) {
            Ok(resolved) => resolved,
            Err(reason) => {
                *bridge_not_running = reason == ProbeError::NotRunning;
                return error("bootstrap-unavailable");
            }
        }
    };
    // Missing owner-checked attestation material must never create an identity.
    let ticket = (|| {
        let token = resolved
            .endpoint
            .local_token
            .as_deref()
            .filter(|v| !v.is_empty())?;
        let generation = resolved.endpoint.generation.as_deref().filter(|v| {
            !v.is_empty() && v.len() <= 256 && v.bytes().all(|b| (32..=126).contains(&b))
        })?;
        let exp = now?.checked_add(TICKET_LIFETIME_SECONDS)?;
        Some(mint_ticket(
            token,
            &TicketInputs {
                server_generation: generation,
                browser: "safari",
                caller_id: SAFARI_CALLER_ID,
                exp,
                binding_pub: &binding,
            },
        ))
    })();
    let response = match ticket {
        Some(ticket) => {
            ResolveResult::request_pair_with_ticket(resolved.endpoint.port, resolved.nonce, ticket)
        }
        None => ResolveResult::request_pair(resolved.endpoint.port, resolved.nonce),
    };
    serde_json::to_value(response).unwrap_or_else(|_| error("bootstrap-unavailable"))
}

/// Resolve one authenticated Safari request into a caller-owned response buffer.
/// Returns bytes written, or zero if buffers or response capacity are invalid.
/// The service must serialize calls and enforce its own request deadline.
///
/// # Safety
/// `request` must point to `request_len` readable bytes, `response` must point to
/// `response_capacity` writable bytes, and their storage must not overlap.
/// Both buffers must remain valid for the duration of this synchronous call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn motrix_safari_bootstrap_v1(
    request: *const u8,
    request_len: usize,
    response: *mut u8,
    response_capacity: usize,
) -> usize {
    // SAFETY: the caller provides the same buffer contract as the v2 entry point.
    unsafe { motrix_safari_bootstrap_v2(request, request_len, response, response_capacity) }
        .response_len
}

/// Private desktop ABI metadata; the JSON/XPC response stays at protocol v1.
#[repr(C)]
#[derive(Default)]
pub struct SafariBootstrapResult {
    pub response_len: usize,
    pub bridge_not_running: u8,
}

/// Resolve one request, preserving whether discovery found no running bridge.
/// Only that state permits the Swift desktop owner to launch or poll again.
///
/// # Safety
/// The input/output buffers must satisfy the same contract as `motrix_safari_bootstrap_v1`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn motrix_safari_bootstrap_v2(
    request: *const u8,
    request_len: usize,
    response: *mut u8,
    response_capacity: usize,
) -> SafariBootstrapResult {
    if request.is_null()
        || response.is_null()
        || request_len == 0
        || request_len > MAX_BYTES
        || response_capacity < MAX_BYTES
    {
        return SafariBootstrapResult::default();
    }
    // SAFETY: the embedding service owns separate, valid buffers per the ABI.
    let request = unsafe { std::slice::from_raw_parts(request, request_len) };
    let user_data = native_host_user_data_dir();
    let bridge_data = native_host_bridge_data_dir(user_data.as_deref());
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data.as_deref());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|time| time.as_secs());
    let mut bridge_not_running = false;
    let result = resolve(request, &mut deps, now, &mut bridge_not_running);
    let Ok(bytes) = serde_json::to_vec(&result) else {
        return SafariBootstrapResult::default();
    };
    if bytes.len() > MAX_BYTES {
        return SafariBootstrapResult::default();
    }
    // SAFETY: output has sufficient capacity and does not alias the input.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), response, bytes.len()) };
    SafariBootstrapResult {
        response_len: bytes.len(),
        bridge_not_running: u8::from(bridge_not_running),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::base64url_encode;
    use crate::endpoint::EndpointFile;
    use std::time::{Duration, Instant};

    struct Deps {
        endpoint: Option<EndpointFile>,
        nonce_calls: usize,
        launch_calls: usize,
        nonce_available: bool,
    }
    impl ResolveDeps for Deps {
        fn read_endpoint(&mut self) -> Option<EndpointFile> {
            self.endpoint.clone()
        }
        fn probe_liveness(&mut self, _: u16, _: Duration) -> bool {
            true
        }
        fn fetch_nonce(&mut self, _: u16, _: Duration) -> Option<String> {
            self.nonce_calls += 1;
            self.nonce_available.then(|| "nonce".into())
        }
        fn launch(&mut self) -> bool {
            self.launch_calls += 1;
            false
        }
        fn now(&self) -> Instant {
            Instant::now()
        }
        fn sleep(&mut self, _: Duration) {
            panic!("unexpected launch poll")
        }
    }
    fn deps() -> Deps {
        Deps {
            endpoint: Some(EndpointFile {
                port: 16802,
                local_token: Some("private-token".into()),
                generation: Some("generation".into()),
            }),
            nonce_calls: 0,
            launch_calls: 0,
            nonce_available: true,
        }
    }
    fn request() -> Value {
        json!({"action":"bootstrap", "protocolVersion":1, "bindingPub":base64url_encode(&[7;32]), "allowLaunch":false})
    }
    fn call(request: Value, deps: &mut Deps) -> Value {
        resolve(
            &serde_json::to_vec(&request).unwrap(),
            deps,
            Some(1000),
            &mut false,
        )
    }

    #[test]
    fn nonce_refusal_is_terminal_while_missing_bridge_allows_wake() {
        for missing in [false, true] {
            let mut deps = deps();
            deps.nonce_available = false;
            if missing {
                deps.endpoint = None;
            }
            let mut bridge_not_running = false;
            let result = resolve(
                &serde_json::to_vec(&request()).unwrap(),
                &mut deps,
                Some(1000),
                &mut bridge_not_running,
            );
            assert_eq!(result, error("bootstrap-unavailable"));
            assert_eq!(bridge_not_running, missing);
            assert_eq!(deps.nonce_calls, usize::from(!missing));
            assert_eq!(deps.launch_calls, 0);
        }
    }

    #[test]
    fn signed_service_identity_is_fixed_and_bound_without_exposing_local_token() {
        let mut deps = deps();
        let result = call(request(), &mut deps);
        let expected = mint_ticket(
            "private-token",
            &TicketInputs {
                server_generation: "generation",
                browser: "safari",
                caller_id: SAFARI_CALLER_ID,
                exp: 1060,
                binding_pub: &[7; 32],
            },
        );
        assert_eq!(result["nmTicket"], serde_json::to_value(expected).unwrap());
        assert!(!result.to_string().contains("private-token"));
        assert_eq!(deps.nonce_calls, 1);
        assert_eq!(deps.launch_calls, 0);
    }
    #[test]
    fn claimed_identity_paths_and_nonboolean_launch_are_rejected_before_io() {
        for (key, value) in [
            ("callerId", json!("other")),
            ("browser", json!("chromium")),
            ("bridgeDataDir", json!("/tmp")),
            ("allowLaunch", json!("true")),
            ("protocolVersion", json!(2)),
            ("bindingPub", json!("invalid")),
        ] {
            let mut request = request();
            request[key] = value;
            let mut deps = deps();
            assert_eq!(call(request, &mut deps), error("invalid-request"));
            assert_eq!(deps.nonce_calls, 0);
            assert_eq!(deps.launch_calls, 0);
        }
    }
    #[test]
    fn missing_attestation_material_stays_ticketless() {
        for endpoint in [
            EndpointFile {
                port: 16802,
                local_token: None,
                generation: Some("g".into()),
            },
            EndpointFile {
                port: 16802,
                local_token: Some("t".into()),
                generation: Some("\u{4e2d}".into()),
            },
        ] {
            let mut deps = deps();
            deps.endpoint = Some(endpoint);
            let result = call(request(), &mut deps);
            assert_eq!(result["action"], "requestPair");
            assert!(result.get("nmTicket").is_none());
        }
    }
    #[test]
    fn launch_requires_explicit_boolean_and_errors_remain_versioned() {
        let mut deps = deps();
        deps.endpoint = None;
        assert_eq!(call(request(), &mut deps), error("bootstrap-unavailable"));
        assert_eq!(deps.launch_calls, 0);
        let mut request = request();
        request["allowLaunch"] = json!(true);
        assert_eq!(call(request, &mut deps), error("launch-denied"));
        assert_eq!(deps.launch_calls, 1);
    }
    #[test]
    fn safari_is_not_an_argv_native_messaging_identity() {
        assert!(
            crate::caller::extract_caller_identity(["safari-web-extension://ABC/".into()])
                .is_none()
        );
    }
    #[test]
    fn ffi_invalid_buffers_return_zero_without_dereferencing() {
        let mut output = [0_u8; MAX_BYTES];
        // SAFETY: null/oversized input is rejected before dereference.
        assert_eq!(
            unsafe {
                motrix_safari_bootstrap_v1(std::ptr::null(), 1, output.as_mut_ptr(), output.len())
            },
            0
        );
        let input = b"{}";
        // SAFETY: the real buffers are valid and disjoint; capacity is insufficient.
        assert_eq!(
            unsafe {
                motrix_safari_bootstrap_v1(input.as_ptr(), input.len(), output.as_mut_ptr(), 1)
            },
            0
        );
    }
}
