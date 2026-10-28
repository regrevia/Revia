use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProjectModule, serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, NativeProjectExecutionStep, NativeProjectHandoff,
        serialize_project_execution_plan,
    },
    vm::{VmValue, vm_value_digest},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CONTRACT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_cli_consumes_and_reports_a_bounded_unit_handoff() {
    let fixture = make_fixture();
    let unit = VmValue::Unit;
    let plan = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            fixture.core_interface_digest.clone(),
            CONTRACT,
        )],
    )
    .with_root_handoff(NativeProjectHandoff::new(
        "unit",
        128,
        vm_value_digest(&unit),
    ));
    let plan_path = fixture.root.with_file_name("revia-wp271-cli-plan.json");
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "project-execute-plan",
            fixture.root.to_str().unwrap(),
            plan_path.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("native-project-execution@0.1.0"));
    assert!(stdout.contains("\"handoffs\":[{"));
    assert!(stdout.contains("\"type_name\":\"unit\""));
    assert!(!stdout.contains(fixture.root.to_str().unwrap()));

    cleanup(&fixture, &plan_path);
}

struct Fixture {
    root: PathBuf,
    cache: PathBuf,
    build: PathBuf,
    core_interface_digest: String,
}

fn make_fixture() -> Fixture {
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
    Fixture {
        cache: root.with_file_name("revia-wp271-cli-cache"),
        build: root.with_file_name("revia-wp271-cli-build"),
        core_interface_digest,
        root,
    }
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp271-cli-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(fixture: &Fixture, plan_path: &Path) {
    let _ = fs::remove_dir_all(&fixture.root);
    let _ = fs::remove_dir_all(&fixture.cache);
    let _ = fs::remove_dir_all(&fixture.build);
    let _ = fs::remove_file(plan_path);
}
