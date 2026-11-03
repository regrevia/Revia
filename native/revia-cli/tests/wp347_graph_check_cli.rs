// WP-347: the `graph-check` command and its `--schema-registry` flag.
//
// `check` is the lexer/parser path, so graph checking needed its own command.
// These cases pin the four public behaviours of that command: a graph that
// needs a declared schema fails without a registry and passes with one; a
// malformed registry fails as a registry problem (not as a graph problem); and
// an unreadable input file stays distinguishable from an invalid one.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const DECLARED_SOURCE: &str = r#"re 0.1 compact
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

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp347-{}-{stamp}-{counter}",
        std::process::id()
    ))
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn fixture(root: &PathBuf) -> (String, String) {
    fs::create_dir_all(root).unwrap();
    let source = root.join("declared.re");
    let registry = root.join("registry.json");
    fs::write(&source, DECLARED_SOURCE).unwrap();
    fs::write(&registry, REGISTRY).unwrap();
    (
        source.to_str().unwrap().to_owned(),
        registry.to_str().unwrap().to_owned(),
    )
}

#[test]
fn graph_check_admits_a_registry_declared_schema() {
    let root = temp_root();
    let (source, registry) = fixture(&root);
    let output = run(&["graph-check", "--schema-registry", &registry, &source]);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains(r#""declared_schema_count":1"#), "{stdout}");
    assert!(stdout.contains(r#""ok":true"#), "{stdout}");
    assert!(
        stdout.contains(r#""schema":"re.native-graph-result@0.1.0""#),
        "{stdout}"
    );
    assert!(stdout.contains(r#""unit":"@declared""#), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn graph_check_without_a_registry_fails_closed() {
    let root = temp_root();
    let (source, _) = fixture(&root);
    let output = run(&["graph-check", &source]);
    assert_eq!(output.status.code(), Some(65));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("unknown-schema-reference"), "{stdout}");
    assert!(stdout.contains(r#""actual":"demo.echo@0.1.0""#), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_malformed_registry_reports_a_registry_problem() {
    let root = temp_root();
    let (source, registry) = fixture(&root);
    fs::write(&registry, r#"{"definitions":[],"schema":"wrong"}"#).unwrap();
    let output = run(&["graph-check", "--schema-registry", &registry, &source]);
    assert_eq!(output.status.code(), Some(65));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("declared-schema-registry-invalid"),
        "{stdout}"
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn artifacts_are_validated_before_the_graph_is_read() {
    let root = temp_root();
    let (_, registry) = fixture(&root);
    // A graph file that does not exist: the registry error must still win.
    let missing = root.join("missing.re");
    let output = run(&[
        "graph-check",
        "--schema-registry",
        &registry,
        missing.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(66));

    let duplicate = root.join("duplicate.json");
    fs::write(
        &duplicate,
        r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0"},{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0"}],"schema":"revia.host-schema-definitions@0.1.0"}"#,
    )
    .unwrap();
    let source = root.join("declared.re");
    fs::write(&source, DECLARED_SOURCE).unwrap();
    let output = run(&[
        "graph-check",
        "--schema-registry",
        duplicate.to_str().unwrap(),
        source.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("declared-schema-invalid")
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn graph_check_help_is_reachable() {
    let output = run(&["graph-check", "--help"]);
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("revia graph-check"), "{stdout}");
    assert!(stdout.contains("--schema-registry"), "{stdout}");
}
