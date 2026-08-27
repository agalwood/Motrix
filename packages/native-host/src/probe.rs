use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::str;
use std::time::{Duration, Instant};

use serde::Deserialize;

pub const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const MAX_HTTP_WIRE_BYTES: usize = 128 * 1024;
const MAX_DISCOVERY_BODY_BYTES: usize = 4 * 1024;
const MAX_DISCOVERY_FIELD_BYTES: usize = 128;
const DISCOVERY_APP: &str = "motrix-bridge";
const DISCOVERY_API_VERSION: u32 = 1;

#[derive(Deserialize)]
struct NonceResponse {
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryResponse {
    app: String,
    api_version: u32,
    instance_id: String,
    app_version: String,
}

#[derive(Clone, Copy)]
enum BodyMode {
    ContentLength(usize),
    Chunked,
    CloseDelimited,
}

#[derive(Clone, Copy)]
struct ResponseHead {
    status: u16,
    body_start: usize,
    body_mode: BodyMode,
}

enum ChunkDecode {
    Incomplete,
    Complete(Vec<u8>),
    Invalid,
}

/// Connects to loopback, sends `request` verbatim, and returns the decoded
/// response body — shared connect/write/read scaffolding for both the
/// nonce fetch and the discovery liveness probe below.
fn fetch_response_body(port: u16, timeout: Duration, request: &str) -> Option<Vec<u8>> {
    if port == 0 || timeout.is_zero() {
        return None;
    }
    let deadline = Instant::now().checked_add(timeout)?;
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), remaining(deadline)?).ok()?;
    let _ = stream.set_nodelay(true);

    stream.set_write_timeout(Some(remaining(deadline)?)).ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;

    read_response_body(&mut stream, deadline)
}

