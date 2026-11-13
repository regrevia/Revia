//! WP-522: a runtime load authority pin carrying a byte-order mark is named.
//!
//! `parse_runtime_load_authority_pin` reports every JSON failure as
//! `native-runtime-load-authority-json-invalid`. A pin that opens with a UTF-8
//! byte-order mark decodes as ordinary text, so the trailing-newline check and
//! the unreadable-input check both pass, and the mark was then filed as
//! unreadable JSON — a diagnosis that sends the reader hunting for a syntax
//! error the document does not have.
//!
//! The plain pin `{}` is refused by the pin's own field rules
//! (`fields-invalid`), which proves the JSON layer accepted those bytes. The
//! two documents differ only in the leading mark, so only the mark can explain
//! the different verdict, and it is now named as such.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// A well-formed JSON document that is not a pin: refused by the pin's own
/// field rules, but only after the JSON layer has accepted the bytes.
const PIN: &str = "{}\n";

const BOM: &[u8] = &[0xef, 0xbb, 0xbf];

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp522-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

/// The refusal code carried by a diagnostics-only envelope.
fn refusal(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).trim_end().to_owned();
    let Some(rest) = text.split("\"code\":\"").nth(1) else {
        return text;
    };
    rest.split('"').next().unwrap_or(rest).to_owned()
}

#[test]
fn a_runtime_load_pin_with_a_byte_order_mark_is_refused_as_a_mark() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let receipt = root.join("receipt.json");
    let result = root.join("result.json");
    let stdout = root.join("stdout.txt");
    for path in [&receipt, &result, &stdout] {
        fs::write(path, "").unwrap();
    }
    let verify = |pin: &PathBuf| {
        run([
            "runtime-receipt-verify",
            pin.to_str().unwrap(),
            receipt.to_str().unwrap(),
            result.to_str().unwrap(),
            stdout.to_str().unwrap(),
        ])
    };

    let plain_path = root.join("plain-pin.json");
    fs::write(&plain_path, PIN).unwrap();
    let plain = verify(&plain_path);
    assert_eq!(
        plain.status.code(),
        Some(65),
        "the plain pin is refused by its own field rules: {}",
        String::from_utf8_lossy(&plain.stderr).trim_end()
    );
    assert_eq!(
        refusal(&plain.stderr),
        "native-runtime-load-authority-fields-invalid",
        "the plain pin got past the JSON layer"
    );

    let marked_path = root.join("marked-pin.json");
    let mut bytes = Vec::from(BOM);
    bytes.extend_from_slice(PIN.as_bytes());
    fs::write(&marked_path, &bytes).unwrap();
    let marked = verify(&marked_path);
    assert_eq!(
        marked.status.code(),
        Some(65),
        "a marked pin is refused: {}",
        String::from_utf8_lossy(&marked.stderr).trim_end()
    );
    assert_eq!(
        refusal(&marked.stderr),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as unreadable JSON"
    );

    // The JSON class still belongs to text that really is malformed.
    let junk_path = root.join("junk-pin.json");
    fs::write(&junk_path, "not json\n").unwrap();
    let junk = verify(&junk_path);
    assert_eq!(
        refusal(&junk.stderr),
        "native-runtime-load-authority-json-invalid",
        "malformed JSON keeps its own code"
    );

    fs::remove_dir_all(&root).unwrap();
}
