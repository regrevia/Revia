//! WP-361: `runtime-run --print-values` reports the same value evidence the
//! one-shot `execute` path reports, and adds nothing to any receipt digest.
//!
//! `runtime-run` replays a packaged artifact from a runtime bundle; before this
//! work package it could not print capability values at all, so the bundled path
//! and the one-shot path disagreed about the only observable that `--print-values`
//! exists to expose. The flag stays opt-in and out of every digest: the default
//! output is byte-identical to the previous behaviour, and the value-bearing
//! output differs from it only by the additive `invocation_values` member.
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::digest::sha256_hex;

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn runtime_run_print_values_matches_the_one_shot_execute_evidence() {
    let root = fixture("parity");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    package(&source, &bundle);

    let staged = run(&[
        "execute",
        "--print-values",
        source.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert!(staged.status.success(), "{}", text(&staged.stderr));
    assert!(staged.stderr.is_empty());

    let replayed = run(&[
        "runtime-run",
        "--print-values",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(replayed.status.success(), "{}", text(&replayed.stderr));
    assert!(replayed.stderr.is_empty());

    // Same artifact, same request, same evidence: the bundled path must not be
    // a weaker observer of the capability it just invoked.
    assert_eq!(text(&replayed.stdout), text(&staged.stdout));
    let printed = text(&replayed.stdout);
    assert!(printed.contains("\"invocation_values\":[{\"type\":\"unit\",\"value\":null}]"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_run_without_the_flag_is_unchanged_and_prints_no_values() {
    let root = fixture("default");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    package(&source, &bundle);

    let default_run = run(&[
        "runtime-run",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(
        default_run.status.success(),
        "{}",
        text(&default_run.stderr)
    );
    let default_source = text(&default_run.stdout);
    assert!(!default_source.contains("invocation_values"));

    // The default output is exactly what the one-shot path prints, so enabling
    // the flag on a replay cannot have shifted the default contract.
    let staged = run(&["execute", source.to_str().unwrap(), INPUT_DIGEST]);
    assert!(staged.status.success(), "{}", text(&staged.stderr));
    assert_eq!(default_source, text(&staged.stdout));

    let with_values = run(&[
        "runtime-run",
        "--print-values",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(
        with_values.status.success(),
        "{}",
        text(&with_values.stderr)
    );
    // The only difference is the additive member: removing it restores the
    // default bytes exactly.
    let values_source = text(&with_values.stdout);
    let member = "\"invocation_values\":[{\"type\":\"unit\",\"value\":null}],";
    assert!(values_source.contains(member));
    assert_eq!(values_source.replace(member, ""), default_source);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_run_print_values_does_not_move_the_authority_receipt() {
    let root = fixture("receipt");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    let pin = root.join("runtime.pin.json");
    let receipt = root.join("runtime.receipt.json");
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    package(&source, &bundle);

    let pinned = run(&[
        "runtime-authority-pin",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        pin.to_str().unwrap(),
    ]);
    assert!(pinned.status.success(), "{}", text(&pinned.stderr));

    let executed = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        "--authority-receipt",
        receipt.to_str().unwrap(),
        "--print-values",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        root.to_str().unwrap(),
    ]);
    assert!(executed.status.success(), "{}", text(&executed.stderr));
    let printed = text(&executed.stdout);
    assert!(printed.contains("\"invocation_values\":"));
    // The receipt binds the bytes that were actually printed, so the evidence
    // member is covered by the result digest rather than escaping it.
    let receipt_source = fs::read_to_string(&receipt).unwrap();
    assert!(receipt_source.contains(&format!(
        "\"result_digest\":\"sha256:{}\"",
        sha256_hex(&executed.stdout)
    )));
    // And the VM receipt digest itself does not move: `--print-values` is
    // evidence outside the digest, never part of it.
    let vm_receipt = digest_field(&printed, "receipt_digest");
    assert!(receipt_source.contains(&format!("\"vm_receipt_digest\":\"{vm_receipt}\"")));

    fs::remove_dir_all(root).unwrap();
}

fn digest_field(source: &str, name: &str) -> String {
    let marker = format!("\"{name}\":\"");
    let start = source.find(&marker).expect("field present") + marker.len();
    let rest = &source[start..];
    rest[..rest.find('"').expect("closing quote")].to_owned()
}

fn package(source: &std::path::Path, bundle: &std::path::Path) {
    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn fixture(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "revia-wp361-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root).unwrap();
    root
}
