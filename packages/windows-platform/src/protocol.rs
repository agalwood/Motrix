use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

use crate::associations::AssociationStatus;
use crate::startup_task::{StartupError, StartupState};

pub const MAX_REQUEST_BYTES: usize = 4096;
pub const TASK_ID: &str = "MotrixStartup";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    StartupQuery,
    StartupEnable,
    StartupDisable,
    AssociationsQuery,
    MainLaunch,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    op: Operation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    NoPackageIdentity,
    TaskUnavailable,
    WinrtFailed,
    UnknownState,
    MainAppUnavailable,
    LaunchRejected,
    OperationTimedOut,
}

pub enum OperationResult {
    Startup(StartupState),
    Associations(AssociationStatus),
    MainLaunch,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success {
        version: u8,
        ok: bool,
        #[serde(rename = "taskId")]
        task_id: &'static str,
        state: StartupState,
        #[serde(rename = "packageIdentityPresent")]
        package_identity_present: bool,
    },
    Associations {
        version: u8,
        ok: bool,
        #[serde(rename = "packageIdentityPresent")]
        package_identity_present: bool,
        #[serde(rename = "mainAppAumid")]
        main_app_aumid: String,
        torrent: Option<bool>,
        magnet: Option<bool>,
    },
    MainLaunch {
        version: u8,
        ok: bool,
        #[serde(rename = "packageIdentityPresent")]
        package_identity_present: bool,
        launched: bool,
    },
    Error {
        version: u8,
        ok: bool,
        code: ErrorCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        hresult: Option<String>,
    },
}

impl Response {
    pub fn from_operation_result(result: Result<OperationResult, StartupError>) -> Self {
        match result {
            Ok(OperationResult::MainLaunch) => Self::MainLaunch {
                version: 1,
                ok: true,
                package_identity_present: true,
                launched: true,
            },
            Ok(OperationResult::Associations(status)) => Self::Associations {
                version: 1,
                ok: true,
                package_identity_present: true,
                main_app_aumid: status.main_app_aumid,
                torrent: status.torrent,
                magnet: status.magnet,
            },
            Ok(OperationResult::Startup(state)) => Self::from_result(Ok(state)),
            Err(error) => Self::from_result(Err(error)),
        }
    }

    pub fn from_result(result: Result<StartupState, StartupError>) -> Self {
        match result {
            Ok(state) => Self::Success {
                version: 1,
                ok: true,
                task_id: TASK_ID,
                state,
                package_identity_present: true,
            },
            Err(error) => Self::Error {
                version: 1,
                ok: false,
                code: error.code,
                hresult: error.hresult.map(|value| format!("0x{:08x}", value as u32)),
            },
        }
    }
}

pub fn read_request(reader: impl Read) -> Result<Operation, StartupError> {
    // Read one extra byte to reject oversized input without retaining an
    // unbounded stream. The caller closes stdin and bounds the child lifetime.
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| StartupError::new(ErrorCode::InvalidRequest))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(StartupError::new(ErrorCode::InvalidRequest));
    }
    let request: Request =
        serde_json::from_slice(&bytes).map_err(|_| StartupError::new(ErrorCode::InvalidRequest))?;
    if request.version != 1 {
        return Err(StartupError::new(ErrorCode::InvalidRequest));
    }
    Ok(request.op)
}

