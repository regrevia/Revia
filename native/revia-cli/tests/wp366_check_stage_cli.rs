//! WP-366: which stage of the native toolchain reports a semantic diagnostic.
//!
//! The examples index calls `examples/diagnostic-error.re` a "structured
//! diagnostic and exit 65". That is the Node reference `check`; the native
//! `revia check` is a parser only and answers with
//! `re.native-parser-result@0.1.0`, `"ok": true`, exit 0. The native diagnostic
//! appears one stage later, from `translate` or `compile`, as
//! `unknown-argument` in `re.native-graph-result@0.1.0` with exit 65. The index
//! now says so, and this test keeps either stage from being described as the
//! other.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

fn example(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name)
        .to_str()
        .expect("the example path is UTF-8")
        .to_string()
}

fn run(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .expect("the native CLI runs")
}

fn combined(output: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("the CLI exits with a code")
}

fn assert_contains(output: &Output, needle: &str) {
    let text = combined(output);
    assert!(text.contains(needle), "expected {needle:?} in {text:?}");
}

#[test]
fn check_answers_with_a_parse_result_and_exit_zero() {
    let fixture = example("diagnostic-error.re");
    let output = run(&["check", &fixture]);
    assert_eq!(
        code(&output),
        0,
        "check parses and reports the parse result: {}",
        combined(&output)
    );
    assert_contains(&output, "\"schema\":\"re.native-parser-result@0.1.0\"");
    assert_contains(&output, "\"ok\":true");
}

#[test]
fn translate_and_compile_report_the_argument_diagnostic() {
    let fixture = example("diagnostic-error.re");

    let translated = run(&["translate", &fixture]);
    assert_eq!(
        code(&translated),
        65,
        "translate rejects the unknown argument: {}",
        combined(&translated)
    );
    assert_contains(&translated, "\"schema\":\"re.native-graph-result@0.1.0\"");
    assert_contains(&translated, "\"code\":\"unknown-argument\"");
    assert_contains(&translated, "\"ok\":false");

    let artifact = std::env::temp_dir().join(format!(
        "revia-wp366-diagnostic-{}.artifact",
        std::process::id()
    ));
    let compiled = run(&["compile", &fixture, artifact.to_str().unwrap()]);
    assert_eq!(
        code(&compiled),
        65,
        "compile rejects the unknown argument: {}",
        combined(&compiled)
    );
    assert_contains(&compiled, "\"code\":\"unknown-argument\"");
    assert_contains(&compiled, "\"ok\":false");
    let _ = fs::remove_file(&artifact);
}

#[test]
fn the_help_surface_is_the_measured_one() {
    let output = run(&["--help"]);
    assert_eq!(code(&output), 0, "{}", combined(&output));
    assert_contains(&output, "check <file>");
    assert_contains(&output, "translate <file>");
}

#[test]
fn preview_only_check_flags_are_a_usage_error() {
    let fixture = example("hello.re");

    let formatted = run(&["check", "--format", "json", &fixture]);
    assert_eq!(
        code(&formatted),
        64,
        "the current check takes no --format: {}",
        combined(&formatted)
    );
    assert!(
        formatted.stdout.is_empty(),
        "a usage error writes no result: {}",
        combined(&formatted)
    );
    assert_contains(&formatted, "Usage: revia");

    let written = run(&["check", "--write", &fixture]);
    assert_eq!(
        code(&written),
        64,
        "the current check takes no --write: {}",
        combined(&written)
    );
    assert!(written.stdout.is_empty(), "{}", combined(&written));
    assert_contains(&written, "Usage: revia");
}

#[test]
fn a_valid_example_clears_every_stage() {
    let fixture = example("hello.re");

    let checked = run(&["check", &fixture]);
    assert_eq!(code(&checked), 0, "{}", combined(&checked));
    assert_contains(&checked, "\"schema\":\"re.native-parser-result@0.1.0\"");

    let translated = run(&["translate", &fixture]);
    assert_eq!(code(&translated), 0, "{}", combined(&translated));
    assert_contains(&translated, "re 0.1 bytecode");

    let artifact =
        std::env::temp_dir().join(format!("revia-wp366-hello-{}.artifact", std::process::id()));
    let compiled = run(&["compile", &fixture, artifact.to_str().unwrap()]);
    assert_eq!(code(&compiled), 0, "{}", combined(&compiled));
    assert_contains(&compiled, "\"ok\":true");
    let _ = fs::remove_file(&artifact);
}
