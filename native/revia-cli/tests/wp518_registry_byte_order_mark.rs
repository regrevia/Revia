//! WP-518: a schema registry carrying a byte-order mark is refused as such.
//!
//! `parse_registry` reports every JSON failure as
//! `declared-schema-registry-invalid` with `actual: "json"`. A registry that
//! opens with a UTF-8 byte-order mark decodes as valid text, so it reached the
//! parser and came back as a JSON failure — the same misdirection the project
//! manifest (WP-171) and the capability policy (WP-174) each had. The registry
//! is the last artifact read through `parse_json` where the mark still has no
//! name of its own.
//!
//! The case keeps the registry text byte-identical apart from the leading mark,
//! so a difference in the outcome can only come from the mark, and it pins the
//! counterpart — the unmarked registry still compiles — so the fix cannot be
//! "refuse more".

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// A registry with no declarations: enough to be read, not enough to matter.
const REGISTRY: &str = r#"{"schema":"revia.host-schema-definitions@0.1.0","definitions":[]}"#;

const BOM: &[u8] = &[0xef, 0xbb, 0xbf];

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp518-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn a_schema_registry_with_a_byte_order_mark_is_refused_as_a_mark() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    // A program with no declared capabilities: nothing else can fail.
    let source_path = root.join("probe.re");
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/golden/canonical-args-check.re"),
        &source_path,
    )
    .unwrap();

    let plain_path = root.join("plain-registry.json");
    fs::write(&plain_path, REGISTRY).unwrap();
    let plain = run([
        "compile",
        "--schema-registry",
        plain_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        root.join("plain.bin").to_str().unwrap(),
    ]);
    let plain_out = String::from_utf8_lossy(&plain.stdout).trim_end().to_owned();
    assert!(
        plain.status.success(),
        "an unmarked registry compiles: {plain_out}"
    );
    assert!(
        !plain_out.contains("byte-order-mark-not-allowed"),
        "an unmarked registry must not report a mark: {plain_out}"
    );

    let marked_path = root.join("marked-registry.json");
    let mut bytes = Vec::from(BOM);
    bytes.extend_from_slice(REGISTRY.as_bytes());
    fs::write(&marked_path, &bytes).unwrap();
    let marked = run([
        "compile",
        "--schema-registry",
        marked_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        root.join("marked.bin").to_str().unwrap(),
    ]);

    assert_eq!(
        marked.status.code(),
        Some(65),
        "a marked registry is refused: {}",
        String::from_utf8_lossy(&marked.stdout).trim_end()
    );
    let refused = String::from_utf8_lossy(&marked.stdout)
        .trim_end()
        .to_owned();
    assert!(
        refused.contains(r#""code":"declared-schema-registry-invalid""#),
        "the registry keeps its own class: {refused}"
    );
    assert!(
        refused.contains(r#""actual":"byte-order-mark-not-allowed""#),
        "the mark is named, not reported as unreadable JSON: {refused}"
    );

    fs::remove_dir_all(&root).unwrap();
}
