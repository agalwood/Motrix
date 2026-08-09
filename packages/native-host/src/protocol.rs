use std::fmt;
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const INPUT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    MessageTooLarge { announced: u32, maximum: usize },
    InvalidJson(serde_json::Error),
    Serialization(serde_json::Error),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "native messaging I/O failed: {error}"),
            Self::MessageTooLarge { announced, maximum } => {
                write!(
                    formatter,
                    "native messaging message is {announced} bytes; maximum is {maximum}"
                )
            }
            Self::InvalidJson(error) => write!(formatter, "invalid native messaging JSON: {error}"),
            Self::Serialization(error) => {
                write!(
                    formatter,
                    "failed to serialize native messaging JSON: {error}"
                )
            }
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidJson(error) | Self::Serialization(error) => Some(error),
            Self::MessageTooLarge { .. } => None,
        }
    }
}

#[derive(Debug)]
pub enum TimedReadError {
    Protocol(ProtocolError),
    Timeout,
    WorkerSpawn(io::Error),
    WorkerDisconnected,
}

impl fmt::Display for TimedReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => error.fmt(formatter),
            Self::Timeout => write!(formatter, "native messaging input timed out"),
            Self::WorkerSpawn(error) => {
                write!(
                    formatter,
                    "failed to start native messaging reader: {error}"
                )
            }
            Self::WorkerDisconnected => {
                write!(formatter, "native messaging reader stopped unexpectedly")
            }
        }
    }
}

impl std::error::Error for TimedReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::WorkerSpawn(error) => Some(error),
            Self::Timeout | Self::WorkerDisconnected => None,
        }
    }
}

pub fn read_message<R: Read>(reader: &mut R) -> Result<Value, ProtocolError> {
    let mut length_bytes = [0_u8; 4];
    reader
        .read_exact(&mut length_bytes)
        .map_err(ProtocolError::Io)?;
    let announced = u32::from_le_bytes(length_bytes);
    if announced as usize > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge {
            announced,
            maximum: MAX_MESSAGE_BYTES,
        });
    }

    let mut body = vec![0_u8; announced as usize];
    reader.read_exact(&mut body).map_err(ProtocolError::Io)?;
    serde_json::from_slice(&body).map_err(ProtocolError::InvalidJson)
}

pub fn read_message_with_timeout<R: Read + Send + 'static>(
    mut reader: R,
    timeout: Duration,
) -> Result<Value, TimedReadError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("native-messaging-reader".into())
        .spawn(move || {
            let _ = sender.send(read_message(&mut reader));
        })
        .map_err(TimedReadError::WorkerSpawn)?;

    match receiver.recv_timeout(timeout) {
        Ok(result) => result.map_err(TimedReadError::Protocol),
        Err(RecvTimeoutError::Timeout) => Err(TimedReadError::Timeout),
        Err(RecvTimeoutError::Disconnected) => Err(TimedReadError::WorkerDisconnected),
    }
}

pub fn write_message<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), ProtocolError> {
    let body = serde_json::to_vec(value).map_err(ProtocolError::Serialization)?;
    if body.len() > MAX_MESSAGE_BYTES {
        return Err(ProtocolError::MessageTooLarge {
            announced: u32::try_from(body.len()).unwrap_or(u32::MAX),
            maximum: MAX_MESSAGE_BYTES,
        });
    }
    let length = u32::try_from(body.len()).map_err(|_| ProtocolError::MessageTooLarge {
        announced: u32::MAX,
        maximum: MAX_MESSAGE_BYTES,
    })?;
    writer
        .write_all(&length.to_le_bytes())
        .map_err(ProtocolError::Io)?;
    writer.write_all(&body).map_err(ProtocolError::Io)?;
    writer.flush().map_err(ProtocolError::Io)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, ErrorKind};
    use std::time::Duration;

    use serde_json::json;

    use super::{
        MAX_MESSAGE_BYTES, ProtocolError, TimedReadError, read_message, read_message_with_timeout,
        write_message,
    };

    #[test]
    fn round_trips_little_endian_utf8_json() {
        let value = json!({ "action": "requestPair", "port": 55809, "text": "下载" });
        let mut wire = Vec::new();
        write_message(&mut wire, &value).expect("encode frame");

        assert_eq!(
            u32::from_le_bytes(wire[..4].try_into().expect("length prefix")),
            wire.len() as u32 - 4
        );
        assert_eq!(
            read_message(&mut Cursor::new(wire)).expect("decode frame"),
            value
        );
    }

    #[test]
    fn reads_fragmented_input_via_read_exact() {
        struct OneByteReader(Cursor<Vec<u8>>);
        impl std::io::Read for OneByteReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let length = output.len().min(1);
                self.0.read(&mut output[..length])
            }
        }

        let mut wire = Vec::new();
        write_message(&mut wire, &json!({ "allowLaunch": false })).expect("encode frame");
        let decoded = read_message(&mut OneByteReader(Cursor::new(wire))).expect("decode frame");
        assert_eq!(decoded, json!({ "allowLaunch": false }));
    }

    #[test]
    fn rejects_announced_oversized_message_before_allocating_body() {
        let wire = ((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes();
        assert!(matches!(
            read_message(&mut Cursor::new(wire)),
            Err(ProtocolError::MessageTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_truncated_header_and_body() {
        let header_error =
            read_message(&mut Cursor::new([1_u8, 2, 3])).expect_err("truncated header must fail");
        assert!(matches!(
            header_error,
            ProtocolError::Io(ref error) if error.kind() == ErrorKind::UnexpectedEof
        ));

        let mut wire = 10_u32.to_le_bytes().to_vec();
        wire.extend_from_slice(b"{}");
        let body_error =
            read_message(&mut Cursor::new(wire)).expect_err("truncated body must fail");
        assert!(matches!(
            body_error,
            ProtocolError::Io(ref error) if error.kind() == ErrorKind::UnexpectedEof
        ));
    }

    #[test]
    fn rejects_zero_length_and_malformed_json() {
        assert!(matches!(
            read_message(&mut Cursor::new(0_u32.to_le_bytes())),
            Err(ProtocolError::InvalidJson(_))
        ));

        let mut wire = 1_u32.to_le_bytes().to_vec();
        wire.push(b'{');
        assert!(matches!(
            read_message(&mut Cursor::new(wire)),
            Err(ProtocolError::InvalidJson(_))
        ));
    }

    #[test]
    fn timed_reader_rejects_a_stalled_body() {
        struct DelayedReader {
            delay: Duration,
            cursor: Cursor<Vec<u8>>,
            reads: usize,
            delayed: bool,
        }

        impl std::io::Read for DelayedReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                if self.reads > 0 && !self.delayed {
                    self.delayed = true;
                    std::thread::sleep(self.delay);
                }
                self.reads += 1;
                self.cursor.read(output)
            }
        }

        let reader = DelayedReader {
            delay: Duration::from_millis(50),
            cursor: Cursor::new(4_u32.to_le_bytes().to_vec()),
            reads: 0,
            delayed: false,
        };
        assert!(matches!(
            read_message_with_timeout(reader, Duration::from_millis(5)),
            Err(TimedReadError::Timeout)
        ));
    }
}
