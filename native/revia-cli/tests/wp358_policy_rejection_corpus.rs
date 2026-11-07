//! WP-358: every documented capability-policy rejection, driven through the CLI.
//!
//! `docs/work-packages/availability.md` section 3.5 lists the exact
//! `native-capability-policy-invalid:<reason>` vocabulary the parser is
//! expected to produce, but only two of those reasons had a CLI negative: the
//! rest were pinned by core-level unit tests or, for two defensive branches, by
//! inspection alone. That left the section 3.6 finding "No CLI negative for
//! every bridge error variant" open.
//!
//! This file closes the policy-parsing half of it. Each case starts from the
//! same program and the same schema registry and changes only the policy text,
//! so a failure can only come from the parser branch under test. Every case
//! asserts the whole observable contract of a rejection: exit status 65, a
//! single diagnostic on stderr (stdout stays empty), the `ok:false` envelope
//! with its schema identity, and the reason token by exact equality rather than
//! by substring. The substring form would silently accept a longer token such
//! as `grant-member-empty:...` matching a shorter prefix.
//!
//! One reason in section 3.5 is not reachable from here and is named rather
//! than omitted: `native-host-bridge-declared-member-unknown` is produced when
//! a call reaches a member the registry declares but the bound host does not
//! know. The CLI builds `DeclaredCapabilityHost` from the very registry the
//! graph was checked against, so the two sets cannot disagree through this
//! entry point; the branch is pinned at the core boundary by
//! `wp351_declared_host_dispatch` instead. `grant-member-duplicate` and the two
//! `duplicate-field` branches are covered below where the parser can be driven
//! to them by text.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const INPUT_DIGEST: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const HOST_RESULT_SCHEMA: &str = "re.native-host-execution-result@0.1.0";

const PREFIX: &str = "native-capability-policy-invalid:";

/// One declared production member is enough: the rejection never reaches it.
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

const DOC: &str = "docs/work-packages/availability.md";

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("revia-wp358-{}-{nanos}-{n}", std::process::id()))
}

fn run<const N: usize>(args: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

/// One row per reason the text-driven parser branches can produce.
///
/// The expected code is written out in full, including the interpolated
/// reference or member name, so a change in what gets interpolated also fails
/// here.
fn cases() -> Vec<(&'static str, String, String)> {
    let row =
        |name: &'static str, policy: &str| (name, policy.to_owned(), format!("{PREFIX}{name}"));
    vec![
        row("not-json", "not json"),
        row("not-an-object", "[]"),
        row(
            "unknown-field:extra",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[],"extra":1}"#,
        ),
        row("missing-field:schema", r#"{"grants":[]}"#),
        row(
            "schema-unsupported:revia.capability-policy@9.9.9",
            r#"{"schema":"revia.capability-policy@9.9.9","grants":[]}"#,
        ),
        row("schema-not-text", r#"{"schema":5,"grants":[]}"#),
        row(
            "grants-not-an-array",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":{}}"#,
        ),
        row(
            "grant-not-an-object",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":["x"]}"#,
        ),
        row(
            "unknown-grant-field:x",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":["monotonic_nanos"],"x":1}]}"#,
        ),
        row(
            "missing-grant-field:reference",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"members":["monotonic_nanos"]}]}"#,
        ),
        row(
            "missing-grant-field:members",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0"}]}"#,
        ),
        row(
            "grant-reference-not-text",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":5,"members":["monotonic_nanos"]}]}"#,
        ),
        row(
            "grant-reference-empty",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"","members":["monotonic_nanos"]}]}"#,
        ),
        row(
            "grant-members-not-an-array",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":"monotonic_nanos"}]}"#,
        ),
        row(
            "grant-members-empty:revia.clock@0.1.0",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":[]}]}"#,
        ),
        row(
            "grant-member-not-text:revia.clock@0.1.0",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":[5]}]}"#,
        ),
        row(
            "grant-member-empty:revia.clock@0.1.0",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":[""]}]}"#,
        ),
        row(
            "grant-member-duplicate:revia.clock@0.1.0.monotonic_nanos",
            r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"revia.clock@0.1.0","members":["monotonic_nanos","monotonic_nanos"]}]}"#,
        ),
    ]
}

