// WP-353: the declared-type vocabulary is enforced at check time, in the same
// slice that the runtime bridge enforces it.
//
// `validate_declarations` stays vocabulary-free, so the registry below is a
// well-formed registry: it is `check_graph_with_declared_schemas` that refuses
// a reference the graph names when one of its declared types cannot cross the
// host boundary. A definition the graph never names keeps its own vocabulary.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = r#"re 0.1 compact
// Declared schema with one supported member.

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

/// The declaration the graph calls is outside the bridge vocabulary.
const REGISTRY_UNSUPPORTED_PARAMETER: &str = r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"map<text.utf8,number.i64>"}]}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

/// The declaration the graph calls is inside the bridge vocabulary, but its
/// return type is not.
const REGISTRY_UNSUPPORTED_RETURN: &str = r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}],"returns":"map<text.utf8,number.i64>"}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

/// A supported reference plus a definition nothing names whose types the
/// bridge could not carry. The unused definition must not decide the check.
const REGISTRY_WITH_UNUSED_UNSUPPORTED: &str = r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}]}},"revision":"0.1.0"},{"identity":"demo.unused","members":{"spend":{"params":[{"name":"amount","type":"map<text.utf8,number.i64>"}]}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

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
        "revia-wp353-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

fn fixture(registry: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("declared.re");
    let registry_path = root.join("registry.json");
    fs::write(&source_path, SOURCE).unwrap();
    fs::write(&registry_path, registry).unwrap();
    (root, source_path, registry_path)
}

#[test]
fn check_time_rejects_an_unsupported_parameter_type() {
    let (root, source_path, registry_path) = fixture(REGISTRY_UNSUPPORTED_PARAMETER);
    let artifact_path = root.join("declared.rebc");

    let graph_check = run([
        "graph-check",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
    ]);
    assert_eq!(graph_check.status.code(), Some(65));
    let stdout = String::from_utf8_lossy(&graph_check.stdout);
    assert!(stdout.contains("declared-type-unsupported"), "{stdout}");
    assert!(stdout.contains("map<text.utf8,number.i64>"), "{stdout}");
    assert!(String::from_utf8_lossy(&graph_check.stderr).is_empty());

    let compile = run([
        "compile",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert_eq!(compile.status.code(), Some(65));
    assert!(String::from_utf8_lossy(&compile.stdout).contains("declared-type-unsupported"));
    assert!(!artifact_path.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn check_time_rejects_an_unsupported_return_type() {
    let (root, source_path, registry_path) = fixture(REGISTRY_UNSUPPORTED_RETURN);

    let graph_check = run([
        "graph-check",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
    ]);
    assert_eq!(graph_check.status.code(), Some(65));
    let stdout = String::from_utf8_lossy(&graph_check.stdout);
    assert!(stdout.contains("declared-type-unsupported"), "{stdout}");
    assert!(stdout.contains("map<text.utf8,number.i64>"), "{stdout}");
    assert!(String::from_utf8_lossy(&graph_check.stderr).is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unused_unsupported_definition_does_not_block_the_check() {
    let (root, source_path, registry_path) = fixture(REGISTRY_WITH_UNUSED_UNSUPPORTED);
    let artifact_path = root.join("declared.rebc");

    let graph_check = run([
        "graph-check",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
    ]);
    assert_eq!(
        graph_check.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&graph_check.stdout)
    );
    let stdout = String::from_utf8_lossy(&graph_check.stdout);
    assert!(stdout.contains("\"declared_schema_count\":2"), "{stdout}");
    assert!(stdout.contains("\"ok\":true"), "{stdout}");

    let compile = run([
        "compile",
        "--schema-registry",
        registry_path.to_str().unwrap(),
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert_eq!(
        compile.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&compile.stdout)
    );
    assert!(artifact_path.exists());

    fs::remove_dir_all(root).unwrap();
}
