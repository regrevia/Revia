//! WP-517: a capability policy carrying a byte-order mark is refused as such.
//!
//! Section 3.5 lists `not-json` as the reason for text the parser cannot
//! decode, and that token also covered a policy file that was perfectly good
//! JSON behind a UTF-8 byte-order mark. The source reader refuses those same
//! bytes with `byte-order-mark-not-allowed`, and the project manifest learned
//! the same rule in WP-171. The policy artifact was the last text input where
//! the mark was neither refused nor reported: it fell through to `not-json`,
//! which says the text is malformed when the text is fine and only the encoding
//! prefix is not.
//!
//! The case starts from the same program and schema registry as the rest of the
//! policy negatives and changes only the first three bytes of the policy, so a
//! failure can only come from the leading mark. It pins the whole observable
//! rejection: exit status 65, a single diagnostic on stderr, the `ok:false`
//! envelope with its schema identity, and the reason token by exact equality.
//! It also pins the counterpart — the same policy without the mark still
//! parses — so the fix cannot be "refuse more".

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const INPUT_DIGEST: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const HOST_RESULT_SCHEMA: &str = "re.native-host-execution-result@0.1.0";

const REGISTRY: &str = r#"{"schema":"revia.host-schema-definitions@0.1.0","definitions":[{"identity":"revia.clock","revision":"0.1.0","members":{"monotonic_nanos":{"params":[],"returns":"number.i64"}}}]}"#;

const SOURCE: &str = r#"re 0.1 compact

unit @probe

cap @clock: revia.clock@0.1.0

fn @main() -> process.status {
  %n = @clock.monotonic_nanos()
  return match %n {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

const POLICY: &str = r#"{"grants":[{"reference":"revia.clock","members":["monotonic_nanos"]}],"schema":"revia.capability-policy@0.1.0"}"#;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp517-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

#[test]
fn a_capability_policy_with_a_byte_order_mark_is_refused_as_a_mark() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("probe.re");
    let registry_path = root.join("registry.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, REGISTRY).unwrap();

    // The same policy without the mark must still parse, or the rejection
    // below would only prove that nothing parses.
    let plain_path = root.join("plain.json");
    fs::write(&plain_path, POLICY).unwrap();
    let plain = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        plain_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    let plain_err = text(&plain.stderr);
    assert!(
        !plain_err.contains("byte-order-mark-not-allowed"),
        "an unmarked policy must not report a mark: {plain_err}"
    );
    assert!(
        !plain_err.contains("not-json"),
        "an unmarked policy is valid JSON: {plain_err}"
    );

    let marked_path = root.join("marked.json");
    let mut bytes = Vec::from("\u{feff}".as_bytes());
    bytes.extend_from_slice(POLICY.as_bytes());
    fs::write(&marked_path, &bytes).unwrap();
    let marked = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        marked_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);

    assert_eq!(
        marked.status.code(),
        Some(65),
        "a marked policy is refused: {}",
        text(&marked.stdout)
    );
    let refused = text(&marked.stderr);
    assert!(
        refused.contains(&format!(
            r#"{{"diagnostics":[{{"code":"byte-order-mark-not-allowed"}}],"ok":false,"schema":"{HOST_RESULT_SCHEMA}"}}"#
        )),
        "the mark is named in the full envelope: {refused}"
    );
    assert!(
        !refused.contains("not-json"),
        "the mark is a mark, not malformed JSON: {refused}"
    );

    fs::remove_dir_all(&root).unwrap();
}
