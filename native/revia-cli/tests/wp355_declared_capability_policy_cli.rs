//! WP-355: the declared-capability production execution closure.
//!
//! WP-352/353 took a declaring graph to the host boundary and WP-354 proved a
//! test-local adapter can answer it. This file is the production path: the real
//! `revia` binary, the real `SystemHost`, a registry-declared member, and an
//! explicit authorization artifact between them.
//!
//! The registry declares a member's shape; it never authorizes the call. So a
//! declaring graph without `--capability-policy` is refused before a host is
//! built (`native-host-capability-policy-missing`), a policy that grants what
//! the toolchain does not implement is refused at binding
//! (`native-host-capability-policy-not-served`), and a granted-but-ungranted
//! member stays fail-closed at the adapter
//! (`native-host-bridge-capability-denied`).

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const INPUT_DIGEST: &str =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/// Calls one declared member whose result the program consumes.
///
/// The compact grammar of this release consumes a call result with `match`
/// immediately, and only binds `_` there, so the program's proof is the exit
/// status: `0` only happens when the host answered `ok`. Member semantics
/// (the joined text, the counted scalars) are unit-tested next to the adapter.
const SOURCE: &str = r#"re 0.1 compact

unit @declared

cap @strings: revia.strings@0.1.0

fn @main() -> process.status {
  %joined = @strings.concat(left: "ab", right: "cd")
  return match %joined {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
"#;

/// The same program calling the other member of the family.
const SOURCE_SCALAR_COUNT: &str = r#"re 0.1 compact

unit @declared

cap @strings: revia.strings@0.1.0

fn @main() -> process.status {
  %count = @strings.scalar_count(value: "abcd")
  return match %count {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
"#;

const REGISTRY: &str = r#"{"definitions":[{"identity":"revia.strings","members":{"concat":{"errors":["output_limit"],"params":[{"name":"left","type":"text.utf8"},{"name":"right","type":"text.utf8"}],"returns":"result<text.utf8, text.error>"},"scalar_count":{"params":[{"name":"value","type":"text.utf8"}],"returns":"number.i64"}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

/// Grants `concat` only.
const POLICY_CONCAT: &str = r#"{"grants":[{"members":["concat"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

/// Grants a different member of the same family, so `concat` stays denied.
const POLICY_SCALAR_COUNT: &str = r#"{"grants":[{"members":["scalar_count"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

/// Grants a declared member this toolchain implements nothing for.
const POLICY_UNIMPLEMENTED: &str = r#"{"grants":[{"members":["say"],"reference":"demo.echo@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

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
        "revia-wp355-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

fn fixture(registry: &str) -> (PathBuf, PathBuf, PathBuf) {
    fixture_with(registry, SOURCE)
}

fn fixture_with(registry: &str, program: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("declared.re");
    let registry_path = root.join("registry.json");
    fs::write(&source_path, program).unwrap();
    fs::write(&registry_path, registry).unwrap();
    (root, source_path, registry_path)
}

fn write_policy(root: &Path, policy: &str) -> PathBuf {
    let path = root.join("policy.json");
    fs::write(&path, policy).unwrap();
    path
}

/// The binary writes diagnostics to stdout at the host boundary and runtime
/// failures to stderr, so a check reads both.
fn both(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn a_granted_implemented_member_runs_end_to_end() {
    let (root, source_path, registry_path) = fixture(REGISTRY);
    let policy_path = write_policy(&root, POLICY_CONCAT);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(0));
    let output = both(&executed);
    assert!(!output.contains("diagnostics"), "{output}");
    assert!(String::from_utf8_lossy(&executed.stderr).is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_declaring_graph_without_a_policy_is_refused_before_the_host_runs() {
    let (root, source_path, registry_path) = fixture(REGISTRY);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(65));
    let output = both(&executed);
    assert!(
        output.contains("native-host-capability-policy-missing"),
        "{output}"
    );
    assert!(
        output.contains("re.native-host-execution-result@0.1.0"),
        "{output}"
    );
    assert!(output.contains("\"ok\":false"), "{output}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_missing_policy_file_is_an_input_failure() {
    let (root, source_path, registry_path) = fixture(REGISTRY);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        root.join("absent.json").to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(66));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_malformed_policy_is_refused() {
    let (root, source_path, registry_path) = fixture(REGISTRY);
    let policy_path = write_policy(&root, r#"{"grants":[]}"#);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(65));
    let output = both(&executed);
    assert!(
        output.contains("native-capability-policy-invalid:missing-field:schema"),
        "{output}"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_grant_for_an_unimplemented_member_is_refused_at_binding() {
    let (root, source_path, registry_path) = fixture(REGISTRY);
    let policy_path = write_policy(&root, POLICY_UNIMPLEMENTED);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(65));
    let output = both(&executed);
    assert!(
        output.contains("native-host-capability-policy-not-served:demo.echo@0.1.0.say"),
        "{output}"
    );
    assert!(!output.contains("abcd"), "{output}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_policy_for_another_member_of_the_family_denies_the_call() {
    let (root, source_path, registry_path) = fixture_with(REGISTRY, SOURCE);
    let policy_path = write_policy(&root, POLICY_SCALAR_COUNT);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(65));
    let output = both(&executed);
    // The adapter answers `Err(CapabilityDenied)`; the VM replaces every
    // non-value bridge response with `native-vm-capability-failed`, so the
    // run fails closed without leaking which member was refused. The precise
    // `native-host-bridge-capability-denied` diagnostic is pinned by the
    // core-level WP-354/WP-355 adapter tests, where the bridge is visible.
    assert!(output.contains("native-vm-capability-failed"), "{output}");
    assert!(!output.contains("abcd"), "{output}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn another_member_of_the_family_runs_when_it_is_the_granted_one() {
    let (root, source_path, registry_path) = fixture_with(REGISTRY, SOURCE_SCALAR_COUNT);

    let executed = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        write_policy(&root, POLICY_SCALAR_COUNT).to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&executed.stderr).is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_policy_cannot_declare_a_member_the_registry_does_not() {
    let (root, source_path, _) = fixture(REGISTRY);
    let policy_path = write_policy(&root, POLICY_CONCAT);

    let executed = run([
        "execute",
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(executed.status.code(), Some(65));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_compiled_artifact_runs_with_the_same_policy() {
    let (root, source_path, registry_path) = fixture(REGISTRY);
    let policy_path = write_policy(&root, POLICY_CONCAT);
    let artifact_path = root.join("declared.rebc");

    let compiled = run([
        "compile",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert_eq!(compiled.status.code(), Some(0));

    let without_policy = run([
        "run",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(without_policy.status.code(), Some(65));
    assert!(both(&without_policy).contains("native-host-capability-policy-missing"));

    let with_policy = run([
        "run",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        "--capability-policy",
        policy_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(with_policy.status.code(), Some(0));
    let output = both(&with_policy);
    assert!(!output.contains("capability-policy"), "{output}");
    assert!(output.contains("\"ok\":true"), "{output}");

    fs::remove_dir_all(root).unwrap();
}
