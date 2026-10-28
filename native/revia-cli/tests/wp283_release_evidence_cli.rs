use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = "test/fixtures/native-node-free-enterprise/modules/m000.re";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";
const CORPUS: &str = "test/fixtures/native-fault-corpus.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn release_evidence_gate_runs_fresh_authorities_and_emits_exact_file() {
    let root = temp_root("success");
    fs::create_dir_all(&root).unwrap();
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let evidence_path = root.join("evidence.json");
    let repo_root = repo_root();
    let release_binary = repo_root.join("native/target/release/revia");
    assert!(
        release_binary.is_file(),
        "build the release binary before this test"
    );

    let output = Command::new(&release_binary)
        .current_dir(&repo_root)
        .args([
            "release-evidence-gate",
            repo_root.join(SOURCE).to_str().unwrap(),
            repo_root.join(PROJECT).to_str().unwrap(),
            MODULE,
            repo_root.join(CORPUS).to_str().unwrap(),
            evidence_path.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", &empty_path)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let evidence = fs::read(&evidence_path).unwrap();
    assert_eq!(output.stdout, evidence);
    let source = String::from_utf8(evidence).unwrap();
    assert!(source.contains("re.native-release-evidence@0.4.0"));
    assert!(
        source
            .contains("\"bundle_comparison_schema\":\"re.native-runtime-bundle-comparison@0.2.0\"")
    );
    assert!(source.contains("\"bundle_comparison_report_digest\":"));
    assert!(source.contains("\"first_manifest_digest\":"));
    assert!(source.contains("\"second_manifest_digest\":"));
    assert!(source.contains("\"process_count\":76"));
    assert!(source.contains("\"status\":\"measured\""));
    assert!(source.contains("\"backend\":\"node\""));
    assert!(source.contains("\"backend\":\"go\""));
    assert!(source.contains("\"backend\":\"jvm\""));
    assert!(!source.contains(root.to_str().unwrap()));
}

#[test]
fn release_evidence_gate_rejects_copied_debug_binary_before_workloads() {
    let root = temp_root("mismatch");
    let release_dir = root.join("release");
    fs::create_dir_all(&release_dir).unwrap();
    let binary = release_dir.join("revia");
    fs::copy(env!("CARGO_BIN_EXE_revia"), &binary).unwrap();
    let evidence_path = root.join("evidence.json");
    let repo_root = repo_root();

    let output = Command::new(&binary)
        .current_dir(&repo_root)
        .args([
            "release-evidence-gate",
            repo_root.join(SOURCE).to_str().unwrap(),
            repo_root.join(PROJECT).to_str().unwrap(),
            MODULE,
            repo_root.join(CORPUS).to_str().unwrap(),
            evidence_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(!evidence_path.exists());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("native-release-evidence-release-binary-required"));
    assert!(!error.contains(root.to_str().unwrap()));
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "revia-wp283-{label}-{}-{counter}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
