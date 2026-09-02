//! Length-prefixed JSON sidecar entrypoint.

mod error;
mod path;
mod platform;
mod protocol;
mod state;

use protocol::{Request, Response, read_frame, write_frame};
use state::State;
use std::io;

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut state = State::new();
    while let Some(frame) = read_frame(&mut input)? {
        let response = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => state.handle(request),
            Err(error) => Response::error(None, "invalid_request", error),
        };
        write_frame(&mut output, &response)?;
    }
    Ok(())
}
