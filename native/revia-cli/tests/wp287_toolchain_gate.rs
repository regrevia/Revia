use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn toolchain_gate_binds_direct_and_project_native_chains() {
    let root = temp_root("success");
    let project = root.join("project");
    let source = root.join("hello.re");
    let first_report = root.join("first-report.json");
    let second_report = root.join("second-report.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let first = run(&[
        "toolchain-gate",
        source.to_str().unwrap(),
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        first_report.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&first_report).unwrap());
    let first_text = text(&first.stdout);
    assert!(first_text.contains("re.native-toolchain-gate@0.1.0"));
    assert!(first_text.contains("\"direct_compile_digest\":"));
    assert!(first_text.contains("\"direct_translate_digest\":"));
    assert!(first_text.contains("\"direct_run_digest\":"));
    assert!(first_text.contains("\"developer_gate_digest\":"));
    let expected_dependency_scan = if cfg!(target_os = "macos") {
        "otool-L"
    } else if cfg!(target_os = "linux") {
        "ldd"
    } else if cfg!(target_os = "windows") {
        "windows-static-boundary"
    } else {
        "unsupported-platform-static-boundary"
    };
    assert!(first_text.contains(&format!(
        "\"binary_dependency_scan\":\"{expected_dependency_scan}\""
    )));
    assert!(first_text.contains("\"release_build\":true"));
    assert!(!first_text.contains(root.to_str().unwrap()));
    assert!(!first_text.contains("elapsed_ns"));

    let second = run(&[
        "toolchain-gate",
        source.to_str().unwrap(),
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
fn toolchain_gate_rejects_project_drift_before_writing_report() {
    let root = temp_root("drift");
    let project = root.join("project");
    let source = root.join("hello.re");
    let report = root.join("report.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success());
    fs::write(
        project.join("modules/main.re"),
        b"re 0.1 compact\nunit @drifted\n",
    )
    .unwrap();

    let output = run(&[
        "toolchain-gate",
        source.to_str().unwrap(),
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
fn toolchain_gate_rejects_direct_source_project_graph_mismatch() {
    let root = temp_root("source-mismatch");
    let project = root.join("project");
    let source = root.join("different.re");
    let report = root.join("report.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &source,
        include_str!("../../../examples/hello.re").replace("@hello", "@different"),
    )
    .unwrap();

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
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).contains("native-toolchain-gate-source-project-mismatch"));
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn toolchain_gate_rejects_report_inside_project_before_running_stages() {
    let root = temp_root("report-in-project");
    let project = root.join("project");
    let source = root.join("hello.re");
    let report = project.join("toolchain-gate.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let output = run_debug(&[
        "toolchain-gate",
        source.to_str().unwrap(),
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(text(&output.stderr).contains("native-toolchain-gate-report-inside-project"));
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn toolchain_gate_rejects_debug_before_running_stages() {
    let root = temp_root("debug");
    let project = root.join("project");
    let source = root.join("hello.re");
    let report = root.join("report.json");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let output = run_debug(&[
        "toolchain-gate",
        source.to_str().unwrap(),
        project.to_str().unwrap(),
        "revia.app.main",
        INPUT_DIGEST,
        report.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(65));
    assert!(output.stdout.is_empty());
    assert!(!report.exists());
    assert!(text(&output.stderr).contains("native-toolchain-gate-release-binary-required"));

    fs::remove_dir_all(root).unwrap();
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(release_binary())
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn run_debug(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn release_binary() -> PathBuf {
    let name = if cfg!(windows) { "revia.exe" } else { "revia" };
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release")
        .join(name)
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp287-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}
