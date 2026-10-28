use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::project_runtime::{NativeProjectExecutionPlan, serialize_project_execution_plan};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_cli_cached_project_execution_reuses_path_free_artifact_and_rejects_corruption() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let plan_path = root.join("plan.json");
    let cache_path = root.join("execution-cache.json");
    let plan = NativeProjectExecutionPlan::new(MODULE, "main", Vec::new());
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    let first = run(
        [
            "project-execute-plan-cached",
            PROJECT,
            plan_path.to_str().unwrap(),
            cache_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(cache_path.is_file());

    let second = run(
        [
            "project-execute-plan-cached",
            PROJECT,
            plan_path.to_str().unwrap(),
            cache_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(second.status.success());
    assert_eq!(second.stdout, first.stdout);
    let output = String::from_utf8(first.stdout).unwrap();
    assert!(output.contains("re.native-project-execution@0.1.0"));
    assert!(!output.contains(root.to_str().unwrap()));

    fs::write(&cache_path, b"{}\n").unwrap();
    let corrupted = run(
        [
            "project-execute-plan-cached",
            PROJECT,
            plan_path.to_str().unwrap(),
            cache_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(!corrupted.status.success());
    assert!(corrupted.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&corrupted.stderr)
            .contains("native-project-execution-cache-corrupt")
    );

    cleanup(&root);
}

fn run<const N: usize>(arguments: [&str; N], repo_root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(repo_root)
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp269-cli-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(path: &Path) {
    let _ = fs::remove_dir_all(path);
}