/// `POST /nonce` (spec §4.2). The custom header makes the request
/// non-simple so a browser preflights it; loopback callers like this one
/// send it directly over a raw socket.
pub fn fetch_nonce(port: u16, timeout: Duration) -> Option<String> {
    let request = format!(
        "POST /nonce HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nX-Motrix-Bridge: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let body = fetch_response_body(port, timeout, &request)?;
    let response: NonceResponse = serde_json::from_slice(&body).ok()?;
    is_base64url_nonce(&response.nonce).then_some(response.nonce)
}

/// `GET /discovery` (spec §4.1): unauthenticated and replayable, so it is
/// the cheap liveness check — callers reserve `fetch_nonce` for a single
/// call once the bridge is known alive rather than burning a nonce per poll.
pub fn probe_liveness(port: u16, timeout: Duration) -> bool {
    let request = format!(
        "GET /discovery HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    let Some(body) = fetch_response_body(port, timeout, &request) else {
        return false;
    };
    if body.len() > MAX_DISCOVERY_BODY_BYTES {
        return false;
    }
    let Ok(response) = serde_json::from_slice::<DiscoveryResponse>(&body) else {
        return false;
    };
    response.app == DISCOVERY_APP
        && response.api_version == DISCOVERY_API_VERSION
        && is_reasonable_discovery_field(&response.instance_id)
        && is_reasonable_discovery_field(&response.app_version)
}

fn is_reasonable_discovery_field(value: &str) -> bool {
    (1..=MAX_DISCOVERY_FIELD_BYTES).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn remaining(deadline: Instant) -> Option<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    (!remaining.is_zero()).then_some(remaining)
}

fn read_response_body(stream: &mut TcpStream, deadline: Instant) -> Option<Vec<u8>> {
    let mut wire = Vec::new();
    let mut head: Option<ResponseHead> = None;
    let mut buffer = [0_u8; 4096];

    loop {
        if let Some(parsed) = head {
            if !(200..300).contains(&parsed.status) {
                return None;
            }
            let encoded_body = wire.get(parsed.body_start..)?;
            match parsed.body_mode {
                BodyMode::ContentLength(length) => {
                    if encoded_body.len() >= length {
                        return Some(encoded_body[..length].to_vec());
                    }
                }
                BodyMode::Chunked => match decode_chunked(encoded_body) {
                    ChunkDecode::Complete(body) => return Some(body),
                    ChunkDecode::Invalid => return None,
                    ChunkDecode::Incomplete => {}
                },
                BodyMode::CloseDelimited => {}
            }
        } else {
            match parse_response_head(&wire) {
                Ok(Some(parsed)) => {
                    if !(200..300).contains(&parsed.status) {
                        return None;
                    }
                    head = Some(parsed);
                    continue;
                }
                Ok(None) => {
                    if wire.len() > MAX_HTTP_HEADER_BYTES {
                        return None;
                    }
                }
                Err(()) => return None,
            }
        }

        if wire.len() > MAX_HTTP_WIRE_BYTES {
            return None;
        }
        stream.set_read_timeout(Some(remaining(deadline)?)).ok()?;
        match stream.read(&mut buffer) {
            Ok(0) => {
                let parsed = head.or_else(|| parse_response_head(&wire).ok().flatten())?;
                if !(200..300).contains(&parsed.status) {
                    return None;
                }
                let encoded_body = wire.get(parsed.body_start..)?;
                return match parsed.body_mode {
                    BodyMode::ContentLength(length) => {
                        (encoded_body.len() >= length).then(|| encoded_body[..length].to_vec())
                    }
                    BodyMode::Chunked => match decode_chunked(encoded_body) {
                        ChunkDecode::Complete(body) => Some(body),
                        ChunkDecode::Incomplete | ChunkDecode::Invalid => None,
                    },
                    BodyMode::CloseDelimited => {
                        (encoded_body.len() <= MAX_HTTP_BODY_BYTES).then(|| encoded_body.to_vec())
                    }
                };
            }
            Ok(read) => {
                if wire.len().saturating_add(read) > MAX_HTTP_WIRE_BYTES {
                    return None;
                }
                wire.extend_from_slice(&buffer[..read]);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
}

fn parse_response_head(wire: &[u8]) -> Result<Option<ResponseHead>, ()> {
    let Some(header_end) = find_bytes(wire, b"\r\n\r\n") else {
        return Ok(None);
    };
    if header_end > MAX_HTTP_HEADER_BYTES {
        return Err(());
    }

    let header = str::from_utf8(&wire[..header_end]).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let status_line = lines.next().ok_or(())?;
    let mut status_parts = status_line.split_whitespace();
    let version = status_parts.next().ok_or(())?;
    if !version.starts_with("HTTP/") {
        return Err(());
    }
    let status = status_parts
        .next()
        .ok_or(())?
        .parse::<u16>()
        .map_err(|_| ())?;

    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value.trim().parse::<usize>().map_err(|_| ())?;
            if parsed > MAX_HTTP_BODY_BYTES
                || content_length.is_some_and(|existing| existing != parsed)
            {
                return Err(());
            }
            content_length = Some(parsed);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
        }
    }

    let body_mode = if chunked {
        BodyMode::Chunked
    } else if let Some(length) = content_length {
        BodyMode::ContentLength(length)
    } else {
        BodyMode::CloseDelimited
    };
    Ok(Some(ResponseHead {
        status,
        body_start: header_end + 4,
        body_mode,
    }))
}

fn decode_chunked(encoded: &[u8]) -> ChunkDecode {
    let mut cursor = 0;
    let mut decoded = Vec::new();

    loop {
        let Some(relative_line_end) = find_bytes(&encoded[cursor..], b"\r\n") else {
            return ChunkDecode::Incomplete;
        };
        let line_end = cursor + relative_line_end;
        let Ok(size_line) = str::from_utf8(&encoded[cursor..line_end]) else {
            return ChunkDecode::Invalid;
        };
        let size_text = size_line
            .split_once(';')
            .map_or(size_line, |(size, _)| size)
            .trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            return ChunkDecode::Invalid;
        };
        cursor = line_end + 2;

        if size == 0 {
            if encoded.get(cursor..cursor + 2) == Some(b"\r\n") {
                return ChunkDecode::Complete(decoded);
            }
            return if find_bytes(&encoded[cursor..], b"\r\n\r\n").is_some() {
                ChunkDecode::Complete(decoded)
            } else {
                ChunkDecode::Incomplete
            };
        }

        if size > MAX_HTTP_BODY_BYTES.saturating_sub(decoded.len()) {
            return ChunkDecode::Invalid;
        }
        let Some(data_end) = cursor.checked_add(size) else {
            return ChunkDecode::Invalid;
        };
        let Some(chunk) = encoded.get(cursor..data_end) else {
            return ChunkDecode::Incomplete;
        };
        if encoded.get(data_end..data_end + 2) != Some(b"\r\n") {
            return if encoded.len() < data_end + 2 {
                ChunkDecode::Incomplete
            } else {
                ChunkDecode::Invalid
            };
        }
        decoded.extend_from_slice(chunk);
        cursor = data_end + 2;
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn is_base64url_nonce(nonce: &str) -> bool {
    (16..=128).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    use super::{
        ChunkDecode, MAX_DISCOVERY_BODY_BYTES, MAX_DISCOVERY_FIELD_BYTES, MAX_HTTP_BODY_BYTES,
        decode_chunked, fetch_nonce, probe_liveness,
    };

    const NONCE: &str = "AbCdEfGhIjKlMnOpQrStUv";

    fn serve_once_capturing(
        parts: Vec<Vec<u8>>,
        delay: Duration,
    ) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake bridge");
        let port = listener.local_addr().expect("fake bridge address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe");
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).expect("read probe request");
            let request = String::from_utf8_lossy(&request[..read]).into_owned();
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            for part in parts {
                if stream.write_all(&part).is_err() {
                    break;
                }
            }
            request
        });
        (port, server)
    }

    #[test]
    fn fetch_nonce_sends_post_with_bridge_header_and_zero_length() {
        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (port, server) = serve_once_capturing(vec![response.into_bytes()], Duration::ZERO);
        assert_eq!(
            fetch_nonce(port, Duration::from_secs(1)),
            Some(NONCE.into())
        );
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
        assert!(request.contains("\r\nX-Motrix-Bridge: 1\r\n"));
        assert!(request.contains("\r\nContent-Length: 0\r\n"));
        assert!(request.contains("\r\nConnection: close\r\n"));
    }

    #[test]
    fn parses_content_length_nonce_response() {
        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (port, server) = serve_once_capturing(vec![response.into_bytes()], Duration::ZERO);
        assert_eq!(
            fetch_nonce(port, Duration::from_secs(1)),
            Some(NONCE.into())
        );
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
    }

    #[test]
    fn parses_node_style_chunked_response_across_writes() {
        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        let (first_body, second_body) = body.split_at(11);
        let first = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n{first_body}\r\n",
            first_body.len()
        );
        let second = format!("{:X}\r\n{second_body}\r\n0\r\n\r\n", second_body.len());
        let (port, server) = serve_once_capturing(
            vec![first.into_bytes(), second.into_bytes()],
            Duration::ZERO,
        );
        assert_eq!(
            fetch_nonce(port, Duration::from_secs(1)),
            Some(NONCE.into())
        );
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
    }

    #[test]
    fn rejects_redirect_without_following_location() {
        let response =
            b"HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n";
        let (port, server) = serve_once_capturing(vec![response.to_vec()], Duration::ZERO);
        assert_eq!(fetch_nonce(port, Duration::from_secs(1)), None);
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
    }

    #[test]
    fn rejects_invalid_nonce_and_oversized_response() {
        let invalid_body = br#"{"nonce":"contains=padding"}"#;
        let invalid_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            invalid_body.len()
        )
        .into_bytes();
        let (port, server) = serve_once_capturing(
            vec![invalid_response, invalid_body.to_vec()],
            Duration::ZERO,
        );
        assert_eq!(fetch_nonce(port, Duration::from_secs(1)), None);
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));

        let oversized = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_HTTP_BODY_BYTES + 1
        );
        let (port, server) = serve_once_capturing(vec![oversized.into_bytes()], Duration::ZERO);
        assert_eq!(fetch_nonce(port, Duration::from_secs(1)), None);
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
    }

    #[test]
    fn honors_short_absolute_timeout() {
        let body = format!(r#"{{"nonce":"{NONCE}"}}"#);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (port, server) =
            serve_once_capturing(vec![response.into_bytes()], Duration::from_millis(100));
        assert_eq!(fetch_nonce(port, Duration::from_millis(20)), None);
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("POST /nonce HTTP/1.1\r\n"));
    }

    fn discovery_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn probe_liveness_hits_discovery_and_accepts_motrix_shape() {
        let body = r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"i","appVersion":"2.0.0","extensionPairing":{"protocol":"mbp1"}}"#;
        let (port, server) = serve_once_capturing(vec![discovery_response(body)], Duration::ZERO);
        assert!(probe_liveness(port, Duration::from_secs(1)));
        let request = server.join().expect("fake bridge thread");
        assert!(request.starts_with("GET /discovery HTTP/1.1\r\n"));
    }

    #[test]
    fn probe_liveness_rejects_malformed_html_and_wrong_app_bodies() {
        for body in [
            r#"{"app":"motrix-bridge""#,
            "<html><body>another service</body></html>",
            r#"{"app":"other-service","apiVersion":1,"instanceId":"i","appVersion":"2.0.0"}"#,
        ] {
            let (port, server) =
                serve_once_capturing(vec![discovery_response(body)], Duration::ZERO);
            assert!(!probe_liveness(port, Duration::from_secs(1)), "{body}");
            let request = server.join().expect("fake bridge thread");
            assert!(request.starts_with("GET /discovery HTTP/1.1\r\n"));
        }
    }

    #[test]
    fn probe_liveness_rejects_incompatible_or_unreasonable_motrix_shape() {
        for body in [
            r#"{"app":"motrix-bridge","apiVersion":2,"instanceId":"i","appVersion":"2.0.0"}"#,
            r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"","appVersion":"2.0.0"}"#,
            r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"bad id","appVersion":"2.0.0"}"#,
            r#"{"app":"motrix-bridge","apiVersion":1,"instanceId":"i","appVersion":""}"#,
        ] {
            let (port, server) =
                serve_once_capturing(vec![discovery_response(body)], Duration::ZERO);
            assert!(!probe_liveness(port, Duration::from_secs(1)), "{body}");
            server.join().expect("fake bridge thread");
        }
    }

    #[test]
    fn probe_liveness_bounds_discovery_body_and_fields() {
        let long_instance = "x".repeat(MAX_DISCOVERY_FIELD_BYTES + 1);
        let body = format!(
            r#"{{"app":"motrix-bridge","apiVersion":1,"instanceId":"{long_instance}","appVersion":"2.0.0"}}"#
        );
        let (port, server) = serve_once_capturing(vec![discovery_response(&body)], Duration::ZERO);
        assert!(!probe_liveness(port, Duration::from_secs(1)));
        server.join().expect("fake bridge thread");

        let padding = "x".repeat(MAX_DISCOVERY_BODY_BYTES);
        let body = format!(
            r#"{{"app":"motrix-bridge","apiVersion":1,"instanceId":"i","appVersion":"2.0.0","padding":"{padding}"}}"#
        );
        let (port, server) = serve_once_capturing(vec![discovery_response(&body)], Duration::ZERO);
        assert!(!probe_liveness(port, Duration::from_secs(1)));
        server.join().expect("fake bridge thread");
    }

    #[test]
    fn probe_liveness_rejects_non_2xx_and_dead_port() {
        let response = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec();
        let (port, server) = serve_once_capturing(vec![response], Duration::ZERO);
        assert!(!probe_liveness(port, Duration::from_secs(1)));
        server.join().expect("fake bridge thread");
        assert!(!probe_liveness(0, Duration::from_secs(1)));
    }

    #[test]
    fn chunk_decoder_rejects_body_over_limit() {
        let encoded = format!(
            "{:X}\r\n{}\r\n0\r\n\r\n",
            MAX_HTTP_BODY_BYTES + 1,
            "x".repeat(MAX_HTTP_BODY_BYTES + 1)
        );
        assert!(matches!(
            decode_chunked(encoded.as_bytes()),
            ChunkDecode::Invalid
        ));
    }
}
