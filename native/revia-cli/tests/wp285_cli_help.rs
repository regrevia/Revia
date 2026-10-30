use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_cli_help_and_version_are_stable_without_input_or_path_dependencies() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();

    let top_level = run(&root, &["--help"]);
    assert!(top_level.status.success());
    assert!(top_level.stdout.contains("revia native 1.0.0-rc.2.2.1"));
    assert!(top_level.stdout.contains("check <file>"));
    assert!(
        top_level
            .stdout
            .contains("comparison-catalog <catalog> <project> <output>")
    );
    assert!(
        top_level
            .stdout
            .contains("experiment-kit <catalog> <project> <output>")
    );
    assert!(top_level.stdout.contains("runtime-verify <bundle>"));

    let explicit = run(&root, &["help"]);
    assert_eq!(explicit.stdout, top_level.stdout);

    let command_help = run(&root, &["help", "check"]);
    assert!(command_help.status.success());
    assert!(command_help.stdout.contains("revia check <file>"));
    assert!(command_help.stdout.contains("exit 65"));

    let suffix_help = run(&root, &["check", "--help"]);
    assert_eq!(suffix_help.stdout, command_help.stdout);
    assert!(suffix_help.stderr.is_empty());

    let version = run(&root, &["--version"]);
    assert!(version.status.success());
    assert_eq!(version.stdout, "revia native 1.0.0-rc.2.2.1\n");
    assert!(version.stderr.is_empty());

    assert!(fs::read_dir(&root).unwrap().next().is_none());
    cleanup(&root);
}

#[test]
fn native_cli_unknown_help_topic_keeps_usage_failure_contract() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();

    let output = run(&root, &["help", "unknown-command"]);
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.contains("unknown-command"));
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    cleanup(&root);
}

#[test]
fn every_supported_native_command_has_a_help_entry() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let commands = [
        "check",
        "lex",
        "digest",
        "canonical",
        "manifest",
        "translate",
        "compile",
        "execute",
        "runtime-package",
        "runtime-verify",
        "runtime-run",
        "bundle-comparison",
        "conformance-run",
        "cross-language-matrix",
        "replay-catalog",
        "comparison-catalog",
        "experiment-kit",
        "replay-fault-catalog",
        "replay-fault-corpus",
        "replay-fault-corpus-gate",
        "verify",
        "run",
        "project-init",
        "project-check",
        "project-surface-check",
        "project-test",
        "project-scale",
        "project-build",
        "project-translate",
        "project-run",
        "project-execute",
        "project-execute-plan",
        "project-execute-plan-direct",
        "project-execute-plan-cached",
        "project-benchmark",
        "server-smoke",
        "project-server-smoke",
        "release-package",
        "release-verify",
        "release-install",
        "release-rollback",
        "release-matrix",
        "node-free-gate",
        "developer-gate",
        "toolchain-gate",
        "release-evidence-gate",
    ];
    for command in commands {
        let output = run(&root, &[command, "--help"]);
        assert!(
            output.status.success(),
            "{command} help failed: {}",
            output.stderr
        );
        assert!(output.stdout.starts_with("revia "));
        assert!(output.stdout.contains(command));
    }
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    cleanup(&root);
}

struct Output {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

fn run(root: &Path, args: &[&str]) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(root)
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    Output {
        status: output.status,
        stdout: String::from_utf8(output.stdout).unwrap(),
        stderr: String::from_utf8(output.stderr).unwrap(),
    }
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp285-cli-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn cleanup(root: &Path) {
    fs::remove_dir_all(root).ok();
}
