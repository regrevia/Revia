//! WP-359: value-level evidence on the staged artifact path (`run`).
//!
//! WP-4 added the opt-in `--print-values` extension to `execute`, the one-shot
//! path that translates the graph and executes it in the same process. `run`
//! is the staged counterpart: it loads a graph and an artifact that were
//! written earlier and executes the artifact. Until this work package the two
//! paths disagreed about observation: `execute --print-values` printed the
//! typed payload of each invocation, `run` had no such flag and always dropped
//! the value.
//!
//! The extension under test is the same additive contract as WP-4, moved onto
//! the staged path:
//!
//! - the default result keeps the pinned
//!   `re.native-host-execution-result@0.1.0` shape, without
//!   `invocation_values`, and stays byte-identical to what `run` printed
//!   before the flag existed;
//! - `--print-values` adds an `invocation_values` array next to `invocations`,
//!   same order and same length, each entry the typed payload of that call in
//!   the canonical JSON of the VM value encoding (`{"type":…,"value":…}`).
//!
//! These tests run the real binary. Each case states which path it walks, so a
//! passing suite proves only what was exercised. Because both commands are
//! given the same source and the same artifact, comparing their output pins
//! that the staged path does not diverge from the one-shot path.

use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::canonical_json::{JsonValue, canonicalize};
use revia_core::project::parse_json;

const INPUT_DIGEST: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const HOST_RESULT_SCHEMA: &str = "re.native-host-execution-result@0.1.0";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(fields) = value else {
        panic!("a result node must be an object, not {value:?}");
    };
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("a result node must carry `{name}`: {value:?}"))
}

fn optional<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = value else {
        panic!("a result node must be an object, not {value:?}");
    };
    match fields.iter().find(|(key, _)| key == name) {
        None | Some((_, JsonValue::Null)) => None,
        Some((_, other)) => Some(other),
    }
}

fn string(value: &JsonValue) -> &str {
    let JsonValue::String(text) = value else {
        panic!("expected a string, found {value:?}");
    };
    text
}

fn entries(value: &JsonValue) -> &[JsonValue] {
    let JsonValue::Array(items) = value else {
        panic!("expected an array, found {value:?}");
    };
    items
}

fn exit_code(value: &JsonValue) -> i32 {
    let JsonValue::Number(code) = value else {
        panic!("expected a numeric code, found {value:?}");
    };
    code.parse().unwrap()
}

fn temp_root() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp359-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

/// A per-case temporary directory removed on drop, including when an assertion
/// panics part way through the case.
struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// One guest program that reads `relative` and exits 0 on `ok`, 2 on `err`.
/// Both branches must be effect calls returning `process.status`, so the value
/// of the read is only reachable through the invocation record.
fn read_program(relative: &str) -> String {
    format!(
        "re 0.1 compact\n\
         unit @main\n\
         \n\
         cap @input: fs.read@0.1.0\n\
         \n\
         fn @main() -> process.status {{\n\
         \x20 %report = @input.read_file(path: \"{relative}\", encoding: text.encoding.utf8)\n\
         \x20 return match %report {{\n\
         \x20   ok(_) => process.exit(0)\n\
         \x20   err(_) => process.exit(2)\n\
         \x20 }}\n\
         }}\n"
    )
}

