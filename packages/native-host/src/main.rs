use std::io::{self, Read};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use motrix_native_host::caller::extract_caller_identity;
use motrix_native_host::endpoint::EndpointFile;
use motrix_native_host::log::NativeHostLogger;
use motrix_native_host::protocol::{
    INPUT_TIMEOUT, MAX_MESSAGE_BYTES, read_message_with_timeout, write_message,
};
use motrix_native_host::resolve::{ResolveResult, resolve_endpoint};
use motrix_native_host::runtime::SystemResolveDeps;
use motrix_native_host::ticket::{NmTicket, TICKET_LIFETIME_SECONDS, TicketInputs, mint_ticket};
use motrix_native_host::user_data::{native_host_bridge_data_dir, native_host_user_data_dir};
use motrix_native_host::{HostRequest, parse_host_request};

/// Mints a ticket for a `bootstrap` request when every trusted input is
/// available (`docs/bridge-pairing-protocol.md` §9.1/§9.2); otherwise
/// returns `None` so the caller replies ticketless. Never fabricates a
/// missing input: an absent caller identity, an absent `localToken` or
/// `generation` (including the case where `endpoint.json` failed its 0600
/// check), or a non-ASCII `serverGeneration` all degrade silently rather
/// than reaching [`mint_ticket`]. A ticketless reply resolves to
/// `unverified` on the server — exactly the outcome of presenting no
/// ticket at all — which is strictly safer than a malformed mint, since a
/// structurally broken ticket aborts the pairing under §9.2's check table.
fn mint_ticket_for_bootstrap(endpoint: &EndpointFile, binding_pub: &[u8; 32]) -> Option<NmTicket> {
    let local_token = endpoint.local_token.as_deref()?;
    let server_generation = endpoint.generation.as_deref()?;
    if !server_generation.is_ascii() {
        // endpoint.json is not fully trusted; a non-ASCII generation must
        // never reach ticket_canonical's ASCII `.expect()`.
        return None;
    }
    let caller = extract_caller_identity(std::env::args().skip(1))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let exp = now.checked_add(TICKET_LIFETIME_SECONDS)?;
    let inputs = TicketInputs {
        server_generation,
        browser: caller.browser,
        caller_id: &caller.caller_id,
        exp,
        binding_pub,
    };
    Some(mint_ticket(local_token, &inputs))
}

fn run() -> ExitCode {
    let user_data = native_host_user_data_dir();
    let bridge_data = native_host_bridge_data_dir(user_data.as_deref());
    let logger = NativeHostLogger::from_bridge_data(bridge_data.as_deref());
    logger.log(&format!(
        "=== spawned argv_count={} ===",
        std::env::args_os().count().saturating_sub(1)
    ));

    let input = match read_message_with_timeout(io::stdin(), INPUT_TIMEOUT) {
        Ok(value) => value,
        Err(error) => {
            logger.log(&format!("read_message failed: {error}; exit 1"));
            return ExitCode::FAILURE;
        }
    };
    let Some(request) = parse_host_request(&input) else {
        logger.log("received malformed JSON value; exit 1");
        return ExitCode::FAILURE;
    };
    let allow_launch = match &request {
        HostRequest::Legacy { allow_launch } | HostRequest::Bootstrap { allow_launch, .. } => {
            *allow_launch
        }
    };
    logger.log(&format!("received start; allowLaunch={allow_launch}"));

    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data.as_deref());
    let result = match resolve_endpoint(allow_launch, &mut deps) {
        Ok(resolved) => {
            let ticket = match &request {
                HostRequest::Bootstrap { binding_pub, .. } => {
                    mint_ticket_for_bootstrap(&resolved.endpoint, binding_pub)
                }
                HostRequest::Legacy { .. } => None,
            };
            match ticket {
                Some(ticket) => ResolveResult::request_pair_with_ticket(
                    resolved.endpoint.port,
                    resolved.nonce,
                    ticket,
                ),
                None => ResolveResult::request_pair(resolved.endpoint.port, resolved.nonce),
            }
        }
        Err(error) => ResolveResult::Error { error },
    };
    logger.log_resolve_result(&result);

    let stdout = io::stdout();
    let mut stdout_lock = stdout.lock();
    if let Err(error) = write_message(&mut stdout_lock, &result) {
        logger.log(&format!("write_message failed: {error}; exit 1"));
        return ExitCode::FAILURE;
    }

    // Native Messaging hosts traditionally stay alive until the browser closes
    // their stdin pipe. Drain at most one bounded message of unexpected trailing
    // input so a peer cannot stream unbounded data through this one-shot host.
    let stdin = io::stdin();
    let mut stdin_lock = stdin.lock();
    let mut trailing = stdin_lock
        .by_ref()
        .take((MAX_MESSAGE_BYTES.saturating_add(1)) as u64);
    if io::copy(&mut trailing, &mut io::sink()).is_ok_and(|read| read > MAX_MESSAGE_BYTES as u64) {
        logger.log("trailing native messaging input exceeded limit; exit 0");
        return ExitCode::SUCCESS;
    }
    logger.log("stdin end; exit 0");
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    run()
}
