use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn toolchain_gate_reports_write_failure_as_report_object() {
    let root = temp_root("write-failure");
    let project = root.join("project");
    let source = root.join("hello.re");
    let report = root.join("report");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&report).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let output = run(&[
        "toolchain-gate",
        source.to_str().unwrap(),
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(74));
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-toolchain-gate-"#,
            r#"report-write-failure"}],"ok":false,"#,
            r#""schema":"re.native-toolchain-gate@0.1.0"}"#,
        )
    );
    assert!(report.is_dir());
    assert_eq!(fs::read_dir(&report).unwrap().count(), 0);

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str]) -> process::Output {
    Command::new(release_binary())
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn release_binary() -> PathBuf {
    let name = if cfg!(windows) { "revia.exe" } else { "revia" };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release")
        .join(name)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp496-{label}-{}-{counter}", process::id()))
}
