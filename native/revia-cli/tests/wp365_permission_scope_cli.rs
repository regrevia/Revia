//! WP-365: what `--capability-policy` actually governs, measured.
//!
//! The execution contract described the policy as a closed object shaped
//! `{"schema": 1, "grants": [...]}`, but the binary reads the schema as text and
//! rejects the numeric form with `native-capability-policy-invalid:schema-not-text`
//! (exit 65). WP-355's own tests already use the text form, so the docs had
//! drifted away from the shipped behavior.
//!
//! The same artifact is also narrower than "a permission boundary": it admits
//! declared host members only. A policy that grants an unrelated declared member
//! changes nothing for built-in capabilities such as `fs.read`; those are bounded
//! by the host's filesystem sandbox instead. Both facts are pinned here so the
//! documented scope and the measured scope cannot diverge again.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const INPUT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/// A program with no declared (registry-backed) capability at all: it consumes
/// one built-in `fs.read` result, so it runs whether or not a policy is present.
const SOURCE_BUILTIN_ONLY: &str = r#"re 0.1 compact

unit @policy_scope

cap @input: fs.read@0.1.0

fn @main() -> process.status {
  %contents = @input.read_file("input.txt")
  return match %contents {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

/// Grants a declared member the program does not reference.
const POLICY_UNRELATED_DECLARED: &str = r#"{"grants":[{"members":["concat"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

/// The numeric schema the execution contract used to document.
const POLICY_NUMERIC_SCHEMA: &str = r#"{"grants":[],"schema":1}"#;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn run<const N: usize>(arguments: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp365-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

fn write_file(root: &Path, name: &str, contents: &str) -> PathBuf {
    let path = root.join(name);
    fs::write(&path, contents).unwrap();
    path
}

fn both(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn execute_help_states_that_the_policy_admits_declared_members_only() {
    for topic in ["execute", "run"] {
        let help = run(["help", topic]);
        assert_eq!(help.status.code(), Some(0), "help {topic}");
        let text = both(&help);
        assert!(
            text.contains("admits declared host members only"),
            "help {topic} must state the policy scope: {text}"
        );
        assert!(
            text.contains("host sandbox"),
            "help {topic} must name where built-in capabilities are bounded: {text}"
        );
    }
}

#[test]
fn the_numeric_policy_schema_is_rejected_and_the_text_schema_is_accepted() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = write_file(&root, "scope.re", SOURCE_BUILTIN_ONLY);
    write_file(&root, "input.txt", "hello scope\n");
    let numeric = write_file(&root, "numeric.json", POLICY_NUMERIC_SCHEMA);
    let text = write_file(&root, "text.json", POLICY_UNRELATED_DECLARED);

    let rejected = run([
        "execute",
        "--capability-policy",
        numeric.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    let output = both(&rejected);
    assert!(
        output.contains("native-capability-policy-invalid:schema-not-text"),
        "{output}"
    );
    assert!(output.contains("\"ok\":false"), "{output}");

    let accepted = run([
        "execute",
        "--capability-policy",
        text.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(accepted.status.code(), Some(0));
    let output = both(&accepted);
    assert!(output.contains("\"ok\":true"), "{output}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_policy_that_admits_a_declared_member_does_not_filter_builtin_capabilities() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = write_file(&root, "scope.re", SOURCE_BUILTIN_ONLY);
    write_file(&root, "input.txt", "hello scope\n");
    let policy_path = write_file(&root, "policy.json", POLICY_UNRELATED_DECLARED);

    let executed = run([
        "execute",
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(0));
    let output = both(&executed);
    // The built-in call really ran: the policy is about declared members, and
    // the sandbox that bounds `fs.read` is a separate mechanism.
    assert!(output.contains("\"instance\":\"@input\""), "{output}");
    assert!(output.contains("\"member\":\"read_file\""), "{output}");
    assert!(output.contains("\"ok\":true"), "{output}");
    assert!(output.contains("\"outcome\":{\"code\":0,"), "{output}");

    fs::remove_dir_all(root).unwrap();
}