/// Runs `run` on a fresh sandbox holding `relative` (if given). The artifact is
/// written first by `compile`, exactly as a staged deployment would, and the
/// sandbox root is the directory holding the source, which is also what
/// `execute` resolves for the same source.
fn run_case(
    relative: &str,
    present: Option<&str>,
    print_values: bool,
) -> (Option<i32>, String, String) {
    let root = TempRoot(temp_root());
    let sandbox = root.0.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    if let Some(content) = present {
        fs::write(sandbox.join("in.txt"), content).unwrap();
    }
    let source_path = sandbox.join("program.re");
    let artifact_path = sandbox.join("program.rebc");
    fs::write(&source_path, read_program(relative)).unwrap();

    let compiled = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("compile")
        .arg(&source_path)
        .arg(&artifact_path)
        .output()
        .unwrap();
    assert_eq!(
        compiled.status.code(),
        Some(0),
        "compile must produce the staged artifact: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );

    let mut command = Command::new(env!("CARGO_BIN_EXE_revia"));
    command.arg("run");
    if print_values {
        command.arg("--print-values");
    }
    command
        .arg(&source_path)
        .arg(&artifact_path)
        .arg(INPUT_DIGEST);
    let output = command.output().unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Runs `execute` on the same source shape so the two paths can be compared.
fn execute_case(
    relative: &str,
    present: Option<&str>,
    print_values: bool,
) -> (Option<i32>, String, String) {
    let root = TempRoot(temp_root());
    let sandbox = root.0.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    if let Some(content) = present {
        fs::write(sandbox.join("in.txt"), content).unwrap();
    }
    let source_path = sandbox.join("program.re");
    fs::write(&source_path, read_program(relative)).unwrap();

    let mut command = Command::new(env!("CARGO_BIN_EXE_revia"));
    command.arg("execute");
    if print_values {
        command.arg("--print-values");
    }
    command.arg(&source_path).arg(INPUT_DIGEST);
    let output = command.output().unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn parse_stdout(leader: &str, stdout: &str) -> JsonValue {
    assert_eq!(
        stdout.lines().count(),
        1,
        "{leader} must print exactly one result line, found {stdout:?}"
    );
    parse_json(stdout.trim_end()).unwrap_or_else(|error| {
        panic!("{leader} must print a JSON result, found {stdout:?}: {error:?}")
    })
}

#[test]
fn the_staged_path_reports_the_same_values_as_the_one_shot_path() {
    let (staged_exit, staged_stdout, staged_stderr) =
        run_case("in.txt", Some("hello-value\n"), true);
    assert_eq!(staged_exit, Some(0));
    assert!(
        staged_stderr.is_empty(),
        "a successful run writes no stderr: {staged_stderr}"
    );
    let result = parse_stdout("run --print-values", &staged_stdout);

    let values = entries(field(&result, "invocation_values"));
    assert_eq!(
        values.len(),
        entries(field(&result, "invocations")).len(),
        "one value per invocation, in the invocation order"
    );
    let expected = parse_json(r#"{"type":"text.utf8","value":"hello-value\n"}"#).unwrap();
    assert_eq!(
        canonicalize(&values[0]),
        canonicalize(&expected),
        "the staged path prints the typed payload the call returned"
    );

    // The same source and the same artifact must produce the same evidence,
    // whichever path executes them.
    let (execute_exit, execute_stdout, _) = execute_case("in.txt", Some("hello-value\n"), true);
    assert_eq!(execute_exit, Some(0));
    assert_eq!(
        staged_stdout, execute_stdout,
        "`run --print-values` must print exactly what `execute --print-values` prints"
    );
}

#[test]
fn the_default_staged_result_is_unchanged_and_carries_no_values() {
    let (exit, stdout, stderr) = run_case("in.txt", Some("hello-value\n"), false);
    assert_eq!(exit, Some(0));
    assert!(stderr.is_empty(), "a successful run writes no stderr");
    let result = parse_stdout("default run", &stdout);

    assert_eq!(string(field(&result, "schema")), HOST_RESULT_SCHEMA);
    assert_eq!(*field(&result, "ok"), JsonValue::Bool(true));
    assert_eq!(string(field(&result, "executor")), "re.native-vm@0.1.0");
    assert_eq!(exit_code(field(field(&result, "outcome"), "code")), 0);
    assert!(
        optional(&result, "invocation_values").is_none(),
        "the default staged result must not print invocation values: {result:?}"
    );

    // Before this work package `run` always used the plain execution entry
    // point. The default output must remain what that entry point produced, so
    // it must equal the default output of the path it never had a flag on.
    let (execute_exit, execute_stdout, _) = execute_case("in.txt", Some("hello-value\n"), false);
    assert_eq!(execute_exit, Some(0));
    assert_eq!(
        stdout, execute_stdout,
        "the default staged result must not change"
    );
}

#[test]
fn the_staged_path_prints_the_typed_refusal_value() {
    let (exit, stdout, stderr) = run_case("absent.txt", None, true);
    assert_eq!(exit, Some(0));
    assert!(stderr.is_empty(), "a refused path is not a host fault");
    let result = parse_stdout("run --print-values", &stdout);
    assert_eq!(*field(&result, "ok"), JsonValue::Bool(true));
    assert_eq!(exit_code(field(field(&result, "outcome"), "code")), 2);

    let invocations = entries(field(&result, "invocations"));
    assert_eq!(string(field(&invocations[0], "outcome")), "err");
    let values = entries(field(&result, "invocation_values"));
    let expected = parse_json(r#"{"type":"fs.read_error","value":"not_found"}"#).unwrap();
    assert_eq!(
        canonicalize(&values[0]),
        canonicalize(&expected),
        "the refusal prints the typed error value, not just a failed outcome"
    );
}

#[test]
fn the_staged_usage_text_advertises_the_opt_in() {
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("run")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(64),
        "`run` without arguments is a usage error"
    );
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(
        text.contains("--print-values"),
        "the staged usage text must name the flag: {text}"
    );
}
