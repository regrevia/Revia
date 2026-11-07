//! WP-4 (§6): value-level evidence from `execute`.
//!
//! Until this work package the declared-run result described *what ran* (an
//! invocation list with instance, member and outcome) but never *what came
//! back*. The visible result of a capability call reached a program register
//! and was then dropped: `VmInvocation` has no payload field and the receipt
//! serialization uses only those fields. A CLI therefore could not tell the
//! value of a successful read from the value of a refused one except by exit
//! status, and both are reported as `"ok":true` here.
//!
//! The extension under test is opt-in and additive:
//!
//! - default output is byte-identical to the pinned
//!   `re.native-host-execution-result@0.1.0` shape, and every
//!   `receipt_digest` stays what it was — value observation is not part of the
//!   receipt;
//! - `--print-values` adds an `invocation_values` array next to `invocations`,
//!   same order and same length, each entry the typed payload of that call, in
//!   the canonical JSON of the VM value encoding (`{"type":…,"value":…}`).
//!
//! These tests are the acceptance evidence for "a CLI test that prints a
//! capability value". They run the real binary: a passing test proves only the
//! path it walked, so each case states which branch of the guest program it
//! exercises.

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
        "revia-wp4-{}-{stamp}-{}",
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

/// Runs `execute` on a fresh sandbox holding `relative` (if given) and returns
/// (exit, stdout, stderr).
fn run_read(
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

fn assert_no_values(result: &JsonValue, leader: &str) {
    assert!(
        optional(result, "invocation_values").is_none(),
        "{leader} must not print invocation values without `--print-values`: {result:?}"
    );
}

#[test]
fn the_default_result_is_unchanged_and_carries_no_values() {
    let (exit, stdout, stderr) = run_read("in.txt", Some("hello-value\n"), false);
    assert_eq!(exit, Some(0), "a readable file exits through the ok branch");
    assert!(stderr.is_empty(), "a successful execute writes no stderr");
    let result = parse_stdout("default execute", &stdout);

    assert_eq!(string(field(&result, "schema")), HOST_RESULT_SCHEMA);
    assert_eq!(*field(&result, "ok"), JsonValue::Bool(true));
    assert_eq!(string(field(&result, "executor")), "re.native-vm@0.1.0");
    assert_eq!(exit_code(field(field(&result, "outcome"), "code")), 0);

    let invocations = entries(field(&result, "invocations"));
    assert_eq!(invocations.len(), 1, "the program makes one host call");
    assert_eq!(string(field(&invocations[0], "instance")), "@input");
    assert_eq!(string(field(&invocations[0], "member")), "read_file");
    assert_eq!(string(field(&invocations[0], "outcome")), "ok");
    assert_no_values(&result, "default execute");
}

#[test]
fn print_values_reports_the_typed_value_of_the_capability_call() {
    let (default_exit, default_stdout, _) = run_read("in.txt", Some("hello-value\n"), false);
    assert_eq!(default_exit, Some(0));
    let default_result = parse_stdout("default execute", &default_stdout);

    let (exit, stdout, stderr) = run_read("in.txt", Some("hello-value\n"), true);
    assert_eq!(exit, Some(0));
    assert!(stderr.is_empty(), "a successful execute writes no stderr");
    let result = parse_stdout("execute --print-values", &stdout);

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
        "the printed value is the typed payload the call returned"
    );

    // Value observation is not part of the receipt: opting in must not move the
    // digest a released artifact is pinned to.
    assert_eq!(
        field(&result, "receipt_digest"),
        field(&default_result, "receipt_digest"),
        "`--print-values` must not change the receipt digest"
    );
    assert_eq!(field(&result, "trace"), field(&default_result, "trace"));
}

#[test]
fn print_values_distinguishes_a_refusal_value_from_its_exit_status() {
    let (exit, stdout, stderr) = run_read("absent.txt", None, true);
    // A refused path folds into a program-visible `err`: the guest exits 2
    // through its own branch, and the CLI still reports a completed execution.
    assert_eq!(exit, Some(0));
    assert!(stderr.is_empty(), "a refused path is not a host fault");
    let result = parse_stdout("execute --print-values", &stdout);
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
fn the_usage_text_advertises_the_opt_in() {
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("execute")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(64),
        "`execute` without a source is a usage error"
    );
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(
        text.contains("--print-values"),
        "the usage text must name the flag: {text}"
    );
}
