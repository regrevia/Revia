// WP-348: `graph-check` accepts an artifact that declares result contracts.
//
// The registry is now the only place a check-time caller states what a member
// returns and which error variants it can fail with. These cases pin that the
// command keeps accepting such an artifact end to end (the graph is still
// admitted on the same terms as WP-347) and that a malformed error sum is
// reported as a registry problem, not as a graph problem.

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

// `src/host/demo-schema.js` shape: the result names a family, the definition's
// `types` table says what that family's variants are.
const REGISTRY: &str = r#"{"definitions":[{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":["unavailable","refused"]}}}],"schema":"revia.host-schema-definitions@0.1.0"}"#;

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp348-{}-{stamp}-{counter}",
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
fn graph_check_accepts_a_declared_result_contract() {
    let root = temp_root();
    let (source, registry) = fixture(&root);
    let output = run(&["graph-check", "--schema-registry", &registry, &source]);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains(r#""declared_schema_count":1"#), "{stdout}");
    assert!(stdout.contains(r#""ok":true"#), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_comma_inside_a_generic_half_is_not_the_result_separator() {
    let root = temp_root();
    let (source, registry) = fixture(&root);
    fs::write(
        &registry,
        REGISTRY.replace(
            "result<text.utf8, demo.echo_error>",
            "result<map<text.utf8,number.i64>, demo.echo_error>",
        ),
    )
    .unwrap();
    let output = run(&["graph-check", "--schema-registry", &registry, &source]);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains(r#""declared_schema_count":1"#), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_malformed_result_names_the_types_entry_it_stranded() {
    let root = temp_root();
    let (source, registry) = fixture(&root);
    fs::write(
        &registry,
        REGISTRY.replace(
            "result<text.utf8, demo.echo_error>",
            "result<text.utf8,demo.echo_error,extra>",
        ),
    )
    .unwrap();
    let output = run(&["graph-check", "--schema-registry", &registry, &source]);
    assert_eq!(output.status.code(), Some(65));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("declared-schema-registry-invalid"),
        "{stdout}"
    );
    assert!(
        stdout.contains(r#""actual":"definitions[0].types[demo.echo_error]""#),
        "{stdout}"
    );
    fs::remove_dir_all(&root).unwrap();
}
