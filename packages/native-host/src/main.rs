use std::io::{self, Read};
use std::process::ExitCode;

use motrix_native_host::log::NativeHostLogger;
use motrix_native_host::parse_allow_launch;
use motrix_native_host::protocol::{
    INPUT_TIMEOUT, MAX_MESSAGE_BYTES, read_message_with_timeout, write_message,
};
use motrix_native_host::runtime::resolve_direct;
use motrix_native_host::user_data::{native_host_bridge_data_dir, native_host_user_data_dir};

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
    let Some(allow_launch) = parse_allow_launch(&input) else {
        logger.log("received malformed JSON value; exit 1");
        return ExitCode::FAILURE;
    };
    logger.log(&format!("received start; allowLaunch={allow_launch}"));

    let result = resolve_direct(allow_launch, bridge_data.as_deref());
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
