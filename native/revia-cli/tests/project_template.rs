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
