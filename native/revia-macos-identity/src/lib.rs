#![deny(unsafe_code)]

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerIdentity {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerIdentityError {
    UnsupportedPlatform,
    LookupFailed,
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn peer_identity(
    stream: &std::os::unix::net::UnixStream,
) -> Result<PeerIdentity, PeerIdentityError> {
    use std::{mem::MaybeUninit, os::fd::AsRawFd};

    unsafe extern "C" {
        fn getpeereid(socket: i32, euid: *mut u32, egid: *mut u32) -> i32;
    }

    let mut uid = MaybeUninit::<u32>::uninit();
    let mut gid = MaybeUninit::<u32>::uninit();
    // SAFETY: `stream` owns a live Unix socket descriptor. Both output pointers
    // are valid writable storage for the macOS `uid_t`/`gid_t` values and are
    // read only after the documented zero return code.
    let status = unsafe { getpeereid(stream.as_raw_fd(), uid.as_mut_ptr(), gid.as_mut_ptr()) };
    if status != 0 {
        return Err(PeerIdentityError::LookupFailed);
    }
    Ok(PeerIdentity {
        // SAFETY: guarded by the successful `getpeereid` result above.
        uid: unsafe { uid.assume_init() },
        // SAFETY: guarded by the successful `getpeereid` result above.
        gid: unsafe { gid.assume_init() },
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn peer_identity(
    _stream: &std::os::unix::net::UnixStream,
) -> Result<PeerIdentity, PeerIdentityError> {
    Err(PeerIdentityError::UnsupportedPlatform)
}
