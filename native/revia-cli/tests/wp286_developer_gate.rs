use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn developer_gate_emits_a_path_free_reproducible_report() {
    let root = temp_root("success");
    let project = root.join("project");
    let first_report = root.join("first-report.json");
    let second_report = root.join("second-report.json");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let first = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        first_report.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&first_report).unwrap());
    let first_text = text(&first.stdout);
    assert!(first_text.contains("re.native-developer-gate@0.1.0"));
    assert!(first_text.contains("\"status\":\"passed\""));
    assert!(first_text.contains("\"first_tree_digest\":"));
    assert!(first_text.contains("\"second_tree_digest\":"));
    assert!(first_text.contains("\"reproducible\":true"));
    assert!(!first_text.contains(root.to_str().unwrap()));
    assert!(!first_text.contains("elapsed_ns"));

    let second = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        second_report.to_str().unwrap(),
    ]);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(second.stdout, first.stdout);
    assert_eq!(fs::read(&second_report).unwrap(), first.stdout);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn developer_gate_rejects_source_drift_before_writing_report() {
    let root = temp_root("drift");
    let project = root.join("project");
    let report = root.join("report.json");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success());
    fs::write(
        project.join("modules/main.re"),
        b"re 0.1 compact\nunit @drifted\n",
    )
    .unwrap();

    let output = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).contains("project-module-source-digest-mismatch"));
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn developer_gate_rejects_report_directory_without_partial_write() {
    let root = temp_root("report-directory");
    let project = root.join("project");
    let report = root.join("report");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success());
    fs::create_dir_all(&report).unwrap();

    let output = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(74));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).contains("native-developer-gate-report-write-failure"));
    assert!(report.is_dir());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn developer_gate_rejects_report_inside_project_before_writing() {
    let root = temp_root("report-in-project");
    let project = root.join("project");
    let report = project.join("developer-gate.json");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success());

    let output = run(&[
        "developer-gate",
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).contains("native-developer-gate-report-inside-project"));
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp286-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}
