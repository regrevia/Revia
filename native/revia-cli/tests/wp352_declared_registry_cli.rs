// WP-352: `--schema-registry` on the consumption commands.
//
// Before WP-352 the registry was only reachable through `graph-check`; the
// translation and execution paths re-checked the graph without the
// declarations and rejected any declared reference. These tests pin the two
// halves of the new behavior:
//
// - without a registry a declared graph still fails with
//   `unknown-schema-reference` (the pre-registry contract, unchanged);
// - with a registry `compile`, `verify`, `run` and `execute` all admit the
//   declared schema, and the executing commands fail closed at the system host
//   adapter, which has no `Declared` implementation.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = r#"re 0.1 compact
// Declared schema, named argument.

unit @declared

cap @echo: demo.echo@0.1.0

fn @main() -> process.status {
  %echoed = @echo.say(text: "hello")
  return match %echoed {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

const REGISTRY: &str = r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}]}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

const INPUT_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn declared_graph_still_needs_a_registry() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("declared.re");
    let artifact_path = root.join("declared.rebc");
    fs::write(&source_path, SOURCE).unwrap();

    let compile = run([
        "compile",
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert_eq!(compile.status.code(), Some(65));
    assert!(
        String::from_utf8_lossy(&compile.stdout).contains("unknown-schema-reference"),
        "{}",
        String::from_utf8_lossy(&compile.stdout)
    );
    assert!(String::from_utf8_lossy(&compile.stderr).is_empty());
    assert!(!artifact_path.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn registry_admits_the_declared_schema_for_compile_and_verify() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("declared.re");
    let artifact_path = root.join("declared.rebc");
    let registry_path = root.join("registry.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, REGISTRY).unwrap();

    let graph_check = run([
        "graph-check",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
    ]);
    assert!(
        graph_check.status.success(),
        "{}",
        String::from_utf8_lossy(&graph_check.stderr)
    );
    assert!(String::from_utf8_lossy(&graph_check.stdout).contains("\"declared_schema_count\":1"));

    let compile = run([
        "compile",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    assert!(String::from_utf8_lossy(&compile.stdout).contains("re.native-compile-result@0.1.0"));
    assert!(String::from_utf8_lossy(&compile.stderr).is_empty());

    let verify = run([
        "verify",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
    assert!(
        String::from_utf8_lossy(&verify.stdout).contains("re.native-bytecode-verification@0.1.0")
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn declared_member_reaches_the_host_boundary_with_a_registry() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("declared.re");
    let artifact_path = root.join("declared.rebc");
    let registry_path = root.join("registry.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, REGISTRY).unwrap();

    let compile = run([
        "compile",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert!(compile.status.success());

    // WP-355 tightened this boundary: a registry declares a member's shape, it
    // never authorizes the call. The graph references a declared member, so
    // without an explicit `--capability-policy` the run is refused before a
    // host is built instead of reaching the adapter and failing late in the VM.
    let staged = run([
        "run",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(staged.status.code(), Some(65));
    assert!(
        String::from_utf8_lossy(&staged.stderr).contains("native-host-capability-policy-missing"),
        "{}",
        String::from_utf8_lossy(&staged.stderr)
    );

    let one_shot = run([
        "execute",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert_eq!(one_shot.status.code(), Some(65));
    assert!(
        String::from_utf8_lossy(&one_shot.stderr).contains("native-host-capability-policy-missing"),
        "{}",
        String::from_utf8_lossy(&one_shot.stderr)
    );

    fs::remove_dir_all(root).unwrap();
}

fn run<const N: usize>(arguments: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp352-declared-registry-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
