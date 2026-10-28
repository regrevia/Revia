use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::canonical_json::quote;

const INPUT: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const TRANSCRIPT: &str = "{\"invocations\":[],\"schema\":\"re.native-vm-replay@0.1.0\"}\n";
const HOST_TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"code\":\"host-fault-injected\",\"kind\":\"host_fault\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
const ORACLE_SCRIPT: &str = "test-support/replay-fault-node-oracle.js";
const SOURCE: &str = include_str!("../../../examples/hello.re");
const CHECK_FAILURE_SOURCE: &str =
    include_str!("../../../examples/agent-expense-review/modules/api.re");
const SUCCESS_SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const SUCCESS_TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",",
    "\"value\":null},\"variant\":\"ok\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_replay_fault_catalog_records_three_fault_paths_without_receipts() {
    let root = temp_root("faults");
    fs::create_dir_all(&root).unwrap();
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog_path = root.join("catalog.json");
    let output_path = root.join("report.json");
    let transcript_path = root.join("transcript.json");
    fs::write(&transcript_path, TRANSCRIPT).unwrap();
    let node_fault = node_fault_oracle(
        &repo_root,
        &repo_root.join("examples/agent-expense-review/modules/api.re"),
        INPUT,
        &transcript_path,
    );
    let catalog = format!(
        "{{\"schema\":\"re.native-replay-fault-catalog@0.1.0\",\"workloads\":[\
{{\"code\":\"native-conformance-replay-invocation-mismatch\",\"expected_kind\":\"replay-mismatch\",\"input_digest\":{},\"node_fault\":null,\"source\":{},\"transcript\":{},\"workload_id\":\"replay-mismatch\"}},\
{{\"code\":\"unsupported-language-version\",\"expected_kind\":\"check-failure\",\"input_digest\":{},\"node_fault\":{},\"source\":{},\"transcript\":{},\"workload_id\":\"check-failure\"}},\
{{\"code\":\"host-fault-injected\",\"expected_kind\":\"host-fault\",\"input_digest\":{},\"node_fault\":null,\"source\":{},\"transcript\":{},\"workload_id\":\"host-fault\"}}]}}\n",
        quote(INPUT),
        quote(SOURCE),
        quote(TRANSCRIPT),
        quote(INPUT),
        node_fault,
        quote(CHECK_FAILURE_SOURCE),
        quote(TRANSCRIPT),
        quote(INPUT),
        quote(SOURCE),
        quote(HOST_TRANSCRIPT),
    );
    fs::write(&catalog_path, catalog).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "replay-fault-catalog",
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
    let report = fs::read_to_string(&output_path).unwrap();
    assert!(report.contains("re.native-replay-fault-report@0.1.0"));
    assert!(report.contains("\"kind\":\"replay-mismatch\""));
    assert!(report.contains("\"kind\":\"check-failure\""));
    assert!(report.contains("\"kind\":\"host-fault\""));
    assert!(!report.contains("\"receipt_digest\""));
    assert!(!report.contains(repo_root.to_str().unwrap()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_replay_fault_catalog_rejects_success_as_a_fault_and_keeps_output_absent() {
    let root = temp_root("success-confusion");
    fs::create_dir_all(&root).unwrap();
    let catalog_path = root.join("catalog.json");
    let output_path = root.join("report.json");
    let catalog = format!(
        "{{\"schema\":\"re.native-replay-fault-catalog@0.1.0\",\"workloads\":[\
{{\"code\":\"wrong\",\"expected_kind\":\"host-fault\",\"input_digest\":{},\"node_fault\":null,\"source\":{},\"transcript\":{},\"workload_id\":\"one\"}},\
{{\"code\":\"wrong\",\"expected_kind\":\"host-fault\",\"input_digest\":{},\"node_fault\":null,\"source\":{},\"transcript\":{},\"workload_id\":\"two\"}},\
{{\"code\":\"wrong\",\"expected_kind\":\"host-fault\",\"input_digest\":{},\"node_fault\":null,\"source\":{},\"transcript\":{},\"workload_id\":\"three\"}}]}}\n",
        quote(INPUT),
        quote(SUCCESS_SOURCE),
        quote(SUCCESS_TRANSCRIPT),
        quote(INPUT),
        quote(SUCCESS_SOURCE),
        quote(SUCCESS_TRANSCRIPT),
        quote(INPUT),
        quote(SUCCESS_SOURCE),
        quote(SUCCESS_TRANSCRIPT),
    );
    fs::write(&catalog_path, catalog).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "replay-fault-catalog",
            catalog_path.to_str().unwrap(),
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!output_path.exists());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("replay-fault-success-failure-confusion")
    );
    fs::remove_dir_all(root).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp275-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn node_fault_oracle(
    repo_root: &Path,
    source_path: &Path,
    input_digest: &str,
    transcript_path: &Path,
) -> String {
    let output = Command::new("node")
        .args([
            ORACLE_SCRIPT,
            source_path.to_str().unwrap(),
            input_digest,
            transcript_path.to_str().unwrap(),
        ])
        .current_dir(repo_root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .trim_end_matches('\n')
        .to_owned()
}
