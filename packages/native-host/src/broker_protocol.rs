use std::fmt;
use std::io::{self, Cursor, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::probe::is_base64url_nonce;
use crate::resolve::{ResolveError, ResolveResult};

pub const BROKER_MAGIC: [u8; 4] = *b"MXBR";
pub const BROKER_VERSION: u32 = 1;
pub const BROKER_HEADER_BYTES: usize = 12;
pub const MAX_BROKER_MESSAGE_BYTES: usize = 64 * 1024;
pub const BROKER_INPUT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BROKER_FRAME_BYTES: usize = BROKER_HEADER_BYTES + MAX_BROKER_MESSAGE_BYTES;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokerOperation {
    Probe,
    WaitForEndpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerRequest {
    pub operation: BrokerOperation,
}

#[derive(Debug)]
pub enum BrokerProtocolError {
    Io(io::Error),
    InvalidMagic,
    UnsupportedVersion(u32),
    MessageTooLarge { announced: u32, maximum: usize },
    InvalidJson(serde_json::Error),
    Serialization(serde_json::Error),
    TrailingBytes,
    InvalidResponse(&'static str),
    Timeout,
    WorkerSpawn(io::Error),
    WorkerDisconnected,
}

impl fmt::Display for BrokerProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "broker I/O failed: {error}"),
            Self::InvalidMagic => write!(formatter, "invalid broker magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported broker protocol version {version}")
            }
            Self::MessageTooLarge { announced, maximum } => write!(
                formatter,
                "broker message is {announced} bytes; maximum is {maximum}"
            ),
            Self::InvalidJson(error) => write!(formatter, "invalid broker JSON: {error}"),
            Self::Serialization(error) => {
                write!(formatter, "failed to serialize broker JSON: {error}")
            }
            Self::TrailingBytes => write!(formatter, "broker output contained trailing bytes"),
            Self::InvalidResponse(reason) => write!(formatter, "invalid broker response: {reason}"),
            Self::Timeout => write!(formatter, "broker input timed out"),
            Self::WorkerSpawn(error) => write!(formatter, "failed to start broker reader: {error}"),
            Self::WorkerDisconnected => write!(formatter, "broker reader stopped unexpectedly"),
        }
    }
}

impl std::error::Error for BrokerProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) | Self::WorkerSpawn(error) => Some(error),
            Self::InvalidJson(error) | Self::Serialization(error) => Some(error),
            Self::InvalidMagic
            | Self::UnsupportedVersion(_)
            | Self::MessageTooLarge { .. }
            | Self::TrailingBytes
            | Self::InvalidResponse(_)
            | Self::Timeout
            | Self::WorkerDisconnected => None,
        }
    }
}

pub fn read_broker_message<R: Read, T: DeserializeOwned>(
    reader: &mut R,
) -> Result<T, BrokerProtocolError> {
    let mut header = [0_u8; BROKER_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .map_err(BrokerProtocolError::Io)?;
    if header[..4] != BROKER_MAGIC {
        return Err(BrokerProtocolError::InvalidMagic);
    }
    let version = u32::from_le_bytes(header[4..8].try_into().expect("fixed version field"));
    if version != BROKER_VERSION {
        return Err(BrokerProtocolError::UnsupportedVersion(version));
    }
    let announced = u32::from_le_bytes(header[8..12].try_into().expect("fixed length field"));
    if announced as usize > MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerProtocolError::MessageTooLarge {
            announced,
            maximum: MAX_BROKER_MESSAGE_BYTES,
        });
    }
    let mut body = vec![0_u8; announced as usize];
    reader
        .read_exact(&mut body)
        .map_err(BrokerProtocolError::Io)?;
    serde_json::from_slice(&body).map_err(BrokerProtocolError::InvalidJson)
}

pub fn read_broker_message_with_timeout<R, T>(
    mut reader: R,
    timeout: Duration,
) -> Result<T, BrokerProtocolError>
where
    R: Read + Send + 'static,
    T: DeserializeOwned + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("flatpak-broker-reader".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let read_result = reader
                .by_ref()
                .take((MAX_BROKER_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut bytes);
            let result = match read_result {
                Err(error) => Err(BrokerProtocolError::Io(error)),
                Ok(_) if bytes.len() > MAX_BROKER_FRAME_BYTES => {
                    Err(BrokerProtocolError::MessageTooLarge {
                        announced: u32::MAX,
                        maximum: MAX_BROKER_MESSAGE_BYTES,
                    })
                }
                Ok(_) => decode_broker_message_exact(&bytes),
            };
            let _ = sender.send(result);
        })
        .map_err(BrokerProtocolError::WorkerSpawn)?;

    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(BrokerProtocolError::Timeout),
        Err(RecvTimeoutError::Disconnected) => Err(BrokerProtocolError::WorkerDisconnected),
    }
}

