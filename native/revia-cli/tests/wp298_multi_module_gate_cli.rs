use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
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
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn multi_module_gate_binds_build_translation_and_execution_authority() {
    let fixture = fixture();
    let report = fixture.report_path.clone();

    let first = run(&fixture.root, &fixture.plan_path, &report);
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        text(&first.stdout),
        text(&first.stderr)
    );
    let second = run(&fixture.root, &fixture.plan_path, &report);
    assert!(
        second.status.success(),
        "stdout={} stderr={}",
        text(&second.stdout),
        text(&second.stderr)
    );
    assert_eq!(second.stdout, first.stdout);

    let output = text(&first.stdout);
    assert!(output.contains("re.native-multi-module-gate@0.1.0"));
    assert!(output.contains("agent.native.core"));
    assert!(output.contains("agent.native.api"));
    assert!(output.contains("\"modules\":["));
    assert!(!output.contains(fixture.root.to_str().unwrap()));
    assert_eq!(fs::read(&report).unwrap(), first.stdout);
    cleanup(&fixture);
}

#[test]
fn multi_module_gate_rejects_source_drift_before_report_write() {
    let fixture = fixture();
    let report = fixture.report_path.clone();
    fs::write(&report, b"sentinel\n").unwrap();
    fs::write(fixture.root.join("modules/core.re"), b"re 1.0 compact\n").unwrap();

    let result = run(&fixture.root, &fixture.plan_path, &report);
    assert_eq!(result.status.code(), Some(65));
    assert!(text(&result.stdout).contains("project-module-source-digest-mismatch"));
    assert_eq!(fs::read(&report).unwrap(), b"sentinel\n");
    cleanup(&fixture);
}

#[test]
fn multi_module_gate_rejects_interface_pin_drift_before_report_write() {
    let fixture = fixture();
    let report = fixture.report_path.clone();
    let mut plan = fixture.plan.clone();
    plan.steps[0].interface_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
    let plan_path = fixture.plan_path.with_file_name(format!(
        "{}-drift.json",
        fixture.plan_path.file_stem().unwrap().to_string_lossy()
    ));
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();

    let result = run(&fixture.root, &plan_path, &report);
    assert_eq!(result.status.code(), Some(65));
    assert!(
        text(&result.stdout).contains("native-project-call-interface-mismatch"),
        "stdout={} stderr={}",
        text(&result.stdout),
        text(&result.stderr)
    );
    assert!(!report.exists());
    let _ = fs::remove_file(&plan_path);
    cleanup(&fixture);
}

struct Fixture {
    plan_path: PathBuf,
    report_path: PathBuf,
    root: PathBuf,
    plan: NativeProjectExecutionPlan,
}

fn fixture() -> Fixture {
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
    let report_path = root.with_file_name(format!(
        "{}-report.json",
        root.file_name().unwrap().to_string_lossy()
    ));
    fs::write(&plan_path, serialize_project_execution_plan(&plan).unwrap()).unwrap();
    Fixture {
        plan_path,
        report_path,
        root,
        plan,
    }
}

fn run(root: &Path, plan: &Path, report: &Path) -> std::process::Output {
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/release/revia");
    Command::new(binary)
        .args([
            "project-multi-module-gate",
            root.to_str().unwrap(),
            plan.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
            report.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn cleanup(fixture: &Fixture) {
    let _ = fs::remove_dir_all(&fixture.root);
    let _ = fs::remove_file(&fixture.plan_path);
    let _ = fs::remove_file(&fixture.report_path);
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp298-cli-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
