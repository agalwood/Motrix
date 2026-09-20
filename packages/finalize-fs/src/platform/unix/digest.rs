use sha2::{Digest, Sha256};
use std::io;
use std::os::fd::RawFd;

pub(super) struct Sha256State(Sha256);

impl Sha256State {
    pub(super) fn new() -> Self {
        Self(Sha256::new())
    }
    pub(super) fn update(&mut self, input: &[u8]) {
        self.0.update(input);
    }
    pub(super) fn finalize(self) -> [u8; 32] {
        self.0.finalize().into()
    }
}

pub(super) fn hash_opened_file(opened: RawFd) -> io::Result<[u8; 32]> {
    if unsafe { libc::lseek(opened, 0, libc::SEEK_SET) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut hash = Sha256State::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = unsafe { libc::read(opened, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read as usize]);
    }
    Ok(hash.finalize())
}
