use std::process::ExitCode;

#[cfg(target_os = "linux")]
fn run() -> Result<(), String> {
    use std::io;

    use motrix_native_host::broker_protocol::{
        BROKER_INPUT_TIMEOUT, BrokerOperation, BrokerRequest, read_broker_message_with_timeout,
        write_broker_message,
    };
    use motrix_native_host::runtime::{probe_bridge, wait_for_bridge};
    use motrix_native_host::user_data::resolve_flatpak_bridge_data_dir;

    // Validate the sandbox identity and its private config namespace before
    // consuming any caller-controlled input. There is deliberately no HOME or
    // MOTRIX_BRIDGE_DATA_DIR fallback in this broker.
    let bridge_data = resolve_flatpak_bridge_data_dir(
        std::env::var_os("FLATPAK_ID").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
    )
    .ok_or_else(|| "invalid Motrix Flatpak environment".to_owned())?;

    let request: BrokerRequest =
        read_broker_message_with_timeout(io::stdin(), BROKER_INPUT_TIMEOUT)
            .map_err(|error| format!("read broker request: {error}"))?;
    let result = match request.operation {
        BrokerOperation::Probe => probe_bridge(Some(&bridge_data)),
        BrokerOperation::WaitForEndpoint => wait_for_bridge(Some(&bridge_data)),
    };

    let stdout = io::stdout();
    write_broker_message(&mut stdout.lock(), &result)
        .map_err(|error| format!("write broker response: {error}"))
}

#[cfg(not(target_os = "linux"))]
fn run() -> Result<(), String> {
    Err("the Flatpak native-host broker is only supported on Linux".into())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("motrix-native-host-broker: {error}");
            ExitCode::FAILURE
        }
    }
}
