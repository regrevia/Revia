use std::{
    fs,
    path::{Path, PathBuf},
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
fn native_cli_direct_project_execution_matches_plan_entry() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let plan_path = root.join("plan.json");
    let plan = NativeProjectExecutionPlan::new(MODULE, "main", Vec::new());
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    let plan_output = run(
        [
            "project-execute-plan",
            PROJECT,
            plan_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(plan_output.status.success());

    let direct_output = run(
        [
            "project-execute-plan-direct",
            PROJECT,
            plan_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ],
        &repo_root,
    );
    assert!(
        direct_output.status.success(),
        "{}",
        String::from_utf8_lossy(&direct_output.stderr)
    );
    assert_eq!(direct_output.stdout, plan_output.stdout);
    cleanup(&root);
}

fn run<const N: usize>(arguments: [&str; N], repo_root: &Path) -> std::process::Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(repo_root)
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp270-cli-{}-{}-{}",
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
