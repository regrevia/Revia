use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn developer_gate_reports_containment_refusal_as_object() {
    let root = temp_root("containment");
    let project = root.join("project");
    let report = project.join("developer-gate.json");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let output = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-developer-gate-"#,
            r#"report-inside-project"}],"ok":false,"#,
            r#""schema":"re.native-developer-gate@0.1.0"}"#,
        )
    );
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str]) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp499-{label}-{}-{counter}", process::id()))
}
