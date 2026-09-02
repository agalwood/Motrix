//! Stable wire DTOs and length-prefixed frame codec.

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

const MAX_FRAME_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum Request {
    Capabilities,
    OpenRoot {
        request_id: u64,
        path: String,
    },
    OpenArtifact {
        request_id: u64,
        root: u64,
        relative: String,
    },
    RenameOpenedNoReplace {
        request_id: u64,
        artifact: u64,
        target_root: u64,
        target_relative: String,
    },
    CopyOpened {
        request_id: u64,
        artifact: u64,
        target_root: u64,
        target_relative: String,
    },
    RenameNoReplace {
        request_id: u64,
        source_root: u64,
        source_relative: String,
        target_root: u64,
        target_relative: String,
    },
    RemoveOpened {
        request_id: u64,
        artifact: u64,
        quarantine_relative: String,
        resume_isolated: bool,
    },
    SyncRoot {
        request_id: u64,
        root: u64,
    },
    Close {
        request_id: u64,
        handle: u64,
    },
}

#[derive(Serialize)]
pub(crate) struct Response<'a> {
    request_id: Option<u64>,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) handle: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) platform: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rename_no_replace: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) held_roots: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) directory_sync: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) held_artifacts: Option<bool>,
}

impl<'a> Response<'a> {
    pub(crate) fn ok(request_id: Option<u64>) -> Self {
        Self {
            request_id,
            status: "ok",
            handle: None,
            code: None,
            message: None,
            platform: None,
            rename_no_replace: None,
            held_roots: None,
            directory_sync: None,
            held_artifacts: None,
        }
    }

    pub(crate) fn error(request_id: Option<u64>, code: &'a str, error: impl ToString) -> Self {
        let mut response = Self::ok(request_id);
        response.status = "error";
        response.code = Some(code);
        response.message = Some(error.to_string());
        response
    }
}

pub(crate) fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0_u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame exceeds limit",
        ));
    }
    let mut payload = vec![0_u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub(crate) fn write_frame(output: &mut impl Write, response: &Response<'_>) -> io::Result<()> {
    let payload = serde_json::to_vec(response).map_err(io::Error::other)?;
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "response too large"))?;
    output.write_all(&length.to_le_bytes())?;
    output.write_all(&payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::{Request, Response, read_frame, write_frame};
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn request_wire_remains_tagged_by_operation() {
        let request: Request = serde_json::from_value(json!({
            "op": "remove_opened",
            "request_id": 7,
            "artifact": 11,
            "quarantine_relative": ".motrix-remove-7",
            "resume_isolated": true
        }))
        .unwrap();

        assert!(matches!(
            request,
            Request::RemoveOpened {
                request_id: 7,
                artifact: 11,
                resume_isolated: true,
                ..
            }
        ));
    }

    #[test]
    fn response_wire_omits_unused_optional_fields() {
        let value =
            serde_json::to_value(Response::error(Some(5), "invalid_path", "bad path")).unwrap();

        assert_eq!(
            value,
            json!({
                "request_id": 5,
                "status": "error",
                "code": "invalid_path",
                "message": "bad path"
            })
        );
    }

    #[test]
    fn frame_codec_round_trips_the_response_payload() {
        let mut encoded = Vec::new();
        write_frame(&mut encoded, &Response::ok(Some(9))).unwrap();

        let payload = read_frame(&mut Cursor::new(encoded)).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&payload).unwrap(),
            json!({"request_id": 9, "status": "ok"})
        );
    }
}
