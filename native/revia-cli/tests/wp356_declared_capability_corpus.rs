//! WP-356: the declared-capability execution conformance corpus.
//!
//! WP-355 proved one granted member end to end and pinned a handful of policy
//! refusals next to it. This file turns those checks into data: every case is a
//! `(registry, policy, program, expected exit and diagnostic)` tuple in
//! `test/fixtures/declared-capability-execution-corpus.json`, and this test
//! drives the real `revia` binary over the whole file in one run.
//!
//! The corpus is plain JSON on purpose. A second implementation of the same
//! contract can replay it without reading Rust, and the case file states for
//! each entry what a wrong implementation would do that the case catches.
//!
//! Two evidence rules shape the file:
//!
//! - Both diagnostic channels are asserted. Graph-stage refusals are written to
//!   stdout as `re.native-graph-result@0.1.0`, host-boundary and runtime
//!   refusals to stderr as `re.native-host-execution-result@0.1.0`. A check
//!   never assumes emptiness by itself: a case states which stream must stay
//!   empty, because a fail-closed run may repeat the object on stdout.
//! - A negative only exists where the checked-in implementation has a real
//!   vocabulary entry. An unknown error variant is not a negative: variant
//!   names are declaration-local, so the corpus does not pretend otherwise.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::canonical_json::{JsonValue, canonicalize};
use revia_core::project::parse_json;

const CORPUS: &str =
    include_str!("../../../test/fixtures/declared-capability-execution-corpus.json");
const CORPUS_SCHEMA: &str = "re.declared-capability-execution-corpus@0.1.0";
const GRAPH_RESULT: &str = "re.native-graph-result@0.1.0";
const HOST_RESULT: &str = "re.native-host-execution-result@0.1.0";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(fields) = value else {
        panic!("a corpus node must be an object, not {value:?}");
    };
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("a corpus node must carry `{name}`: {value:?}"))
}

fn string(value: &JsonValue) -> &str {
    let JsonValue::String(text) = value else {
        panic!("expected a string, found {value:?}");
    };
    text
}

fn temp_root() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp356-{}-{stamp}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

/// Runs one corpus case with the real binary and returns (exit, stdout, stderr).
fn run_case(case: &JsonValue, input_digest: &str, root: &Path) -> (Option<i32>, String, String) {
    let source_path = root.join("program.re");
    let registry_path = root.join("registry.json");
    let policy_path = root.join("policy.json");

    fs::write(&source_path, string(field(case, "program"))).unwrap();
    fs::write(&registry_path, canonicalize(field(case, "registry"))).unwrap();

    let mut arguments: Vec<String> = vec![
        "execute".to_owned(),
        "--schema-registry".to_owned(),
        registry_path.to_str().unwrap().to_owned(),
    ];
    match field(case, "policy") {
        JsonValue::Null => {}
        // A policy is a JSON object; a case may also spell it as raw text to
        // prove that a non-JSON artifact is refused rather than ignored.
        policy => {
            let artifact = match policy {
                JsonValue::String(raw) => raw.clone(),
                other => canonicalize(other),
            };
            fs::write(&policy_path, artifact).unwrap();
            arguments.push("--capability-policy".to_owned());
            arguments.push(policy_path.to_str().unwrap().to_owned());
        }
    }
    arguments.push(source_path.to_str().unwrap().to_owned());
    arguments.push(input_digest.to_owned());

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(&arguments)
        .output()
        .unwrap();
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_declared_capability_execution_corpus_holds_its_cases() {
    let corpus = parse_json(CORPUS).unwrap();
    assert_eq!(string(field(&corpus, "schema")), CORPUS_SCHEMA);
    assert_eq!(string(field(&corpus, "version")), "0.1.0");

    let JsonValue::Array(cases) = field(&corpus, "cases") else {
        panic!("corpus cases must be an array");
    };
    let mut seen: Vec<String> = Vec::new();
    for case in cases {
        let expected = field(case, "expected");
        let id = string(field(case, "id"));
        assert!(
            !seen.iter().any(|seen| seen == id),
            "duplicate case id {id}"
        );
        let catches = string(field(case, "catches"));
        assert!(
            !catches.trim().is_empty(),
            "{id} must state what an implementation change would break"
        );

        let JsonValue::Number(wanted_exit) = field(expected, "exit") else {
            panic!("{id} expected.exit must be a number");
        };
        let wanted_exit: i32 = wanted_exit.parse().unwrap();
        let channel = string(field(expected, "channel"));
        let silent = field(expected, "silent");
        let silent = match silent {
            JsonValue::Null => None,
            other => Some(string(other)),
        };
        let schema = string(field(expected, "schema"));
        let contains = match field(expected, "contains") {
            JsonValue::Array(items) => items.iter().map(string).collect::<Vec<_>>(),
            other => panic!("{id} expected.contains must be an array, found {other:?}"),
        };

        // Both known result schemas are only ever produced on one stream, and a
        // case that names one must not be satisfiable by the other.
        assert!(
            schema.is_empty() || schema == GRAPH_RESULT || schema == HOST_RESULT,
            "{id} names an unknown result schema"
        );

        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let (actual_exit, stdout, stderr) =
            run_case(case, string(field(&corpus, "input_digest")), &root);
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(actual_exit, Some(wanted_exit), "{id}: exit status");
        let (produced, ignored) = match channel {
            "stdout" => (&stdout, &stderr),
            "stderr" => (&stderr, &stdout),
            other => panic!("{id} names an unknown channel {other}"),
        };
        if !schema.is_empty() {
            assert!(
                produced.contains(schema),
                "{id}: {channel} must carry the {schema} result, found `{produced}`"
            );
        }
        for fragment in &contains {
            assert!(
                produced.contains(fragment),
                "{id}: {channel} must contain `{fragment}`, found `{produced}`"
            );
        }
        if let Some(silent) = silent {
            let silent_channel = match silent {
                "stdout" => &stdout,
                "stderr" => &stderr,
                other => panic!("{id} names an unknown silent channel {other}"),
            };
            assert!(
                silent_channel.trim().is_empty(),
                "{id}: the {silent} channel must stay empty, found `{silent_channel}`"
            );
        }
        assert!(
            !ignored.contains("native-host-capability-policy-invalid"),
            "{id}: an invalid policy must not be reported on the channel this case does not assert"
        );
        seen.push(id.to_owned());
    }

    let wanted = [
        "granted-concat-runs",
        "granted-scalar-count-runs",
        "policy-absent",
        "policy-not-json",
        "policy-grants-unimplemented-member",
        "granted-member-denies-sibling",
        "unknown-capability-member",
        "unknown-argument",
        "argument-count-mismatch",
        "literal-type-mismatch",
        "host-fault-output-limit",
        "registry-schema-mismatch",
        "unused-error-family",
        "duplicate-declaration",
    ];
    for id in wanted {
        assert!(seen.iter().any(|seen| seen == id), "missing case {id}");
    }
    assert_eq!(
        seen.len(),
        wanted.len(),
        "the corpus must hold exactly the cases this test knows"
    );
}
