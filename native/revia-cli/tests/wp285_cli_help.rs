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
    assert!(
        top_level
            .stdout
            .contains("runtime-receipt-verify <pin> <receipt> <result> <stdout>")
    );
    assert!(top_level.stdout.contains("project-run-verify <run>"));

    let explicit = run(&root, &["help"]);
    assert_eq!(explicit.stdout, top_level.stdout);

    assert!(
        top_level.stdout.contains("  66 input file unreadable"),
        "the legend omits the unreadable-input code: {}",
        top_level.stdout
    );
    assert!(
        top_level.stdout.contains("  101 internal panic"),
        "the legend omits the panic code: {}",
        top_level.stdout
    );

    let command_help = run(&root, &["help", "check"]);
    assert!(command_help.status.success());
    assert!(command_help.stdout.contains("revia check <file>"));
    assert!(command_help.stdout.contains("exit 65"));
    assert!(command_help.stdout.contains("exit 66"));

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
fn native_cli_exit_code_legend_matches_the_observed_codes() {
    let root = temp_root();
    fs::create_dir_all(root.join("directory")).unwrap();

    let legend = run(&root, &["--help"]);
    for line in [
        "  0  success",
        "  64 usage or unknown command",
        "  65 source, project, or contract failure",
        "  66 input file unreadable",
        "  101 internal panic (a defect; report the input)",
    ] {
        assert!(
            legend.stdout.contains(line),
            "the legend lost a line: {line}"
        );
    }

    let missing = run(&root, &["check", "absent.re"]);
    assert_eq!(missing.status.code(), Some(66));
    assert!(missing.stdout.contains("\"code\":\"input-unreadable\""));
    assert!(missing.stdout.contains("\"file\":\"absent.re\""));

    let directory = run(&root, &["check", "directory"]);
    assert_eq!(directory.status.code(), Some(66));

    let usage = run(&root, &["check"]);
    assert_eq!(usage.status.code(), Some(64));

    cleanup(&root);
}

#[test]
fn native_cli_unreadable_input_reports_a_diagnostic() {
    // Exit 66 used to be silent; every unreadable-input class now reports one
    // JSON diagnostic carrying the path, on the check envelope.
    let root = temp_root();
    fs::create_dir_all(root.join("directory")).unwrap();
    let mut inputs: Vec<&str> = vec!["absent.re", "directory"];
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("no-such-target.re", root.join("broken.re")).unwrap();
        inputs.push("broken.re");
    }
    fs::write(root.join("denied.re"), "re 0.1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut mode = fs::metadata(root.join("denied.re")).unwrap().permissions();
        mode.set_mode(0o000);
        fs::set_permissions(root.join("denied.re"), mode).unwrap();
    }

    for input in inputs {
        let output = run(&root, &["check", input]);
        assert_eq!(output.status.code(), Some(66), "{input} did not exit 66");
        assert!(
            output.stderr.is_empty(),
            "{input} wrote to stderr: {}",
            output.stderr
        );
        assert!(
            output.stdout.contains("\"code\":\"input-unreadable\""),
            "{input} reported no input-unreadable diagnostic: {}",
            output.stdout
        );
        assert!(
            output.stdout.contains(&format!("\"file\":\"{input}\"")),
            "{input} diagnostic names no path: {}",
            output.stdout
        );
        assert!(
            output.stdout.contains("\"ok\":false"),
            "{input} diagnostic lacks ok:false: {}",
            output.stdout
        );
    }

    // A superuser reads past file permissions, so the denied row only runs
    // where the mode actually denies the read.
    if fs::read(root.join("denied.re")).is_err() {
        let output = run(&root, &["check", "denied.re"]);
        assert_eq!(output.status.code(), Some(66));
        assert!(output.stdout.contains("\"code\":\"input-unreadable\""));
        assert!(output.stdout.contains("\"file\":\"denied.re\""));
    }
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
    let usage = run(&root, &["unknown-command"]);
    assert_eq!(usage.status.code(), Some(64));
    assert!(usage.stderr.contains("runtime-receipt-verify"));
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
        "runtime-receipt-verify",
        "project-run-verify",
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

#[test]
fn native_cli_remaining_exit_66_inputs_report_a_diagnostic() {
    // WP-483: the transcript, catalog, digest, and path-resolution readers used
    // to short-circuit with a bare 66; each now prints the same source
    // diagnostic the check path prints, before exiting.
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();

    for (args, file) in [
        (
            vec!["replay-fault-corpus", "absent-corpus.json", "out.json"],
            "absent-corpus.json",
        ),
        (vec!["digest", "absent-source.re"], "absent-source.re"),
    ] {
        let output = run(&root, &args);
        assert_eq!(output.status.code(), Some(66), "{args:?} did not exit 66");
        assert!(
            output.stderr.is_empty(),
            "{args:?} wrote to stderr: {}",
            output.stderr
        );
        assert_input_unreadable(&output, file);
    }

    // The path-resolution family only fails when the working directory cannot
    // be read, so a shell wrapper deletes the directory before exec. It has
    // no Windows equivalent: a deleted directory there keeps a usable handle.
    #[cfg(unix)]
    {
        let gone = root.join("gone");
        fs::create_dir_all(&gone).unwrap();
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg("cd \"$0\" && rmdir \"$0\" && exec \"$1\" capability-comparison catalog.json out.json")
            .arg(&gone)
            .arg(env!("CARGO_BIN_EXE_revia"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .unwrap();
        let output = Output {
            status: output.status,
            stdout: String::from_utf8(output.stdout).unwrap(),
            stderr: String::from_utf8(output.stderr).unwrap(),
        };
        assert_eq!(
            output.status.code(),
            Some(66),
            "the path resolver did not exit 66"
        );
        assert!(
            output.stderr.is_empty(),
            "the path resolver wrote to stderr: {}",
            output.stderr
        );
        assert_input_unreadable(&output, "out.json");
    }

    cleanup(&root);
}

fn assert_input_unreadable(output: &Output, file: &str) {
    for needle in [
        "\"code\":\"input-unreadable\"",
        "\"schema\":\"re.source-diagnostic@0.1.0\"",
        "\"severity\":\"error\"",
        "\"phase\":\"source\"",
        "\"rule\":\"source.read\"",
    ] {
        assert!(
            output.stdout.contains(needle),
            "{file} diagnostic lacks {needle}: {}",
            output.stdout
        );
    }
    assert!(
        output.stdout.contains(&format!("\"file\":\"{file}\"")),
        "{file} diagnostic names no path: {}",
        output.stdout
    );
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
