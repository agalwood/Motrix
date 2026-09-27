use std::io;
use std::process::ExitCode;

use motrix_windows_platform::{platform, protocol};

fn main() -> ExitCode {
    let response = protocol::handle_request(
        io::stdin().lock(),
        std::env::args_os().nth(1).is_some(),
        platform::execute,
    );
    if protocol::write_response(io::stdout().lock(), &response).is_err() {
        eprintln!("windows-platform could not write its response");
        return ExitCode::FAILURE;
    }
    // A structured protocol/API failure is a successfully delivered response.
    // Process failures remain distinct from ok:false in the caller's adapter.
    ExitCode::SUCCESS
}