pub fn write_response(mut writer: impl Write, response: &Response) -> io::Result<()> {
    // Strings come only from fixed identifiers or bounded, validated OS data.
    serde_json::to_writer(&mut writer, response).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// A single request followed by EOF produces one response. Command-line
/// arguments are not a second control channel and never reach the backend.
pub fn handle_request(
    reader: impl Read,
    has_arguments: bool,
    execute: impl FnOnce(Operation) -> Result<OperationResult, StartupError>,
) -> Response {
    let result = if has_arguments {
        Err(StartupError::new(ErrorCode::InvalidRequest))
    } else {
        read_request(reader).and_then(execute)
    };
    Response::from_operation_result(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_the_five_operations_and_version_one() {
        for (name, op) in [
            ("startup_query", Operation::StartupQuery),
            ("startup_enable", Operation::StartupEnable),
            ("startup_disable", Operation::StartupDisable),
            ("associations_query", Operation::AssociationsQuery),
            ("main_launch", Operation::MainLaunch),
        ] {
            let input = format!("{{\"version\":1,\"op\":\"{name}\"}}\n");
            assert_eq!(read_request(input.as_bytes()).unwrap(), op);
        }
    }

    #[test]
    fn rejects_unknown_duplicate_or_malformed_fields_and_multiple_requests() {
        for input in [
            "",
            "null",
            r#"{"version":1,"op":"main_launch","aumid":"Other!App"}"#,
            r#"{"version":1,"op":"main_launch","arguments":"--evil"}"#,
            "[]",
            "{}",
            r#"{"version":0,"op":"startup_query"}"#,
            r#"{"version":2,"op":"startup_query"}"#,
            r#"{"version":1.0,"op":"startup_query"}"#,
            r#"{"version":"1","op":"startup_query"}"#,
            r#"{"version":1,"op":"launch"}"#,
            r#"{"version":1,"op":"associations_enable"}"#,
            r#"{"version":1,"op":"associations_query","extension":".exe"}"#,
            r#"{"version":1,"op":"associations_query","mainAppAumid":"Other!App"}"#,
            r#"{"version":1,"op":"startup_query","taskId":"OtherTask"}"#,
            r#"{"version":1,"op":"startup_query","path":"evil.exe"}"#,
            r#"{"version":1,"version":1,"op":"startup_query"}"#,
            r#"{"version":1,"op":"startup_query","op":"startup_enable"}"#,
            r#"{"version":1,"op":"startup_query"}{}"#,
            r#"{"version":1,"op":"startup_query"} trailing"#,
        ] {
            assert_eq!(
                read_request(input.as_bytes()).unwrap_err().code,
                ErrorCode::InvalidRequest,
                "{input}"
            );
        }
        assert_eq!(
            read_request(&b"\xff"[..]).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn enforces_the_byte_limit_including_trailing_whitespace() {
        let mut bytes = br#"{"version":1,"op":"startup_query"}"#.to_vec();
        bytes.resize(MAX_REQUEST_BYTES, b' ');
        assert_eq!(
            read_request(bytes.as_slice()).unwrap(),
            Operation::StartupQuery
        );
        bytes.push(b' ');
        assert_eq!(
            read_request(bytes.as_slice()).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn stops_reading_after_limit_plus_one_even_without_eof() {
        let mut input = io::repeat(b' ');
        assert_eq!(
            read_request(&mut input).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
    }

    #[test]
    fn input_failure_and_arguments_never_call_the_backend() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("read failed"))
            }
        }
        for response in [
            handle_request(Broken, false, |_| panic!("backend must not run")),
            handle_request(io::empty(), true, |_| panic!("backend must not run")),
            handle_request(&b"{}"[..], false, |_| panic!("backend must not run")),
        ] {
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                json!({"version":1,"ok":false,"code":"invalid_request"})
            );
        }
    }

    #[test]
    fn serializes_exact_success_and_error_shapes() {
        let success = Response::from_result(Ok(StartupState::DisabledByUser));
        assert_eq!(
            serde_json::to_value(success).unwrap(),
            json!({"version":1,"ok":true,"taskId":"MotrixStartup","state":"disabled_by_user","packageIdentityPresent":true})
        );
        let error = Response::from_result(Err(StartupError::with_hresult(
            ErrorCode::WinrtFailed,
            0x80070005u32 as i32,
        )));
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"version":1,"ok":false,"code":"winrt_failed","hresult":"0x80070005"})
        );
        let error = Response::from_result(Err(StartupError::new(ErrorCode::UnknownState)));
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            json!({"version":1,"ok":false,"code":"unknown_state"})
        );
    }

    #[test]
    fn writes_one_small_json_response_and_propagates_write_failures() {
        let response = Response::from_result(Err(StartupError::new(ErrorCode::NoPackageIdentity)));
        let mut output = Vec::new();
        write_response(&mut output, &response).unwrap();
        assert_eq!(
            output,
            b"{\"version\":1,\"ok\":false,\"code\":\"no_package_identity\"}\n"
        );
        assert!(output.len() < 1024);
        assert!(write_response(&mut [0u8; 1][..], &response).is_err());
    }

    #[test]
    fn main_launch_has_a_distinct_exact_success_shape() {
        let response = handle_request(
            &br#"{"version":1,"op":"main_launch"}"#[..],
            false,
            |operation| {
                assert_eq!(operation, Operation::MainLaunch);
                Ok(OperationResult::MainLaunch)
            },
        );
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({"version":1,"ok":true,"packageIdentityPresent":true,"launched":true})
        );
        for code in [ErrorCode::LaunchRejected, ErrorCode::OperationTimedOut] {
            assert!(matches!(
                Response::from_operation_result(Err(StartupError::new(code))),
                Response::Error { .. }
            ));
        }
    }

    #[test]
    fn association_response_has_no_startup_fields_and_preserves_nulls() {
        let response = handle_request(
            &br#"{"version":1,"op":"associations_query"}"#[..],
            false,
            |operation| {
                assert_eq!(operation, Operation::AssociationsQuery);
                Ok(OperationResult::Associations(AssociationStatus {
                    main_app_aumid: "Example.Package_123456789abcd!Motrix".into(),
                    torrent: None,
                    magnet: Some(false),
                }))
            },
        );
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "version": 1, "ok": true, "packageIdentityPresent": true,
                "mainAppAumid": "Example.Package_123456789abcd!Motrix",
                "torrent": null, "magnet": false,
            })
        );
        assert_eq!(
            serde_json::to_value(Response::from_operation_result(Err(StartupError::new(
                ErrorCode::MainAppUnavailable
            ))))
            .unwrap(),
            json!({"version":1,"ok":false,"code":"main_app_unavailable"})
        );
        let startup = handle_request(&br#"{"version":1,"op":"startup_query"}"#[..], false, |_| {
            Ok(OperationResult::Startup(StartupState::Enabled))
        });
        assert_eq!(
            serde_json::to_value(startup).unwrap(),
            json!({
                "version":1,"ok":true,"taskId":"MotrixStartup","state":"enabled","packageIdentityPresent":true
            })
        );
    }
}
