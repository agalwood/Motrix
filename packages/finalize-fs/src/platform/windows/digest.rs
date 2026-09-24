use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek};
use std::os::windows::io::OwnedHandle;

pub(super) fn hash_opened_file(handle: &OwnedHandle) -> io::Result<[u8; 32]> {
    let mut file = File::from(handle.try_clone()?);
    file.rewind()?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}
