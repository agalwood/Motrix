use std::fmt;
use std::io::{self, Read};
use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use motrix_native_host::caller::extract_caller_identity;
use motrix_native_host::endpoint::EndpointFile;
use motrix_native_host::log::NativeHostLogger;
use motrix_native_host::protocol::{
    INPUT_TIMEOUT, MAX_MESSAGE_BYTES, ProtocolError, TimedReadError, read_message_with_timeout,
    write_message,
};
use motrix_native_host::resolve::{ResolveResult, resolve_endpoint};
use motrix_native_host::runtime::SystemResolveDeps;
use motrix_native_host::ticket::{NmTicket, TICKET_LIFETIME_SECONDS, TicketInputs, mint_ticket};
use motrix_native_host::user_data::{native_host_bridge_data_dir, native_host_user_data_dir};
use motrix_native_host::{HostRequest, parse_host_request};

#[derive(Debug)]
enum RunError {
    Read(TimedReadError),
    MalformedRequest,
    Write(ProtocolError),
}

impl fmt::Display for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "read_message failed: {error}"),
            Self::MalformedRequest => formatter.write_str("received malformed JSON value"),
            Self::Write(error) => write!(formatter, "write_message failed: {error}"),
        }
    }
}

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

fn read_request() -> Result<HostRequest, RunError> {
    let input = read_message_with_timeout(io::stdin(), INPUT_TIMEOUT).map_err(RunError::Read)?;
    parse_host_request(&input).ok_or(RunError::MalformedRequest)
}

fn resolve_request(request: &HostRequest, bridge_data: Option<&Path>) -> ResolveResult {
    let mut deps = SystemResolveDeps::from_bridge_data(bridge_data);
    match resolve_endpoint(request.allow_launch(), &mut deps) {
        Ok(resolved) => {
            let ticket = request
                .bootstrap_binding_pub()
                .and_then(|binding_pub| mint_ticket_for_bootstrap(&resolved.endpoint, binding_pub));
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
    }
}

fn write_response(result: &ResolveResult) -> Result<(), RunError> {
    let stdout = io::stdout();
    write_message(&mut stdout.lock(), result).map_err(RunError::Write)
}

fn drain_trailing_input(logger: &NativeHostLogger) {
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
    } else {
        logger.log("stdin end; exit 0");
    }
}

fn run(bridge_data: Option<&Path>, logger: &NativeHostLogger) -> Result<(), RunError> {
    let request = read_request()?;
    logger.log(&format!(
        "received start; allowLaunch={}",
        request.allow_launch()
    ));

    let result = resolve_request(&request, bridge_data);
    logger.log_resolve_result(&result);
    write_response(&result)?;
    drain_trailing_input(logger);
    Ok(())
}

fn main() -> ExitCode {
    let user_data = native_host_user_data_dir();
    let bridge_data = native_host_bridge_data_dir(user_data.as_deref());
    let logger = NativeHostLogger::from_bridge_data(bridge_data.as_deref());
    logger.log(&format!(
        "=== spawned argv_count={} ===",
        std::env::args_os().count().saturating_sub(1)
    ));

    match run(bridge_data.as_deref(), &logger) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            logger.log(&format!("{error}; exit 1"));
            ExitCode::FAILURE
        }
    }
}
