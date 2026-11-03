// WP-345 acceptance test: the host adapter boundary that any external library
// must cross is currently closed to out-of-tree members.
//
// Route H in `doc/12-library-strategy.md` says an external library enters Revia as
// a host adapter behind a declared capability schema. This test pins the part of
// that route that already holds today: a member the host does not declare fails
// closed, before any IO, and with a stable typed error. It will have to change
// when §6.1 of doc/12 opens the operation namespace; that change is the point.

use std::collections::BTreeMap;

use revia_core::minimal_std::{HostEnvironment, HostOutcome, HostRequest, MemoryHost, StdError};

fn host_with_file(path: &str, contents: &[u8]) -> HostEnvironment<MemoryHost> {
    let mut memory = MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new());
    memory.seed_files(BTreeMap::from([(path.to_owned(), contents.to_vec())]));
    HostEnvironment::new(memory)
}

#[test]
fn declared_member_reaches_the_host() {
    let mut host = host_with_file("read.txt", b"library");

    assert_eq!(
        host.invoke(HostRequest::file_read("read.txt")).unwrap(),
        HostOutcome::Text("library".to_owned())
    );
}

#[test]
fn undeclared_library_member_fails_closed_before_any_io() {
    let mut host = host_with_file("read.txt", b"library");

    assert_eq!(
        host.invoke(HostRequest::unknown("vendor.json.encode"))
            .unwrap_err(),
        StdError::UnknownOperation
    );

    // Fail-closed means "no effect happened", not "the call returned an error
    // after doing the work". The file is still readable and nothing was written.
    assert_eq!(
        host.invoke(HostRequest::file_read("read.txt")).unwrap(),
        HostOutcome::Text("library".to_owned())
    );
    assert_eq!(
        host.invoke(HostRequest::file_write("written.txt", b"x".to_vec()))
            .unwrap(),
        HostOutcome::Unit
    );
    assert_eq!(
        host.invoke(HostRequest::file_read("written.txt")).unwrap(),
        HostOutcome::Text("x".to_owned())
    );
}

#[test]
fn undeclared_library_member_error_is_stable_across_repetitions() {
    let mut host = host_with_file("read.txt", b"library");

    // Three identical rejections: no panic, no lock poisoning, no state drift.
    for _ in 0..3 {
        assert_eq!(
            host.invoke(HostRequest::unknown("vendor.sqlite.query"))
                .unwrap_err(),
            StdError::UnknownOperation
        );
    }
}

#[test]
fn adapter_side_unknown_names_are_the_only_open_axis() {
    let mut host = host_with_file("read.txt", b"library");

    // Every external-library member name currently lands in the same closed
    // branch, regardless of shape. Documented in doc/12-library-strategy.md §4.1.
    for name in [
        "vendor.json.encode",
        "vendor.sqlite.query",
        "vendor.crypto.sha256",
        "vendor.time.now",
    ] {
        assert_eq!(
            host.invoke(HostRequest::unknown(name)).unwrap_err(),
            StdError::UnknownOperation,
            "undeclared member {name} must fail closed"
        );
    }
}
