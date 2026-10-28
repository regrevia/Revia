use std::{path::PathBuf, process::Command};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";

fn run(module: &str, input: &str) -> std::process::Output {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(repo_root)
        .args([
            "project-server-smoke",
            PROJECT,
            module,
            PROFILE,
            TOOLCHAIN,
            input,
        ])
        .output()
        .unwrap()
}

#[test]
fn native_project_server_smoke_executes_the_project_module_through_an_explicit_route() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "project-server-smoke",
            PROJECT,
            MODULE,
            PROFILE,
            TOOLCHAIN,
            INPUT,
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("\"route_id\":\"project-run\""));
    assert!(stdout.contains("\"status\":200"));
    assert!(stdout.contains("re.native-project-run@0.1.0"));
    assert!(stdout.contains("re.native-project-server-smoke@0.1.0"));
    assert!(!stdout.contains(repo_root.to_str().unwrap()));
    assert!(output.stderr.is_empty());
}

#[test]
fn native_project_server_failures_are_closed_and_keep_diagnostics_off_stdout() {
    for (module, input, code) in [
        (
            MODULE,
            "not-a-digest",
            "native-vm-request-input-digest-invalid",
        ),
        (
            "agent.enterprise.missing",
            INPUT,
            "native-project-entry-not-found",
        ),
    ] {
        let output = run(module, input);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("\"ok\":false"));
        assert!(stderr.contains("re.native-project-server-result@0.1.0"));
        assert!(stderr.contains(&format!("\"code\":\"{code}\"")));
    }
}