pub fn write_broker_message<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), BrokerProtocolError> {
    let body = serde_json::to_vec(value).map_err(BrokerProtocolError::Serialization)?;
    if body.len() > MAX_BROKER_MESSAGE_BYTES {
        return Err(BrokerProtocolError::MessageTooLarge {
            announced: u32::try_from(body.len()).unwrap_or(u32::MAX),
            maximum: MAX_BROKER_MESSAGE_BYTES,
        });
    }
    let length = u32::try_from(body.len()).map_err(|_| BrokerProtocolError::MessageTooLarge {
        announced: u32::MAX,
        maximum: MAX_BROKER_MESSAGE_BYTES,
    })?;
    writer
        .write_all(&BROKER_MAGIC)
        .map_err(BrokerProtocolError::Io)?;
    writer
        .write_all(&BROKER_VERSION.to_le_bytes())
        .map_err(BrokerProtocolError::Io)?;
    writer
        .write_all(&length.to_le_bytes())
        .map_err(BrokerProtocolError::Io)?;
    writer.write_all(&body).map_err(BrokerProtocolError::Io)?;
    writer.flush().map_err(BrokerProtocolError::Io)
}

pub fn encode_broker_message<T: Serialize>(value: &T) -> Result<Vec<u8>, BrokerProtocolError> {
    let mut bytes = Vec::new();
    write_broker_message(&mut bytes, value)?;
    Ok(bytes)
}

