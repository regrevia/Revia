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

#[test]
fn native_project_surface_check_rejects_detached_adapter_authority() {
    for (old_field, new_field, expected_code) in [
        (
            "\"instance\":\"@expense_db\"",
            "\"instance\":\"@other_db\"",
            "native-project-module-surface-resource-mismatch",
        ),
        (
            "\"member\":\"read\"",
            "\"member\":\"write\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"reference\":\"db.read@0.1.0\"",
            "\"reference\":\"db.write@0.1.0\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"node_uid\":\"ddddddddddddddddddddddddde\"",
            "\"node_uid\":\"eeeeeeeeeeeeeeeeeeeeeeeeee\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"constructor\":\"expense_db\"",
            "\"constructor\":\"other_db\"",
            "native-project-module-surface-resource-not-declared",
        ),
        (
            "\"access\":\"read\"",
            "\"access\":\"write\"",
            "native-project-module-surface-resource-mismatch",
        ),
    ] {
        let project = mutated_expense_project("adapter-contract ", old_field, new_field);
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .args(["project-surface-check", project.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "adapter mutation unexpectedly passed: {old_field} -> {new_field}"
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(expected_code),
            "expected {expected_code} for {old_field} -> {new_field}, got:\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("\"schema\":\"re.native-project-surface-result@0.1.0\"")
        );
        fs::remove_dir_all(project).unwrap();
    }
}

#[test]
fn native_project_surface_check_rejects_detached_function_capability_calls() {
    for (old_field, new_field, expected_code) in [
        (
            "\"instance\":\"@expense_db\"",
            "\"instance\":\"@other_db\"",
            "native-project-module-surface-resource-mismatch",
        ),
        (
            "\"member\":\"read\"",
            "\"member\":\"write\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"reference\":\"db.read@0.1.0\"",
            "\"reference\":\"db.write@0.1.0\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"node_uid\":\"ddddddddddddddddddddddddde\"",
            "\"node_uid\":\"eeeeeeeeeeeeeeeeeeeeeeeeee\"",
            "native-project-module-surface-capability-detached",
        ),
        (
            "\"constructor\":\"expense_db\"",
            "\"constructor\":\"other_db\"",
            "native-project-module-surface-resource-not-declared",
        ),
        (
            "\"access\":\"read\"",
            "\"access\":\"write\"",
            "native-project-module-surface-resource-mismatch",
        ),
        (
            "\"effect_edges\":[{\"access\":\"read\"",
            "\"effect_edges\":[{\"access\":\"write\"",
            "native-project-module-surface-function-effect-edge-mismatch",
        ),
        (
            "\"effect_edges\":[{\"access\":\"read\",\"call\":\"expense_db_read\",\"from\":\"request\",\"resource\":\"expense_db\",\"to\":\"expense_db_read\"}]",
            "\"effect_edges\":[]",
            "native-project-module-surface-function-capability-call-missing-effect-edge",
        ),
    ] {
        let project = mutated_expense_project("function-declaration ", old_field, new_field);
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .args(["project-surface-check", project.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "function call mutation unexpectedly passed: {old_field} -> {new_field}"
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(expected_code),
            "expected {expected_code} for {old_field} -> {new_field}, got:\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("\"schema\":\"re.native-project-surface-result@0.1.0\"")
        );
        fs::remove_dir_all(project).unwrap();
    }
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
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("\"schema\":\"re.native-project-surface-result@0.1.0\"")
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

fn mutated_expense_project(declaration_prefix: &str, old_field: &str, new_field: &str) -> PathBuf {
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/agent-expense-review")
        .canonicalize()
        .unwrap();
    let id = PROJECT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "revia-native-expense-surface-{}-{id}",
        std::process::id()
    ));
    copy_directory(&source_root, &root);

    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let adapter_line = original_source
        .lines()
        .find(|line| line.starts_with(declaration_prefix))
        .unwrap()
        .to_owned();
    assert!(
        adapter_line.contains(old_field),
        "adapter contract does not contain mutation target: {old_field}"
    );
    let updated_line = adapter_line.replacen(old_field, new_field, 1);
    let updated_source = original_source.replacen(&adapter_line, &updated_line, 1);
    let previous_digest = format!(
        "sha256:{}",
        sha256_hex(fs::read(&module_path).unwrap().as_slice())
    );
    let updated_digest = format!("sha256:{}", sha256_hex(updated_source.as_bytes()));
    fs::write(&module_path, updated_source).unwrap();

    let manifest_path = root.join("project.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    assert_eq!(manifest.matches(&previous_digest).count(), 2);
    fs::write(
        manifest_path,
        manifest.replace(&previous_digest, &updated_digest),
    )
    .unwrap();
    root
}

fn copy_directory(source: &std::path::Path, destination: &std::path::Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path);
        } else {
            fs::copy(source_path, destination_path).unwrap();
        }
    }
}
