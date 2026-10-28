use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const GRAPH: &str = "test/golden/canonical-hello.re";
const INPUT: &str = "sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083";
const INVOCATION_ID: &str = "aaaaaadaaaaaaaaaaaaaaaaaaa";
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
fn native_replay_entry_executes_the_declared_transcript() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("transcript");
    fs::write(&transcript_path, TRANSCRIPT).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "conformance-run",
            GRAPH,
            INPUT,
            transcript_path.to_str().unwrap(),
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
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("\"outcome\":{\"code\":0,\"type\":\"process.status\"}"));
    assert!(stdout.contains(&format!("\"invocation_id\":\"{INVOCATION_ID}\"")));
    cleanup(&transcript_path);
}

#[test]
fn native_replay_entry_rejects_transcript_identity_drift_before_effect() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("drift");
    let drifted = TRANSCRIPT.replace("\"member\":\"write\"", "\"member\":\"read\"");
    fs::write(&transcript_path, drifted).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "conformance-run",
            GRAPH,
            INPUT,
            transcript_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("native-conformance-replay-invocation-mismatch")
    );
    cleanup(&transcript_path);
}

#[test]
fn native_replay_entry_rejects_missing_and_extra_invocations() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (label, transcript) in [
        (
            "missing",
            "{\"invocations\":[],\"schema\":\"re.native-vm-replay@0.1.0\"}\n".to_owned(),
        ),
        (
            "extra",
            TRANSCRIPT.replace(
                "],\"schema\"",
                ",{\"arguments\":{},\"instance\":\"@stdout\",\"invocation_id\":\"extra\",\"member\":\"write\",\"response\":{\"kind\":\"value\",\"payload\":{\"type\":\"unit\",\"value\":null},\"variant\":\"ok\"}}],\"schema\"",
            ),
        ),
    ] {
        let transcript_path = temp_path(label);
        fs::write(&transcript_path, transcript).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .current_dir(&repo_root)
            .args([
                "conformance-run",
                GRAPH,
                INPUT,
                transcript_path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(!output.status.success(), "{label} unexpectedly succeeded");
        assert!(output.stdout.is_empty(), "{label} wrote stdout");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("native-conformance-replay-invocation-mismatch"),
            "{label} stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        cleanup(&transcript_path);
    }
}

#[test]
fn native_replay_entry_rejects_argument_drift_before_effect() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("argument-drift");
    let drifted = TRANSCRIPT.replace("Hello, World!", "Goodbye, World!");
    fs::write(&transcript_path, drifted).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "conformance-run",
            GRAPH,
            INPUT,
            transcript_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("native-conformance-replay-invocation-mismatch")
    );
    cleanup(&transcript_path);
}

#[test]
fn native_replay_entry_rejects_invalid_input_digest() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let transcript_path = temp_path("input-drift");
    fs::write(&transcript_path, TRANSCRIPT).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "conformance-run",
            GRAPH,
            "not-a-digest",
            transcript_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("native-vm-request-input-digest-invalid")
    );
    cleanup(&transcript_path);
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp272-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(path: &Path) {
    let _ = fs::remove_file(path);
}
