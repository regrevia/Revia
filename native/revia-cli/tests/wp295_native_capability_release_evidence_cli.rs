use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const SOURCE: &str = "test/fixtures/native-node-free-enterprise/modules/m000.re";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";
const CORPUS: &str = "test/fixtures/native-fault-corpus.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn release_evidence_gate_binds_fresh_project_capability_report() {
    let root = temp_root("project-capability");
    fs::create_dir_all(&root).unwrap();
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let first_path = root.join("first.json");
    let second_path = root.join("second.json");
    let repo_root = repo_root();
    let binary_name = if cfg!(windows) { "revia.exe" } else { "revia" };
    let binary = repo_root.join("native/target/release").join(binary_name);

    let first = run(&binary, &repo_root, &empty_path, &first_path);
    assert!(first.status.success(), "{}", text(&first.stderr));
    let second = run(&binary, &repo_root, &empty_path, &second_path);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.stdout, fs::read(&first_path).unwrap());
    assert_eq!(first.stdout, fs::read(&second_path).unwrap());
    assert!(text(&first.stdout).contains(
        "\"project_capability_schema\":\"re.native-capability-project-comparison-report@0.1.0\""
    ));
    assert!(text(&first.stdout).contains("\"schema\":\"re.native-release-evidence@0.4.0\""));
    assert!(text(&first.stdout).contains("\"project_capability_catalog_digest\":"));
    assert!(text(&first.stdout).contains("\"project_capability_project_digest\":"));
    assert!(text(&first.stdout).contains("\"project_capability_report_digest\":"));
    assert!(!text(&first.stdout).contains(root.to_str().unwrap()));
}

#[test]
fn release_evidence_gate_rejects_debug_before_project_capability_children() {
    let root = temp_root("debug");
    fs::create_dir_all(&root).unwrap();
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let evidence_path = root.join("evidence.json");
    let repo_root = repo_root();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
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

    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(!evidence_path.exists());
    assert!(text(&output.stderr).contains("native-release-evidence-release-binary-required"));
}

fn run(
    binary: &Path,
    repo_root: &Path,
    empty_path: &Path,
    evidence_path: &Path,
) -> std::process::Output {
    Command::new(binary)
        .current_dir(repo_root)
        .args([
            "release-evidence-gate",
            &repo_root.join(SOURCE).to_string_lossy(),
            &repo_root.join(PROJECT).to_string_lossy(),
            MODULE,
            &repo_root.join(CORPUS).to_string_lossy(),
            &evidence_path.to_string_lossy(),
        ])
        .env_clear()
        .env("PATH", empty_path)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp295-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}
