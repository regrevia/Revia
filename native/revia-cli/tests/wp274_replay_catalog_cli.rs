use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    cross_language::{CrossLanguageBackendResult, CrossLanguageInvocation},
    digest::sha256_hex,
    graph::{graph_revision, load_canonical_graph},
    replay::{NativeReplayInvocation, NativeReplayTranscript, serialize_native_replay_transcript},
    replay_catalog::{
        ReplayWorkload, ReplayWorkloadCatalog, parse_replay_workload_report,
        serialize_replay_workload_catalog,
    },
    vm::{CapabilityResponse, VmValue},
};

const HELLO: &str = include_str!("../../../test/golden/canonical-hello.re");
const ARGS: &str = include_str!("../../../test/golden/canonical-args-check.re");
const READ_ENCODING: &str = include_str!("../../../test/golden/canonical-read-encoding.re");
const HELLO_INPUT: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ARGS_INPUT: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const MULTI_INPUT: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_replay_catalog_runs_three_workloads_and_one_node_matrix() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog_path = temp_path("catalog");
    let output_path = temp_path("report");
    let hello_transcript = hello_transcript();
    let node_run = Command::new("node")
        .current_dir(&root)
        .args([
            "src/cli/re.js",
            "run",
            "--format",
            "json",
            "test/golden/canonical-hello.re",
        ])
        .output()
        .unwrap();
    assert!(node_run.status.success());
    let hello_revision = graph_revision(&load_canonical_graph(HELLO).unwrap()).unwrap();
    let hello_transcript_source = serialize_native_replay_transcript(&hello_transcript).unwrap();
    let node = CrossLanguageBackendResult::measured(
        "node",
        hello_revision,
        HELLO_INPUT,
        digest(hello_transcript_source.as_bytes()),
        digest(b"node-reference-24"),
        "",
        digest(&node_run.stdout),
        0,
        "process.status",
        vec![CrossLanguageInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            "ok",
        )],
        "",
    );
    let catalog = ReplayWorkloadCatalog::new(vec![
        ReplayWorkload::new(
            "hello-ok",
            HELLO,
            HELLO_INPUT,
            hello_transcript_source,
            Some(node),
        ),
        ReplayWorkload::new(
            "args-err",
            ARGS,
            ARGS_INPUT,
            transcript(vec![NativeReplayInvocation::new(
                "@args",
                "read",
                "aaaaaadaaaaaaaaaaaaaaaaaaa",
                BTreeMap::new(),
                CapabilityResponse::err(VmValue::Unit),
            )]),
            None,
        ),
        ReplayWorkload::new(
            "read-encoding-ok",
            READ_ENCODING,
            MULTI_INPUT,
            transcript(vec![NativeReplayInvocation::new(
                "@input",
                "read_file",
                "aaaaaadaaaaaaaaaaaaaaaaaaa",
                BTreeMap::from([
                    (
                        "encoding".to_owned(),
                        VmValue::Text("text.encoding.utf8".to_owned()),
                    ),
                    ("path".to_owned(), VmValue::Text("input.txt".to_owned())),
                ]),
                CapabilityResponse::ok(VmValue::Unit),
            )]),
            None,
        ),
    ]);
    fs::write(
        &catalog_path,
        serialize_replay_workload_catalog(&catalog).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&root)
        .args([
            "replay-catalog",
            catalog_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report_source = fs::read_to_string(&output_path).unwrap();
    let report = parse_replay_workload_report(&report_source).unwrap();
    assert_eq!(report.workloads.len(), 3);
    assert_eq!(report.workloads[0].status, "semantic-equivalent");
    assert_eq!(
        report.workloads[0].matrix.as_ref().unwrap().workload_id,
        "hello-ok"
    );
    assert_eq!(report.workloads[1].status, "native-measured");
    assert_eq!(report.workloads[1].native_result.outcome_code, 2);
    assert_eq!(report.workloads[2].native_result.invocations.len(), 1);
    assert_eq!(
        report.workloads[1]
            .pending
            .iter()
            .map(|item| item.backend.as_str())
            .collect::<Vec<_>>(),
        vec!["node", "go", "jvm"]
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(root.to_str().unwrap()));
    cleanup(&catalog_path);
    cleanup(&output_path);
}

#[test]
fn native_replay_catalog_rejects_transcript_drift_before_report_write() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog_path = temp_path("invalid-catalog");
    let output_path = temp_path("invalid-report");
    let catalog = ReplayWorkloadCatalog::new(vec![
        ReplayWorkload::new("one", HELLO, HELLO_INPUT, transcript(Vec::new()), None),
        ReplayWorkload::new("two", ARGS, ARGS_INPUT, transcript(Vec::new()), None),
        ReplayWorkload::new(
            "three",
            READ_ENCODING,
            MULTI_INPUT,
            transcript(Vec::new()),
            None,
        ),
    ]);
    fs::write(
        &catalog_path,
        serialize_replay_workload_catalog(&catalog).unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&root)
        .args([
            "replay-catalog",
            catalog_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!output_path.exists());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("native-conformance-replay-invocation-mismatch"),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    cleanup(&catalog_path);
    cleanup(&output_path);
}

fn hello_transcript() -> NativeReplayTranscript {
    NativeReplayTranscript::new(vec![invocation(
        "@stdout",
        "write",
        "aaaaaadaaaaaaaaaaaaaaaaaaa",
        "Hello, World!\n",
    )])
}

fn invocation(
    instance: &str,
    member: &str,
    invocation_id: &str,
    data: &str,
) -> NativeReplayInvocation {
    NativeReplayInvocation::new(
        instance,
        member,
        invocation_id,
        BTreeMap::from([("data".to_owned(), VmValue::Text(data.to_owned()))]),
        CapabilityResponse::ok(VmValue::Unit),
    )
}

fn transcript(invocations: Vec<NativeReplayInvocation>) -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(invocations)).unwrap()
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp274-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(path: &Path) {
    fs::remove_file(path).ok();
}