/// The diagnostics array, read back as the one code it must contain.
fn only_code(stdout: &str, stderr: &str) -> String {
    assert_eq!(
        stdout, "",
        "a policy rejection must not print a program result: {stdout}"
    );
    let marker = "\"diagnostics\":[{\"code\":";
    let start = stderr
        .find(marker)
        .unwrap_or_else(|| panic!("no diagnostics array on stderr: {stderr}"))
        + marker.len();
    let rest = &stderr[start..];
    assert!(
        rest.starts_with('"'),
        "diagnostic code is not a JSON string: {stderr}"
    );
    rest[1..rest[1..].find('"').expect("unterminated code") + 1].to_owned()
}

#[test]
fn every_documented_policy_rejection_reason_is_pinned_at_the_cli() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("probe.re");
    let registry_path = root.join("registry.json");
    let policy_path = root.join("policy.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, REGISTRY).unwrap();

    let cases = cases();
    assert_eq!(
        cases.len(),
        18,
        "the documented vocabulary has 18 text-driven reasons"
    );

    let mut ran = Vec::new();
    for (name, policy, expected) in cases {
        fs::write(&policy_path, &policy).unwrap();
        let executed = run([
            "execute",
            "--schema-registry",
            registry_path.to_str().unwrap(),
            "--capability-policy",
            policy_path.to_str().unwrap(),
            source_path.to_str().unwrap(),
            INPUT_DIGEST,
        ]);
        let stdout = String::from_utf8_lossy(&executed.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&executed.stderr).into_owned();

        assert_eq!(
            executed.status.code(),
            Some(65),
            "case {name} did not fail as a source/contract failure: {stderr}"
        );
        assert_eq!(only_code(&stdout, &stderr), expected, "case {name}");
        assert!(
            stderr.contains(&format!(r#""schema":"{HOST_RESULT_SCHEMA}""#)),
            "case {name} lost the host result schema: {stderr}"
        );
        assert!(
            stderr.contains(r#""ok":false"#),
            "case {name} is not a refusal envelope: {stderr}"
        );
        ran.push(name);
    }

    assert_eq!(ran.len(), 18);
    fs::remove_dir_all(root).unwrap();
}

/// A policy that parses but grants nothing fails closed before execution.
///
/// The precise adapter refusal is not what a caller sees: the VM replaces every
/// non-value bridge response with `native-vm-capability-failed`, which is the
/// open compatibility question recorded in section 3.6. Asserting the collapsed
/// code here keeps the current behaviour pinned from a second fixture instead of
/// implying the precise code is observable.
#[test]
fn a_policy_rejection_never_reaches_execution() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("probe.re");
    let registry_path = root.join("registry.json");
    let policy_path = root.join("policy.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, REGISTRY).unwrap();
    fs::write(
        &policy_path,
        r#"{"schema":"revia.capability-policy@0.1.0","grants":[]}"#,
    )
    .unwrap();

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    let stderr = String::from_utf8_lossy(&executed.stderr).into_owned();
    assert_eq!(executed.status.code(), Some(65));
    assert!(
        stderr.contains(r#""code":"native-vm-capability-failed""#),
        "{stderr}"
    );
    assert!(!stderr.contains("monotonic_nanos"), "{stderr}");
    for absent in ["invocations", "receipt_digest", "program_stdout", "outcome"] {
        assert!(
            !stderr.contains(absent),
            "a pre-execution refusal carried {absent}: {stderr}"
        );
    }

    fs::remove_dir_all(root).unwrap();
}

/// The vocabulary in the test and the vocabulary in the work package must not
/// drift apart: every reason tested here is named in section 3.5, including the
/// interpolated placeholders the prose writes as `<name>` / `<reference>`.
#[test]
fn the_tested_vocabulary_matches_the_documented_one() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let doc = fs::read_to_string(root.join(DOC)).expect("the repository root holds the docs");
    let section = doc
        .split("### 3.5 Rejection vocabulary")
        .nth(1)
        .expect("section 3.5 is missing")
        .split("### 3.6")
        .next()
        .unwrap();

    for (name, _, expected) in cases() {
        let head = expected
            .strip_prefix(PREFIX)
            .unwrap()
            .split(':')
            .next()
            .unwrap();
        assert!(
            section.contains(&format!("`{head}`")) || section.contains(&format!("`{head}:")),
            "case {name}: {head} is not documented in section 3.5"
        );
    }
    // The two `duplicate-field` branches cannot be reached through text
    // (`parse_json` collapses duplicate keys) and section 3.5 says so; this
    // asserts that sentence stays next to the vocabulary.
    assert!(section.contains("duplicate-field"));
    assert!(section.contains("pinned by\ninspection"));
}
