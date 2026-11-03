// WP-345 acceptance test: the direct-invocation branch of an undeclared host
// member.
//
// Route H in `doc/12-library-strategy.md` is where an external library enters
// Revia as a host adapter. Admission for that route is a closed vocabulary
// spread over eight hardcoded sites (blocker 1 there), from the check-time
// schema allowlist and member table to the runtime request, response, error and
// observation mappings; none of them is exercised here. What this file pins is
// the contract underneath all of them: an adapter handed an undeclared member
// through `HostEnvironment::invoke` must fail closed with a typed error, before
// any IO.
//
// Which cases carry which weight: the second test pins closed failure and the
// absence of side effects; the third adds stability across repetitions; the
// fourth adds independence from the name shape. `wp257_minimal_std_host.rs`
// already asserts a single rejection directly.
//
// When doc/12 §6 item 1 lands, revisit this file: all four cases remain valid
// (undeclared members must stay rejected), but the admission path above them
// changes.

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
fn every_undeclared_member_name_lands_in_the_same_rejection() {
    let mut host = host_with_file("read.txt", b"library");

    // Direct invocation only: every undeclared name reaches the same rejecting
    // arm, independent of shape. The admission gates sit above this branch; see
    // doc/12-library-strategy.md, blocker 1.
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
