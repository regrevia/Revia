use std::process::Command;

#[test]
fn reviewed_task_commands_are_discoverable_before_any_effect_path_exists() {
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .arg("--help")
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("task-request"));
    assert!(stdout.contains("approval-authority"));
    assert!(stdout.contains("task-run"));
}
