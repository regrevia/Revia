use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const INPUT_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn bundle_comparison_binds_executed_and_verified_only_domains() {
    let root = temp_root("success");
    let catalog = root.join("catalog.json");
    let output = root.join("bundle-comparison.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &catalog,
        include_str!("../../../test/fixtures/native-comparison-catalog.json"),
    )
    .unwrap();

    let repository_project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(PROJECT);

    let first = run(&[
        "bundle-comparison",
        catalog.to_str().unwrap(),
        repository_project.to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&output).unwrap());
    let report = text(&first.stdout);
    assert!(report.contains("re.native-runtime-bundle-comparison@0.2.0"));
    assert!(report.contains("\"execution_mode\":\"executed\""));
    assert!(report.contains("\"execution_mode\":\"verified-only\""));
    assert!(report.contains("\"workload_id\":\"success\""));
    assert!(report.contains("\"workload_id\":\"host-boundary\""));
    assert!(report.contains("\"project_run\":{"));
    assert!(report.contains("\"project_run\":{\"artifact_digest\""));
    assert!(report.contains("\"vm_receipt_digest\":\"sha256:"));
    assert!(!report.contains(root.to_str().unwrap()));

    let second_output = root.join("bundle-comparison-second.json");
    let second = run(&[
        "bundle-comparison",
        catalog.to_str().unwrap(),
        repository_project.to_str().unwrap(),
        second_output.to_str().unwrap(),
    ]);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.stdout, fs::read(&second_output).unwrap());

    let _ = INPUT_DIGEST;
}

#[test]
fn bundle_comparison_rejects_report_inside_project_without_write() {
    let root = temp_root("report-inside");
    let project = root.join("project");
    let catalog = root.join("catalog.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &catalog,
        include_str!("../../../test/fixtures/native-comparison-catalog.json"),
    )
    .unwrap();
    let output = run(&[
        "bundle-comparison",
        catalog.to_str().unwrap(),
        project.to_str().unwrap(),
        project.join("report.json").to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(
        text(&output.stderr).contains("native-runtime-bundle-comparison-report-inside-project")
    );
    assert!(!project.join("report.json").exists());
}

#[test]
fn bundle_comparison_rejects_project_authority_drift_before_write() {
    let root = temp_root("project-drift");
    let catalog = root.join("catalog.json");
    let output = root.join("bundle-comparison.json");
    let repository_project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(PROJECT);
    fs::create_dir_all(&root).unwrap();
    let catalog_source = include_str!("../../../test/fixtures/native-comparison-catalog.json")
        .replace(
            "sha256:c56120860512c89f769a2cc16e55c3df603af54d64e90a727857e4c0fb8a552a",
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        );
    fs::write(&catalog, catalog_source).unwrap();

    let result = run(&[
        "bundle-comparison",
        catalog.to_str().unwrap(),
        repository_project.to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(
        text(&result.stderr).contains("native-runtime-bundle-comparison-project-digest-mismatch")
    );
    assert!(!output.exists());
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp289-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
