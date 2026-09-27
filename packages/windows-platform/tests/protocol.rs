use std::io::Write;
use std::process::{Command, Stdio};

fn invoke(input: &[u8], arguments: &[&str]) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_motrix-windows-platform"))
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input).unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() < 1024);
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn extra_arguments_are_rejected_without_any_task_operation() {
    let actual = invoke(b"", &["--task-id", "OtherTask"]);
    assert_eq!(
        actual,
        serde_json::json!({"version":1,"ok":false,"code":"invalid_request"})
    );
}

#[test]
fn malformed_or_multiple_requests_produce_one_error_response() {
    for input in [
        &b"not json"[..],
        &br#"{"version":1,"op":"startup_query"}{"version":1,"op":"startup_enable"}"#[..],
    ] {
        assert_eq!(
            invoke(input, &[]),
            serde_json::json!({"version":1,"ok":false,"code":"invalid_request"})
        );
    }
}

#[test]
fn oversized_input_is_rejected() {
    assert_eq!(
        invoke(&vec![b' '; 4097], &[]),
        serde_json::json!({"version":1,"ok":false,"code":"invalid_request"})
    );
}

#[cfg(not(windows))]
#[test]
fn non_windows_never_claims_package_identity_or_startup_state() {
    for op in [
        "startup_query",
        "startup_enable",
        "startup_disable",
        "associations_query",
        "main_launch",
    ] {
        let input = format!("{{\"version\":1,\"op\":\"{op}\"}}");
        assert_eq!(
            invoke(input.as_bytes(), &[]),
            serde_json::json!({"version":1,"ok":false,"code":"no_package_identity"})
        );
    }
}
