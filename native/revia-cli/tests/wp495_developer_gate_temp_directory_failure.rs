use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn developer_gate_reports_temporary_directory_failure_as_object() {
    let root = temp_root("temp-directory-failure");
    let project = root.join("project");
    let report = root.join("report.json");
    fs::create_dir_all(&root).unwrap();
    let blocked_temp = root.join("not-a-directory");
    fs::write(&blocked_temp, b"").unwrap();

    let init = run(&["project-init", project.to_str().unwrap()], None);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let blocked = blocked_temp.to_str().unwrap();
    let output = run(
        &[
            "developer-gate",
            project.to_str().unwrap(),
            "revia.app.main",
            INPUT_DIGEST,
            report.to_str().unwrap(),
        ],
        Some(blocked),
    );
    assert_eq!(output.status.code(), Some(74));
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-developer-gate-"#,
            r#"temporary-directory-failure"}],"ok":false,"#,
            r#""schema":"re.native-developer-gate@0.1.0"}"#,
        )
    );
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str], blocked_temp: Option<&str>) -> process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_revia"));
    command.args(arguments);
    if let Some(blocked) = blocked_temp {
        command.env("TMPDIR", blocked);
        command.env("TMP", blocked);
        command.env("TEMP", blocked);
    }
    command.output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp495-{label}-{}-{counter}", process::id()))
}
