use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::digest::sha256_hex;
use revia_core::project::{
    NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
    serialize_project_manifest,
};

static PROJECT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn checked_in_project_template_passes_native_project_check() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../projects/_template")
        .canonicalize()
        .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "project-check failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn checked_in_projection_routes_are_project_metadata() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/agent-expense-review")
        .canonicalize()
        .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "project-check rejected projection metadata:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_project_test_reports_module_surface_boundary_explicitly() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../projects/_template")
        .canonicalize()
        .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-test", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("native-project-module-surface-unsupported")
    );
}

#[test]
fn native_project_surface_check_accepts_public_module_projects() {
    for relative in [
        "../../projects/_template",
        "../../examples/agent-expense-review",
    ] {
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(relative)
            .canonicalize()
            .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .args(["project-surface-check", project.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{relative} failed:\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("re.native-project-surface-result@0.1.0")
        );
    }
}

#[test]
fn native_project_surface_check_rejects_duplicate_export_authority() {
    assert_surface_rejected(
        "re 1.0 compact\nmodule agent.surface.main\nexport main\nexport main\n",
        "native-project-module-surface-export-duplicate",
    );
}

#[test]
fn native_project_surface_check_rejects_missing_manifest_exports() {
    assert_surface_rejected(
        "re 1.0 compact\nmodule agent.surface.main\n",
        "native-project-module-surface-export-missing",
    );
}

#[test]
fn native_project_surface_check_requires_module_before_surface_facts() {
    assert_surface_rejected(
        "re 1.0 compact\nexport main\nmodule agent.surface.main\n",
        "native-project-module-surface-module-order-invalid",
    );
}

#[test]
fn native_project_surface_check_rejects_duplicate_review_uids() {
    let uid = format!("{}e", "a".repeat(25));
    let source = format!(
        "re 1.0 compact\nmodule agent.surface.main\nexport main\nerror agent.surface.main.first uid {uid}\nerror agent.surface.main.second uid {uid}\n"
    );
    assert_surface_rejected(
        &source,
        "native-project-module-surface-review-uid-duplicate",
    );
}

fn assert_surface_rejected(source: &str, expected_code: &str) {
    let root = temp_project(source);
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(expected_code),
        "expected {expected_code}, got:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    fs::remove_dir_all(root).unwrap();
}

fn temp_project(source: &str) -> PathBuf {
    let id = PROJECT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "revia-native-project-surface-{}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(root.join("modules")).unwrap();
    let source_path = root.join("modules/main.re");
    fs::write(&source_path, source).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(source.as_bytes()));
    let interface = NativeInterface::new(
        "agent.surface.main",
        Vec::new(),
        vec![NativeExport::function(
            "main",
            format!("sha256:{}", "0".repeat(64)),
        )],
    );
    let package = NativePackage::new(
        "agent.surface",
        vec![NativeModule::new(
            "agent.surface.main",
            source_digest.clone(),
            interface,
        )],
    );
    let manifest = serialize_project_manifest(
        &[NativeProjectModule::new(
            "agent.surface.main",
            "modules/main.re",
            source_digest,
        )],
        &package,
    )
    .unwrap();
    fs::write(root.join("project.json"), manifest).unwrap();
    root
}
