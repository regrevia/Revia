use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn bundle_comparison_reports_write_failure_as_report_object() {
    let root = temp_root("write-failure");
    fs::create_dir_all(&root).unwrap();
    let catalog = root.join("catalog.json");
    let output = root.join("bundle-comparison.json");
    fs::write(
        &catalog,
        include_str!("../../../test/fixtures/native-comparison-catalog.json"),
    )
    .unwrap();
    fs::create_dir_all(&output).unwrap();

    let result = run(&[
        "bundle-comparison",
        catalog.to_str().unwrap(),
        repository_project().to_str().unwrap(),
        output.to_str().unwrap(),
    ]);
    assert_eq!(result.status.code(), Some(74));
    assert!(result.stdout.is_empty());
    assert_eq!(
        text(&result.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-runtime-bundle-"#,
            r#"comparison-report-write-failure"}],"ok":false,"#,
            r#""schema":"re.native-runtime-bundle-comparison@0.2.0"}"#,
        )
    );
    assert!(output.is_dir());
    assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

    fs::remove_dir_all(root).unwrap();
}

fn repository_project() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(PROJECT)
}

fn run(arguments: &[&str]) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp494-{label}-{}-{counter}", process::id()))
}
