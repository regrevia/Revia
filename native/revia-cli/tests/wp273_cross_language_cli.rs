use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    cross_language::{
        CrossLanguageBackendResult, CrossLanguageInvocation, parse_cross_language_matrix,
        serialize_backend_result,
    },
    digest::sha256_hex,
    graph::{check_graph, graph_revision, load_canonical_graph, parse_compact_graph},
    replay::{parse_native_replay_transcript, serialize_native_replay_transcript},
    source::SourceText,
};

const GRAPH: &str = "test/golden/canonical-hello.re";
const INPUT: &str = "sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083";
const TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",",
    "\"value\":null},\"variant\":\"ok\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_cross_language_matrix_runs_native_and_records_node_oracle() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("transcript");
    let node_result_path = temp_path("node-result");
    let output_path = temp_path("matrix");
    fs::write(&transcript_path, TRANSCRIPT).unwrap();

    let node_run = Command::new("node")
        .current_dir(&repo_root)
        .args(["src/cli/re.js", "run", "--format", "json", GRAPH])
        .output()
        .unwrap();
    assert!(
        node_run.status.success(),
        "status={} stdout={} stderr={}",
        node_run.status,
        String::from_utf8_lossy(&node_run.stdout),
        String::from_utf8_lossy(&node_run.stderr)
    );
    assert!(String::from_utf8_lossy(&node_run.stdout).contains("\"code\":0"));

    let graph = load_graph(&repo_root.join(GRAPH));
    let revision = graph_revision(&graph).unwrap();
    let transcript = parse_native_replay_transcript(TRANSCRIPT).unwrap();
    let transcript_source = serialize_native_replay_transcript(&transcript).unwrap();
    let node = CrossLanguageBackendResult::measured(
        "node",
        revision,
        INPUT,
        digest(transcript_source.as_bytes()),
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
    fs::write(&node_result_path, serialize_backend_result(&node).unwrap()).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "cross-language-matrix",
            GRAPH,
            INPUT,
            transcript_path.to_str().unwrap(),
            node_result_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let matrix = parse_cross_language_matrix(&fs::read_to_string(&output_path).unwrap()).unwrap();
    assert_eq!(matrix.workload_id, "native-replay");
    assert_eq!(matrix.status, "semantic-equivalent");
    assert_eq!(
        matrix
            .pending
            .iter()
            .map(|entry| entry.backend.as_str())
            .collect::<Vec<_>>(),
        vec!["go", "jvm"]
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(repo_root.to_str().unwrap()));
    cleanup(&transcript_path);
    cleanup(&node_result_path);
    cleanup(&output_path);
}

#[test]
fn native_cross_language_matrix_rejects_node_authority_drift_before_write() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("transcript-drift");
    let node_result_path = temp_path("node-result-drift");
    let output_path = temp_path("matrix-drift");
    fs::write(&transcript_path, TRANSCRIPT).unwrap();
    let node = CrossLanguageBackendResult::measured(
        "node",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        INPUT,
        digest(TRANSCRIPT.as_bytes()),
        digest(b"node-reference-24"),
        "",
        digest(b"node-receipt"),
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
    fs::write(&node_result_path, serialize_backend_result(&node).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "cross-language-matrix",
            GRAPH,
            INPUT,
            transcript_path.to_str().unwrap(),
            node_result_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("cross-language-matrix-authority-mismatch")
    );
    assert!(!output_path.exists());
    cleanup(&transcript_path);
    cleanup(&node_result_path);
    cleanup(&output_path);
}

fn load_graph(path: &Path) -> revia_core::graph::Graph {
    let bytes = fs::read(path).unwrap();
    let source = SourceText::from_bytes(&bytes, path.to_str().unwrap()).unwrap();
    if source.text.starts_with("re 0.1 canonical\n") {
        load_canonical_graph(&source.text).unwrap()
    } else {
        check_graph(parse_compact_graph(&source.text, path.to_str().unwrap()).unwrap()).unwrap()
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp273-{label}-{}-{}-{}",
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
