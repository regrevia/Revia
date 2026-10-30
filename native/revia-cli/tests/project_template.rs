use std::{path::PathBuf, process::Command};

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