pub fn decode_broker_message_exact<T: DeserializeOwned>(
    bytes: &[u8],
) -> Result<T, BrokerProtocolError> {
    let mut cursor = Cursor::new(bytes);
    let value = read_broker_message(&mut cursor)?;
    if cursor.position() as usize != bytes.len() {
        return Err(BrokerProtocolError::TrailingBytes);
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ResolveResultWire {
    RequestPair(RequestPairWire),
    Error(ErrorWire),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestPairWire {
    action: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    port: u16,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorWire {
    error: ResolveError,
}

pub fn decode_broker_response(bytes: &[u8]) -> Result<ResolveResult, BrokerProtocolError> {
    match decode_broker_message_exact::<ResolveResultWire>(bytes)? {
        ResolveResultWire::RequestPair(response) => {
            if response.action != "requestPair" {
                return Err(BrokerProtocolError::InvalidResponse("unexpected action"));
            }
            if response.protocol_version != 1 {
                return Err(BrokerProtocolError::InvalidResponse(
                    "unexpected protocol version",
                ));
            }
            if response.port == 0 {
                return Err(BrokerProtocolError::InvalidResponse("zero port"));
            }
            if !is_base64url_nonce(&response.nonce) {
                return Err(BrokerProtocolError::InvalidResponse("malformed nonce"));
            }
            Ok(ResolveResult::request_pair(response.port, response.nonce))
        }
        ResolveResultWire::Error(response) => Ok(ResolveResult::Error {
            error: response.error,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::time::Duration;

    use serde_json::json;

    use super::{
        BROKER_HEADER_BYTES, BROKER_MAGIC, BROKER_VERSION, BrokerOperation, BrokerProtocolError,
        BrokerRequest, MAX_BROKER_MESSAGE_BYTES, decode_broker_message_exact,
        decode_broker_response, encode_broker_message, read_broker_message,
        read_broker_message_with_timeout, write_broker_message,
    };
    use crate::resolve::{ResolveError, ResolveResult};

    #[test]
    fn round_trips_the_versioned_private_frame() {
        let request = BrokerRequest {
            operation: BrokerOperation::WaitForEndpoint,
        };
        let bytes = encode_broker_message(&request).expect("encode request");
        assert_eq!(&bytes[..4], &BROKER_MAGIC);
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().expect("version")),
            BROKER_VERSION
        );
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().expect("length")) as usize,
            bytes.len() - BROKER_HEADER_BYTES
        );
        assert_eq!(
            decode_broker_message_exact::<BrokerRequest>(&bytes).expect("decode request"),
            request
        );
    }

    #[test]
    fn rejects_wrong_magic_version_oversize_and_trailing_bytes() {
        let request = BrokerRequest {
            operation: BrokerOperation::Probe,
        };
        let encoded = encode_broker_message(&request).expect("encode request");

        let mut wrong_magic = encoded.clone();
        wrong_magic[0] = b'X';
        assert!(matches!(
            decode_broker_message_exact::<BrokerRequest>(&wrong_magic),
            Err(BrokerProtocolError::InvalidMagic)
        ));

        let mut wrong_version = encoded.clone();
        wrong_version[4..8].copy_from_slice(&2_u32.to_le_bytes());
        assert!(matches!(
            decode_broker_message_exact::<BrokerRequest>(&wrong_version),
            Err(BrokerProtocolError::UnsupportedVersion(2))
        ));

        let mut oversized = Vec::from(BROKER_MAGIC);
        oversized.extend_from_slice(&BROKER_VERSION.to_le_bytes());
        oversized.extend_from_slice(&((MAX_BROKER_MESSAGE_BYTES + 1) as u32).to_le_bytes());
        assert!(matches!(
            read_broker_message::<_, BrokerRequest>(&mut Cursor::new(oversized)),
            Err(BrokerProtocolError::MessageTooLarge { .. })
        ));

        let mut trailing = encoded;
        trailing.push(b'x');
        assert!(matches!(
            decode_broker_message_exact::<BrokerRequest>(&trailing),
            Err(BrokerProtocolError::TrailingBytes)
        ));
    }

    #[test]
    fn request_rejects_unknown_fields_and_operations() {
        for value in [
            json!({ "operation": "probe", "allowLaunch": true }),
            json!({ "operation": "launch" }),
            json!({}),
        ] {
            let bytes = encode_broker_message(&value).expect("encode malformed request");
            assert!(matches!(
                decode_broker_message_exact::<BrokerRequest>(&bytes),
                Err(BrokerProtocolError::InvalidJson(_))
            ));
        }
    }

    #[test]
    fn timed_stream_reader_requires_eof_and_rejects_trailing_input() {
        let request = BrokerRequest {
            operation: BrokerOperation::Probe,
        };
        let encoded = encode_broker_message(&request).expect("encode request");
        assert_eq!(
            read_broker_message_with_timeout::<_, BrokerRequest>(
                Cursor::new(encoded.clone()),
                Duration::from_secs(1),
            )
            .expect("decode exact stream"),
            request
        );

        let mut trailing = encoded;
        trailing.push(b'x');
        assert!(matches!(
            read_broker_message_with_timeout::<_, BrokerRequest>(
                Cursor::new(trailing),
                Duration::from_secs(1),
            ),
            Err(BrokerProtocolError::TrailingBytes)
        ));
    }

    #[test]
    fn validates_response_schema_before_exposing_it_to_the_browser() {
        let response = ResolveResult::request_pair(55_809, "AbCdEfGhIjKlMnOpQrStUv".into());
        let mut bytes = Vec::new();
        write_broker_message(&mut bytes, &response).expect("encode response");
        assert_eq!(
            decode_broker_response(&bytes).expect("decode response"),
            response
        );

        for invalid in [
            json!({ "action": "connect", "protocolVersion": 1, "port": 55809, "nonce": "AbCdEfGhIjKlMnOpQrStUv" }),
            json!({ "action": "requestPair", "protocolVersion": 2, "port": 55809, "nonce": "AbCdEfGhIjKlMnOpQrStUv" }),
            json!({ "action": "requestPair", "protocolVersion": 1, "port": 0, "nonce": "AbCdEfGhIjKlMnOpQrStUv" }),
            json!({ "action": "requestPair", "protocolVersion": 1, "port": 55809, "nonce": "bad=" }),
            json!({ "action": "requestPair", "protocolVersion": 1, "port": 55809, "nonce": "AbCdEfGhIjKlMnOpQrStUv", "extra": true }),
            json!({ "error": "unknown" }),
        ] {
            let bytes = encode_broker_message(&invalid).expect("encode invalid response");
            assert!(
                decode_broker_response(&bytes).is_err(),
                "accepted {invalid}"
            );
        }

        let error = ResolveResult::Error {
            error: ResolveError::NotRunning,
        };
        let bytes = encode_broker_message(&error).expect("encode error");
        assert_eq!(decode_broker_response(&bytes).expect("decode error"), error);
    }
}
