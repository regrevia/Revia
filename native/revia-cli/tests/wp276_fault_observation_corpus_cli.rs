use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    fault_corpus::{
        FaultStage, NativeFaultCorpus, NativeFaultCorpusCase, serialize_native_fault_corpus,
    },
    replay::{NativeReplayTranscript, serialize_native_replay_transcript},
    replay_fault_catalog::ReplayFaultKind,
};

const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HELLO: &str = include_str!("../../../test/golden/canonical-hello.re");
const INVALID_COMPACT: &str = "re 0.1 compact\nunit @broken\nfn @main() -> process.status {\n";
const HOST_TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"code\":\"host-fault-injected\",\"kind\":\"host_fault\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
const IDENTITY_DRIFT_TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"bbbbbbbaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"code\":\"host-fault-injected\",\"kind\":\"host_fault\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
const SUCCESS_TRANSCRIPT: &str = concat!(
    "{\"invocations\":[{\"arguments\":{\"data\":{\"type\":\"text.utf8\",",
    "\"value\":\"Hello, World!\\n\"}},\"instance\":\"@stdout\",",
    "\"invocation_id\":\"aaaaaadaaaaaaaaaaaaaaaaaaa\",\"member\":\"write\",",
    "\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",",
    "\"value\":null},\"variant\":\"ok\"}}],",
    "\"schema\":\"re.native-vm-replay@0.1.0\"}\n"
);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn empty_transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(Vec::new())).unwrap()
}

fn corpus() -> NativeFaultCorpus {
    NativeFaultCorpus::new(vec![
        NativeFaultCorpusCase::new(
            "empty-transcript",
            HELLO,
            INPUT,
            empty_transcript(),
            FaultStage::ReplayMismatch,
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
        ),
        NativeFaultCorpusCase::new(
            "identity-drift",
            HELLO,
            INPUT,
            IDENTITY_DRIFT_TRANSCRIPT,
            FaultStage::ReplayMismatch,
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
        ),
        NativeFaultCorpusCase::new(
            "unsupported-version",
            "re 1.0 compact\nmodule broken\n",
            INPUT,
            empty_transcript(),
            FaultStage::CheckedError,
            ReplayFaultKind::CheckFailure,
            "unsupported-language-version",
        ),
        NativeFaultCorpusCase::new(
            "invalid-module",
            INVALID_COMPACT,
            INPUT,
            empty_transcript(),
            FaultStage::CheckedError,
            ReplayFaultKind::CheckFailure,
            "unexpected-token",
        ),
        NativeFaultCorpusCase::new(
            "host-observation",
            HELLO,
            INPUT,
            HOST_TRANSCRIPT,
            FaultStage::HostObservation,
            ReplayFaultKind::HostFault,
            "host-fault-injected",
        ),
    ])
}

#[test]
fn native_fault_corpus_cli_runs_five_cases_and_reports_exercised_stages() {
    let root = temp_root("report");
    fs::create_dir_all(&root).unwrap();
    let corpus_path = root.join("corpus.json");
    let report_path = root.join("report.json");
    fs::write(
        &corpus_path,
        serialize_native_fault_corpus(&corpus()).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "replay-fault-corpus",
            corpus_path.to_str().unwrap(),
            report_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let report = fs::read_to_string(&report_path).unwrap();
    assert_eq!(stdout, report);
    assert!(report.contains("re.native-fault-observation-report@0.1.0"));
    assert!(report.contains("\"stage\":\"checked-error\""));
    assert!(report.contains("\"stage\":\"replay-mismatch\""));
    assert!(report.contains("\"stage\":\"host-observation\""));
    assert!(report.contains("\"evidence_scope\":\"exercised\""));
    assert!(!report.contains("\"receipt_digest\""));
    assert!(!report.contains(root.to_str().unwrap()));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_fault_corpus_cli_rejects_success_as_fault_before_report_write() {
    let root = temp_root("success");
    fs::create_dir_all(&root).unwrap();
    let corpus_path = root.join("corpus.json");
    let report_path = root.join("report.json");
    let success_corpus = NativeFaultCorpus::new(
        ["one", "two", "three", "four", "five"]
            .into_iter()
            .map(|id| {
                NativeFaultCorpusCase::new(
                    id,
                    HELLO,
                    INPUT,
                    SUCCESS_TRANSCRIPT,
                    FaultStage::HostObservation,
                    ReplayFaultKind::HostFault,
                    "host-fault-injected",
                )
            })
            .collect(),
    );
    fs::write(
        &corpus_path,
        serialize_native_fault_corpus(&success_corpus).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "replay-fault-corpus",
            corpus_path.to_str().unwrap(),
            report_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!report_path.exists());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("native-fault-corpus-success-failure-confusion")
    );
    fs::remove_dir_all(root).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp276-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
