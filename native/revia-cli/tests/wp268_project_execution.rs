use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProjectModule, serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, NativeProjectExecutionStep, serialize_project_execution_plan,
    },
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CONTRACT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = include_str!("../../../examples/hello.re");

#[test]
fn native_cli_project_execution_plan_is_replayable_and_path_free() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root();
    fs::create_dir_all(root.join("modules")).unwrap();
    fs::write(root.join("modules/core.re"), SOURCE).unwrap();
    fs::write(root.join("modules/api.re"), SOURCE).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));

    let core_interface = NativeInterface::new(
        "agent.native.core",
        vec![],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.native.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest.clone(),
            "agent.native.core",
        )],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let package = NativePackage::new(
        "agent.native",
        vec![
            NativeModule::new("agent.native.core", source_digest.clone(), core_interface),
            NativeModule::new("agent.native.api", source_digest.clone(), api_interface),
        ],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[
                NativeProjectModule::new(
                    "agent.native.core",
                    "modules/core.re",
                    source_digest.clone(),
                ),
                NativeProjectModule::new("agent.native.api", "modules/api.re", source_digest),
            ],
            &package,
        )
        .unwrap(),
    )
    .unwrap();

    let plan = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            core_interface_digest,
            CONTRACT,
        )],
    );
    let plan_path = root.with_file_name(format!(
        "{}-plan.json",
        root.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    let args = [
        "project-execute-plan",
        root.to_str().unwrap(),
        plan_path.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        INPUT,
    ];
    let first = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "status={:?} stdout={} stderr={}",
        first.status,
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let second = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args(args)
        .output()
        .unwrap();
    assert_eq!(second.stdout, first.stdout);
    let output = String::from_utf8(first.stdout).unwrap();
    assert!(output.contains("re.native-project-execution@0.1.0"));
    assert!(output.contains("agent.native.core"));
    assert!(output.contains("agent.native.api"));
    assert!(!output.contains(root.to_str().unwrap()));

    fs::remove_dir_all(root).unwrap();
    fs::remove_file(plan_path).unwrap();
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp268-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
