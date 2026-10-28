#![cfg(target_os = "macos")]

use std::{
    fs,
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_macos_identity::peer_identity;

#[test]
fn connected_unix_peers_expose_the_same_kernel_identity_when_they_share_an_account() {
    let socket = temporary_socket();
    let listener = UnixListener::bind(&socket).unwrap();
    let (sender, receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        sender.send(peer_identity(&stream)).unwrap();
    });
    let client = UnixStream::connect(&socket).unwrap();
    let client_identity = peer_identity(&client).unwrap();
    let server_identity = receiver.recv().unwrap().unwrap();
    server.join().unwrap();

    assert_eq!(client_identity, server_identity);
    fs::remove_file(socket).unwrap();
}

fn temporary_socket() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("revia-wp313-{nonce}.sock"))
}
