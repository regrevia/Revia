use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const PROFILE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root(label: &str) -> std::path::PathBuf {
    let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp282-{label}-{}-{id}", std::process::id()))
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn project_init_creates_reproducible_external_project_and_native_test_workflow() {
    let root = temp_root("deterministic");
    let first = root.join("first");
    let second = root.join("second");

    let init_first = run(&["project-init", first.to_str().unwrap()]);
    assert!(
        init_first.status.success(),
        "{}",
        String::from_utf8_lossy(&init_first.stderr)
    );
    let init_second = run(&["project-init", second.to_str().unwrap()]);
    assert!(
        init_second.status.success(),
        "{}",
        String::from_utf8_lossy(&init_second.stderr)
    );

    assert_eq!(
        fs::read(first.join("project.json")).unwrap(),
        fs::read(second.join("project.json")).unwrap()
    );
    assert_eq!(
        fs::read(first.join("modules/main.re")).unwrap(),
        fs::read(second.join("modules/main.re")).unwrap()
    );

    let check = run(&["project-check", first.to_str().unwrap()]);
    assert!(check.status.success());
    assert!(String::from_utf8_lossy(&check.stdout).contains("re.native-project-graph@0.1.0"));

    let project_test = run(&["project-test", first.to_str().unwrap()]);
    assert!(
        project_test.status.success(),
        "{}",
        String::from_utf8_lossy(&project_test.stderr)
    );
    let project_test_stdout = String::from_utf8(project_test.stdout.clone()).unwrap();
    assert!(project_test_stdout.contains("re.native-project-test@0.1.0"));
    assert!(project_test_stdout.contains("\"module\":\"revia.app.main\""));
    assert!(!project_test_stdout.contains(root.to_str().unwrap()));
    let project_test_again = run(&["project-test", first.to_str().unwrap()]);
    assert_eq!(project_test_again.stdout, project_test.stdout);

    let build = run(&[
        "project-build",
        first.to_str().unwrap(),
        root.join("cache").to_str().unwrap(),
        root.join("build").to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
    ]);
    assert!(
        build.status.success(),
        "{}",
        String::from_utf8_lossy(&build.stderr)
    );
    assert!(String::from_utf8_lossy(&build.stdout).contains("\"published\":true"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_init_rejects_non_empty_directory_without_overwriting_or_partial_output() {
    let root = temp_root("non-empty");
    fs::create_dir_all(&root).unwrap();
    let marker = root.join("keep.txt");
    fs::write(&marker, b"keep me").unwrap();

    let output = run(&["project-init", root.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("project-init-target-not-empty"));
    assert_eq!(fs::read(&marker).unwrap(), b"keep me");
    assert!(!root.join("project.json").exists());
    assert!(!root.join("modules").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn project_test_rejects_source_drift_before_translation() {
    let root = temp_root("drift");
    let init = run(&["project-init", root.to_str().unwrap()]);
    assert!(init.status.success());
    fs::write(
        root.join("modules/main.re"),
        b"re 0.1 compact\nunit @changed\n",
    )
    .unwrap();

    let output = run(&["project-test", root.to_str().unwrap()]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("project-module-source-digest-mismatch")
    );

    fs::remove_dir_all(root).unwrap();
}
