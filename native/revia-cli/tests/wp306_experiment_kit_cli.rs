use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const CATALOG: &str = "test/fixtures/native-comparison-catalog.json";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn experiment_kit_cli_runs_native_fixture_twice_and_is_path_free() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let first = temp_path("first");
    let second = temp_path("second");
    for output_path in [&first, &second] {
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .current_dir(&root)
            .args([
                "experiment-kit",
                CATALOG,
                PROJECT,
                output_path.to_str().unwrap(),
            ])
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(root.to_str().unwrap()));
        let report = fs::read_to_string(output_path).unwrap();
        assert!(!report.contains(root.to_str().unwrap()));
        assert!(report.contains("\"comparison_report_digest\":\"sha256:"));
    }
    assert_eq!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    cleanup(&first);
    cleanup(&second);
}

#[test]
fn experiment_kit_cli_rejects_missing_catalog_before_report_write() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output_path = temp_path("missing");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&root)
        .args([
            "experiment-kit",
            "missing-catalog.json",
            PROJECT,
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!output_path.exists());
    cleanup(&output_path);
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp306-{label}-{}-{}-{}",
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
