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
        (
            "\"schema\":\"re.agent-adapter-contract@0.1.0\"",
            "\"schema\":\"re.agent-adapter-contract@9.9.9\"",
            "native-project-module-surface-adapter-invalid",
        ),
        (
            "\"agent\":\"agent.expense.intake\"",
            "\"agent\":\"agent.expense.approval\"",
            "native-project-module-surface-adapter-owner-mismatch",
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
        (
            ",\"schema\":\"re.function-declaration@0.1.0\"",
            "",
            "native-project-module-surface-function-invalid",
        ),
        (
            "\"schema\":\"re.function-declaration@0.1.0\"",
            "\"schema\":\"re.function-declaration@9.9.9\"",
            "native-project-module-surface-function-invalid",
        ),
        (
            "\"name\":\"review\"",
            "\"name\":42",
            "native-project-module-surface-function-invalid",
        ),
        (
            "\"name\":\"review\"",
            "\"name\":\"other\"",
            "native-project-module-surface-function-identity-mismatch",
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

#[test]
fn native_project_surface_check_rejects_unsupported_resource_access_modes() {
    let project = mutated_expense_project_with_replacements(&[
        (" read db.read@0.1.0 uid", " admin db.read@0.1.0 uid"),
        ("\"member\":\"read\"", "\"member\":\"admin\""),
        ("\"access\":\"read\"", "\"access\":\"admin\""),
    ]);
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("native-project-module-surface-resource-access-invalid"),
        "unexpected result:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn native_project_surface_check_rejects_project_agent_authority_drift() {
    let project = expense_project_with_manifest_agent_identity("agent.expense.orphan");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "project-surface-check accepted an Agent not present in source declarations:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("project-agent-authority-mismatch"));
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn native_project_surface_check_rejects_agent_contract_content_drift() {
    let project = expense_project_with_agent_contract_event("forged_event");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("project-agent-authority-mismatch"));
    fs::remove_dir_all(project).unwrap();
}

#[test]
fn native_project_check_binds_agent_contracts_to_project_identity() {
    let baseline = copy_expense_project();
    let drifted = expense_project_with_synchronized_agent_contract_event("audit_ping");
    let baseline_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", baseline.to_str().unwrap()])
        .output()
        .unwrap();
    let drifted_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", drifted.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(baseline_output.status.success());
    assert!(drifted_output.status.success());
    let baseline_stdout = String::from_utf8_lossy(&baseline_output.stdout);
    let drifted_stdout = String::from_utf8_lossy(&drifted_output.stdout);
    assert_ne!(
        json_field(&baseline_stdout, "graph_revision"),
        json_field(&drifted_stdout, "graph_revision")
    );
    assert_ne!(
        json_field(&baseline_stdout, "project_digest"),
        json_field(&drifted_stdout, "project_digest")
    );
    fs::remove_dir_all(baseline).unwrap();
    fs::remove_dir_all(drifted).unwrap();
}

#[test]
fn native_project_check_binds_source_only_agent_contracts_to_project_identity() {
    let baseline = temp_project("re 1.0 compact\nmodule agent.surface.main\nexport main\n");
    let with_agent = temp_project(
        "re 1.0 compact\nmodule agent.surface.main\nexport main\nagent-declaration agent.surface.main {\"agent\":\"agent.surface.main\",\"error_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"events\":[\"ready\",\"shutdown\"],\"identity_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"initial_state\":\"created\",\"input_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"module\":\"agent.surface.main\",\"output_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"retryable_states\":[],\"schema\":\"re.agent-contract@0.1.0\",\"states\":[\"created\",\"stopped\"],\"terminal_states\":[{\"outcome\":\"stopped\",\"state\":\"stopped\"}],\"transitions\":[{\"event\":\"shutdown\",\"from\":\"created\",\"to\":\"stopped\"}]}\n",
    );
    let baseline_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", baseline.to_str().unwrap()])
        .output()
        .unwrap();
    let agent_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", with_agent.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(baseline_output.status.success());
    assert!(agent_output.status.success());
    let baseline_stdout = String::from_utf8_lossy(&baseline_output.stdout);
    let agent_stdout = String::from_utf8_lossy(&agent_output.stdout);
    assert_ne!(
        json_field(&baseline_stdout, "graph_revision"),
        json_field(&agent_stdout, "graph_revision")
    );
    assert_ne!(
        json_field(&baseline_stdout, "project_digest"),
        json_field(&agent_stdout, "project_digest")
    );
    fs::remove_dir_all(baseline).unwrap();
    fs::remove_dir_all(with_agent).unwrap();
}

#[test]
fn native_project_surface_check_accepts_manifest_only_agent_authority() {
    let root = copy_expense_project();
    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let updated_source = original_source
        .lines()
        .filter(|line| !line.starts_with("agent-declaration "))
        .collect::<Vec<_>>()
        .join("\n");
    persist_expense_project_module(&root, &module_path, &original_source, &updated_source);

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "surface check rejected Agent authority declared by project.json:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_project_surface_check_rejects_detached_task_contract_agent() {
    let project = mutated_expense_project(
        "task-contract ",
        "\"agent\":\"agent.expense.intake\"",
        "\"agent\":\"agent.expense.approval\"",
    );
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("native-project-module-surface-task-identity-mismatch"),
        "unexpected result:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    fs::remove_dir_all(project).unwrap();
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

fn json_field(source: &str, field: &str) -> String {
    let marker = format!("\"{field}\":\"");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("missing {field} in {source}"))
        + marker.len();
    source[start..].split('"').next().unwrap().to_owned()
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
    let root = copy_expense_project();
    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let declaration_line = original_source
        .lines()
        .find(|line| line.starts_with(declaration_prefix))
        .unwrap()
        .to_owned();
    assert!(
        declaration_line.contains(old_field),
        "declaration does not contain mutation target: {old_field}"
    );
    let updated_line = declaration_line.replacen(old_field, new_field, 1);
    let updated_source = original_source.replacen(&declaration_line, &updated_line, 1);
    persist_expense_project_module(&root, &module_path, &original_source, &updated_source);
    root
}

fn mutated_expense_project_with_replacements(replacements: &[(&str, &str)]) -> PathBuf {
    let root = copy_expense_project();
    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let mut updated_source = original_source.clone();
    for (old_field, new_field) in replacements {
        assert!(
            updated_source.contains(old_field),
            "module source does not contain mutation target: {old_field}"
        );
        updated_source = updated_source.replace(old_field, new_field);
    }
    persist_expense_project_module(&root, &module_path, &original_source, &updated_source);
    root
}

fn expense_project_with_manifest_agent_identity(agent: &str) -> PathBuf {
    let root = copy_expense_project();
    let manifest_path = root.join("project.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    let updated_manifest = manifest.replacen(
        "\"agent\": \"agent.expense.intake\"",
        &format!("\"agent\": \"{agent}\""),
        1,
    );
    assert_ne!(manifest, updated_manifest);
    fs::write(manifest_path, updated_manifest).unwrap();
    root
}

fn copy_expense_project() -> PathBuf {
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
    root
}

fn expense_project_with_agent_contract_event(event: &str) -> PathBuf {
    let root = copy_expense_project();
    let manifest_path = root.join("project.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    let anchor = "        \"shutdown\"\n      ],";
    assert_eq!(manifest.matches(anchor).count(), 1);
    let updated = manifest.replacen(anchor, &format!("        \"{event}\",\n{anchor}"), 1);
    fs::write(manifest_path, updated).unwrap();
    root
}

fn expense_project_with_synchronized_agent_contract_event(event: &str) -> PathBuf {
    let root = copy_expense_project();
    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let agent_line = original_source
        .lines()
        .find(|line| line.starts_with("agent-declaration "))
        .unwrap()
        .to_owned();
    let events_start = agent_line.find("\"events\":[").unwrap() + "\"events\":[".len();
    let events_end = agent_line[events_start..]
        .find(']')
        .map(|offset| events_start + offset)
        .unwrap();
    let updated_agent_line = format!(
        "{}{},\"{event}\"{}",
        &agent_line[..events_start],
        &agent_line[events_start..events_end],
        &agent_line[events_end..]
    );
    let updated_source = original_source.replacen(&agent_line, &updated_agent_line, 1);
    persist_expense_project_module(&root, &module_path, &original_source, &updated_source);

    let manifest_path = root.join("project.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    let anchor = "        \"shutdown\"\n      ],\n      \"identity_type\"";
    assert_eq!(manifest.matches(anchor).count(), 1);
    let updated_manifest = manifest.replacen(
        anchor,
        &format!("        \"shutdown\",\n        \"{event}\"\n      ],\n      \"identity_type\""),
        1,
    );
    fs::write(manifest_path, updated_manifest).unwrap();
    root
}

fn persist_expense_project_module(
    root: &std::path::Path,
    module_path: &std::path::Path,
    original_source: &str,
    updated_source: &str,
) {
    let previous_digest = format!("sha256:{}", sha256_hex(original_source.as_bytes()));
    let updated_digest = format!("sha256:{}", sha256_hex(updated_source.as_bytes()));
    fs::write(module_path, updated_source).unwrap();

    let manifest_path = root.join("project.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    assert_eq!(manifest.matches(&previous_digest).count(), 2);
    fs::write(
        manifest_path,
        manifest.replace(&previous_digest, &updated_digest),
    )
    .unwrap();
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
