use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::canonical_json::{JsonValue, canonicalize};
use revia_core::digest::sha256_hex;
use revia_core::project::{
    NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule, parse_json,
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
fn native_project_surface_check_rejects_invalid_agent_state_machines() {
    for (mutation, expected_code) in [
        (
            duplicate_agent_event as fn(&mut JsonValue),
            "native-project-module-surface-agent-duplicate-event",
        ),
        (
            terminal_agent_state_has_transition,
            "native-project-module-surface-agent-terminal-transition",
        ),
        (
            add_unreachable_agent_state,
            "native-project-module-surface-agent-unreachable-state",
        ),
        (
            remove_agent_state_outgoing_transition,
            "native-project-module-surface-agent-missing-outgoing-transition",
        ),
        (
            mark_terminal_agent_state_retryable,
            "native-project-module-surface-agent-retryable-terminal-state",
        ),
    ] {
        let project = mutated_expense_agent_contract(mutation);
        let output = Command::new(env!("CARGO_BIN_EXE_revia"))
            .args(["project-surface-check", project.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "invalid Agent lifecycle mutation unexpectedly passed"
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(expected_code),
            "expected {expected_code}, got:\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
        fs::remove_dir_all(project).unwrap();
    }
}

#[test]
fn native_project_surface_check_accepts_agent_lifecycle_array_reordering() {
    let project = mutated_expense_agent_contract(|contract| {
        reverse_array_field(contract, "states");
        reverse_array_field(contract, "events");
        reverse_array_field(contract, "retryable_states");
        reverse_array_field(contract, "terminal_states");
        reverse_array_field(contract, "transitions");
    });
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-surface-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "reordered equivalent lifecycle contract was rejected:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
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
        "re 1.0 compact\nmodule agent.surface.main\nexport main\nagent-declaration agent.surface.main {\"agent\":\"agent.surface.main\",\"error_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"events\":[\"cancel\",\"fail\",\"stop\",\"succeed\"],\"identity_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"initial_state\":\"created\",\"input_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"module\":\"agent.surface.main\",\"output_type\":{\"kind\":\"primitive\",\"name\":\"text.utf8\"},\"retryable_states\":[],\"schema\":\"re.agent-contract@0.1.0\",\"states\":[\"cancelled\",\"created\",\"failed\",\"stopped\",\"succeeded\"],\"terminal_states\":[{\"outcome\":\"cancelled\",\"state\":\"cancelled\"},{\"outcome\":\"failed\",\"state\":\"failed\"},{\"outcome\":\"stopped\",\"state\":\"stopped\"},{\"outcome\":\"succeeded\",\"state\":\"succeeded\"}],\"transitions\":[{\"event\":\"cancel\",\"from\":\"created\",\"to\":\"cancelled\"},{\"event\":\"fail\",\"from\":\"created\",\"to\":\"failed\"},{\"event\":\"stop\",\"from\":\"created\",\"to\":\"stopped\"},{\"event\":\"succeed\",\"from\":\"created\",\"to\":\"succeeded\"}]}\n",
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

fn mutated_expense_agent_contract(mutate: impl Fn(&mut JsonValue)) -> PathBuf {
    let root = copy_expense_project();
    let module_path = root.join("modules/intake.re");
    let original_source = fs::read_to_string(&module_path).unwrap();
    let declaration_line = original_source
        .lines()
        .find(|line| line.starts_with("agent-declaration "))
        .unwrap()
        .to_owned();
    let (declaration_name, json) = declaration_line
        .strip_prefix("agent-declaration ")
        .unwrap()
        .split_once(' ')
        .unwrap();
    let mut source_contract = parse_json(json).unwrap();
    mutate(&mut source_contract);
    let updated_line = format!(
        "agent-declaration {declaration_name} {}",
        canonicalize(&source_contract)
    );
    let updated_source = original_source.replacen(&declaration_line, &updated_line, 1);
    let previous_digest = format!("sha256:{}", sha256_hex(original_source.as_bytes()));
    let updated_digest = format!("sha256:{}", sha256_hex(updated_source.as_bytes()));
    fs::write(&module_path, &updated_source).unwrap();

    let manifest_path = root.join("project.json");
    let mut manifest = parse_json(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let agent = array_field_mut(&mut manifest, "agents")
        .first_mut()
        .unwrap();
    mutate(agent);
    replace_project_module_digest(&mut manifest, &previous_digest, &updated_digest);
    fs::write(manifest_path, format!("{}\n", canonicalize(&manifest))).unwrap();
    root
}

fn duplicate_agent_event(contract: &mut JsonValue) {
    let events = array_field_mut(contract, "events");
    events.push(events[0].clone());
}

fn terminal_agent_state_has_transition(contract: &mut JsonValue) {
    array_field_mut(contract, "transitions").push(
        parse_json("{\"event\":\"shutdown\",\"from\":\"succeeded\",\"to\":\"stopped\"}").unwrap(),
    );
}

fn add_unreachable_agent_state(contract: &mut JsonValue) {
    array_field_mut(contract, "states").push(JsonValue::String("orphaned".to_owned()));
}

fn remove_agent_state_outgoing_transition(contract: &mut JsonValue) {
    array_field_mut(contract, "transitions")
        .retain(|transition| string_field(transition, "from") != Some("ready"));
}

fn mark_terminal_agent_state_retryable(contract: &mut JsonValue) {
    array_field_mut(contract, "retryable_states").push(JsonValue::String("succeeded".to_owned()));
}

fn reverse_array_field(value: &mut JsonValue, field: &str) {
    array_field_mut(value, field).reverse();
}

fn array_field_mut<'a>(value: &'a mut JsonValue, field: &str) -> &'a mut Vec<JsonValue> {
    match value {
        JsonValue::Object(entries) => match entries
            .iter_mut()
            .find(|(name, _)| name == field)
            .map(|(_, value)| value)
        {
            Some(JsonValue::Array(values)) => values,
            _ => panic!("{field} is not an array"),
        },
        _ => panic!("value is not an object"),
    }
}

fn string_field<'a>(value: &'a JsonValue, field: &str) -> Option<&'a str> {
    let JsonValue::Object(entries) = value else {
        return None;
    };
    entries.iter().find_map(|(name, value)| {
        if name != field {
            return None;
        }
        let JsonValue::String(value) = value else {
            return None;
        };
        Some(value.as_str())
    })
}

fn replace_project_module_digest(manifest: &mut JsonValue, old: &str, new: &str) {
    for module in array_field_mut(manifest, "modules") {
        if string_field(module, "name") == Some("agent.expense.intake") {
            replace_string_field(module, "source_sha256", old, new);
        }
    }
    let package = object_field_mut(manifest, "package_manifest");
    for module in array_field_mut(package, "modules") {
        if string_field(module, "name") == Some("agent.expense.intake") {
            replace_string_field(module, "implementation_digest", old, new);
        }
    }
}

fn replace_string_field(value: &mut JsonValue, field: &str, expected: &str, replacement: &str) {
    let JsonValue::Object(entries) = value else {
        panic!("value is not an object");
    };
    let Some((_, JsonValue::String(current))) = entries.iter_mut().find(|(name, _)| name == field)
    else {
        panic!("missing string field {field}");
    };
    assert_eq!(current, expected);
    *current = replacement.to_owned();
}

fn object_field_mut<'a>(value: &'a mut JsonValue, field: &str) -> &'a mut JsonValue {
    let JsonValue::Object(entries) = value else {
        panic!("value is not an object");
    };
    entries
        .iter_mut()
        .find(|(name, _)| name == field)
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("missing field {field}"))
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
