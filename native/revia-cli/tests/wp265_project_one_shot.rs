use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";

#[test]
fn native_project_execute_matches_explicit_project_run_without_user_artifacts() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root("execute");
    let cache = root.join("cache");
    let build = root.join("build");
    fs::create_dir_all(&root).unwrap();

    let explicit = run(
        [
            "project-run",
            PROJECT,
            cache.to_str().unwrap(),
            build.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            MODULE,
            INPUT,
        ],
        &repo_root,
    );
    assert!(explicit.status.success());

    let one_shot = run(
        [
            "project-execute",
            PROJECT,
            MODULE,
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(
        one_shot.status.success(),
        "{}",
        String::from_utf8_lossy(&one_shot.stderr)
    );
    assert_eq!(one_shot.stdout, explicit.stdout);
    assert!(!String::from_utf8_lossy(&one_shot.stdout).contains(root.to_str().unwrap()));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_project_benchmark_is_path_free_and_keeps_unmeasured_languages_pending() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root("benchmark");
    fs::create_dir_all(&root).unwrap();
    let report = root.join("benchmark.json");

    let output = run(
        [
            "project-benchmark",
            PROJECT,
            MODULE,
            PROFILE,
            TOOLCHAIN,
            INPUT,
            report.to_str().unwrap(),
        ],
        &repo_root,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, fs::read(&report).unwrap());
    let report_text = String::from_utf8(output.stdout).unwrap();
    assert!(report_text.contains("re.native-project-benchmark@0.1.0"));
    assert!(report_text.contains("\"iterations\":3"));
    assert!(report_text.contains("\"language\":\"go\""));
    assert!(report_text.contains("\"status\":\"pending\""));
    assert!(!report_text.contains(root.to_str().unwrap()));

    let second_report = root.join("benchmark-second.json");
    let second = run(
        [
            "project-benchmark",
            PROJECT,
            MODULE,
            PROFILE,
            TOOLCHAIN,
            INPUT,
            second_report.to_str().unwrap(),
        ],
        &repo_root,
    );
    assert!(second.status.success());
    let second_text = String::from_utf8(second.stdout).unwrap();
    assert_eq!(
        json_string(&report_text, "stable_digest"),
        json_string(&second_text, "stable_digest")
    );
    assert_eq!(
        json_string(&report_text, "run_digest"),
        json_string(&second_text, "run_digest")
    );

    fs::remove_dir_all(root).unwrap();
}

fn run<const N: usize>(arguments: [&str; N], repo_root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(repo_root)
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp265-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn json_string(source: &str, key: &str) -> String {
    let needle = format!("\"{key}\":\"");
    let start = source.find(&needle).unwrap() + needle.len();
    let end = source[start..].find('"').unwrap();
    source[start..start + end].to_owned()
}
