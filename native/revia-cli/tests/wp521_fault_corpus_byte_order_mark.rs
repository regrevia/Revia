//! WP-521: a fault observation corpus carrying a byte-order mark is named.
//!
//! `parse_native_fault_corpus` reports every JSON failure as
//! `native-fault-corpus-json-invalid`. A corpus that opens with a UTF-8
//! byte-order mark decodes as ordinary text, so nothing upstream refuses it,
//! and it came back as unreadable JSON — pointing the reader at a syntax error
//! the document does not contain.
//!
//! The plain corpus is refused by the corpus's own rules
//! (`schema-or-size-invalid`), which shows the JSON layer accepted those bytes.
//! The two inputs differ only in the leading mark, so only the mark can explain
//! the different verdict, and it is now named as such.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// A well-formed corpus with no cases: refused by the corpus's own size rule,
/// but only after the JSON layer has accepted the bytes.
const CORPUS: &str = "{\"cases\":[],\"schema\":\"re.native-fault-observation-corpus@0.1.0\"}\n";

const BOM: &[u8] = &[0xef, 0xbb, 0xbf];

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp521-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

/// The refusal code carried by a report's diagnostics-only envelope.
fn refusal(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).trim_end().to_owned();
    let Some(rest) = text.split("\"code\":\"").nth(1) else {
        return text;
    };
    rest.split('"').next().unwrap_or(rest).to_owned()
}

#[test]
fn a_fault_corpus_with_a_byte_order_mark_is_refused_as_a_mark() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let report = root.join("report.json");

    let plain_path = root.join("plain-corpus.json");
    fs::write(&plain_path, CORPUS).unwrap();
    let plain = run([
        "replay-fault-corpus",
        plain_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);
    assert_eq!(
        plain.status.code(),
        Some(65),
        "the plain corpus is refused by its own rules: {}",
        String::from_utf8_lossy(&plain.stderr).trim_end()
    );
    assert_eq!(
        refusal(&plain.stderr),
        "native-fault-corpus-schema-or-size-invalid",
        "the plain corpus got past the JSON layer"
    );

    let marked_path = root.join("marked-corpus.json");
    let mut bytes = Vec::from(BOM);
    bytes.extend_from_slice(CORPUS.as_bytes());
    fs::write(&marked_path, &bytes).unwrap();
    let marked = run([
        "replay-fault-corpus",
        marked_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);
    assert_eq!(
        marked.status.code(),
        Some(65),
        "a marked corpus is refused: {}",
        String::from_utf8_lossy(&marked.stderr).trim_end()
    );
    assert_eq!(
        refusal(&marked.stderr),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as unreadable JSON"
    );

    // The JSON class still belongs to text that really is malformed.
    let junk_path = root.join("junk-corpus.json");
    fs::write(&junk_path, "not json\n").unwrap();
    let junk = run([
        "replay-fault-corpus",
        junk_path.to_str().unwrap(),
        report.to_str().unwrap(),
    ]);
    assert_eq!(
        refusal(&junk.stderr),
        "native-fault-corpus-json-invalid",
        "malformed JSON keeps its own code"
    );

    fs::remove_dir_all(&root).unwrap();
}
