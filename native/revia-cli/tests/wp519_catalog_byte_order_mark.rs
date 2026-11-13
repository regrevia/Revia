//! WP-519: a replay workload catalog carrying a byte-order mark is named as such.
//!
//! `parse_replay_workload_catalog` reports every JSON failure as
//! `replay-workload-catalog-json-invalid`, so a catalog that opens with a UTF-8
//! byte-order mark — which decodes as ordinary text, so nothing upstream
//! refuses it — came back as unreadable JSON. The mark is not JSON, but neither
//! is the document malformed, and the two want different repairs.
//!
//! The pair here differs only in the leading mark: the plain catalog reaches
//! the catalog's own structural rules (`too-few-workloads`), which proves the
//! parser accepted it, while the marked one must be refused by name.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// A well-formed catalog with no workloads: structurally rejected, but only
/// after the JSON layer has accepted the bytes.
const CATALOG: &str = "{\"schema\":\"re.native-replay-workload-catalog@0.1.0\",\"workloads\":[]}\n";

const BOM: &[u8] = &[0xef, 0xbb, 0xbf];

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp519-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn a_replay_catalog_with_a_byte_order_mark_is_refused_as_a_mark() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let report = root.join("report.json");

    // The catalog's own rules, not the JSON layer, reject the plain text: this
    // is what makes the marked run's outcome attributable to the mark alone.
    let plain_path = root.join("plain-catalog.json");
    fs::write(&plain_path, CATALOG).unwrap();
    let plain = run([
        "replay-catalog",
        plain_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);
    let plain_err = String::from_utf8_lossy(&plain.stderr).trim_end().to_owned();
    assert_eq!(
        plain.status.code(),
        Some(65),
        "the plain catalog is refused by its own rules: {plain_err}"
    );
    assert!(
        plain_err.contains("replay-workload-catalog-too-few-workloads"),
        "the plain catalog got past the JSON layer: {plain_err}"
    );

    let marked_path = root.join("marked-catalog.json");
    let mut bytes = Vec::from(BOM);
    bytes.extend_from_slice(CATALOG.as_bytes());
    fs::write(&marked_path, &bytes).unwrap();
    let marked = run([
        "replay-catalog",
        marked_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);

    assert_eq!(
        marked.status.code(),
        Some(65),
        "a marked catalog is refused: {}",
        String::from_utf8_lossy(&marked.stderr).trim_end()
    );
    let refused = String::from_utf8_lossy(&marked.stderr)
        .trim_end()
        .to_owned();
    assert!(
        refused.contains("byte-order-mark-not-allowed"),
        "the mark is named, not reported as unreadable JSON: {refused}"
    );
    assert!(
        !refused.contains("replay-workload-catalog-json-invalid"),
        "the mark is not filed as malformed JSON: {refused}"
    );

    // The JSON class still belongs to text that really is malformed.
    let junk_path = root.join("junk-catalog.json");
    fs::write(&junk_path, "not json\n").unwrap();
    let junk = run([
        "replay-catalog",
        junk_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);
    let junk_err = String::from_utf8_lossy(&junk.stderr).trim_end().to_owned();
    assert!(
        junk_err.contains("replay-workload-catalog-json-invalid"),
        "malformed JSON keeps its own code: {junk_err}"
    );

    fs::remove_dir_all(&root).unwrap();
}
