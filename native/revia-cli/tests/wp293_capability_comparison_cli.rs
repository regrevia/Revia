use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::capability_comparison::{
    parse_capability_comparison_catalog, parse_capability_comparison_report,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn capability_comparison_runs_real_effects_in_fresh_empty_path_children() {
    let root = temp_root("success");
    fs::create_dir_all(&root).unwrap();
    let catalog = root.join("catalog.json");
    let output = root.join("capability-report.json");
    fs::write(
        &catalog,
        include_str!("../../../test/fixtures/native-capability-comparison-catalog.json"),
    )
    .unwrap();

    let first = run(&[
        "capability-comparison",
        catalog.to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&output).unwrap());
    assert!(text(&first.stdout).contains("re.native-capability-comparison-report@0.1.0"));
    assert!(text(&first.stdout).contains("\"workload_id\":\"args-success\""));
    assert!(text(&first.stdout).contains("\"workload_id\":\"read-missing\""));
    assert!(text(&first.stdout).contains("\"workload_id\":\"write-success\""));
    assert!(!text(&first.stdout).contains(root.to_str().unwrap()));

    let catalog_value =
        parse_capability_comparison_catalog(&text(&fs::read(&catalog).unwrap())).unwrap();
    let report = parse_capability_comparison_report(&catalog_value, &text(&first.stdout)).unwrap();
    assert_eq!(report.observations.len(), 4);
    assert!(
        report
            .observations
            .iter()
            .all(|observation| observation.status == "matched")
    );

    let second_output = root.join("capability-report-second.json");
    let second = run(&[
        "capability-comparison",
        catalog.to_str().unwrap(),
        second_output.to_str().unwrap(),
    ]);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.stdout, fs::read(&second_output).unwrap());
}

#[test]
fn capability_comparison_rejects_effect_drift_before_report_write() {
    let root = temp_root("drift");
    fs::create_dir_all(&root).unwrap();
    let catalog = root.join("catalog.json");
    let output = root.join("capability-report.json");
    let source = include_str!("../../../test/fixtures/native-capability-comparison-catalog.json")
        .replace(
            "\"bytes_hex\":\"hex:410042\"",
            "\"bytes_hex\":\"hex:410043\"",
        );
    fs::write(&catalog, source).unwrap();

    let result = run(&[
        "capability-comparison",
        catalog.to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(text(&result.stderr).contains("native-capability-comparison-sandbox-effect-mismatch"));
    assert!(!output.exists());
}

#[test]
fn capability_comparison_preserves_existing_report_on_catalog_failure() {
    let root = temp_root("preserve");
    fs::create_dir_all(&root).unwrap();
    let catalog = root.join("catalog.json");
    let output = root.join("capability-report.json");
    let source = include_str!("../../../test/fixtures/native-capability-comparison-catalog.json")
        .replace(
            "\"operation\":\"process.args@0.1.0.read\"",
            "\"operation\":\"fs.read@0.1.0.read_file\"",
        );
    fs::write(&catalog, source).unwrap();
    fs::write(&output, b"sentinel-report\n").unwrap();

    let result = run(&[
        "capability-comparison",
        catalog.to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(
        text(&result.stderr).contains("native-capability-comparison-operation-authority-mismatch")
    );
    assert_eq!(fs::read(&output).unwrap(), b"sentinel-report\n");
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
        "revia-wp293-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
