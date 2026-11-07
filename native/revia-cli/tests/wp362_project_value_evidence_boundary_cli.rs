//! Boundary evidence for value printing on the project path (WP-362).
//!
//! `--print-values` is available on the three paths that execute a verified
//! artifact directly: `execute`, `run`, and `runtime-run`. The project path
//! (`project-run` and the `project-execute*` family) cannot carry the same
//! evidence at `re.native-project-run@0.1.0`: its envelope is flat and
//! digest-bearing, so a new member is a versioned change rather than an
//! additive one. These tests pin that boundary from the CLI:
//!
//! 1. the project run envelope exposes outcome and digests only — no
//!    per-invocation value data of any shape;
//! 2. the value flag is refused on the project path instead of being silently
//!    ignored;
//! 3. the envelope cannot gain a value member and still verify, and any field
//!    edit moves `run_digest`.
//!
//! The consequence is recorded in
//! `docs/work-packages/result-value-interface.md` §4: the project path keeps no
//! value evidence until the envelope is versioned.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const PROFILE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MODULE: &str = "revia.app.main";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn the_project_run_envelope_carries_no_value_evidence() {
    let root = temp_root("envelope");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    let cache = root.join("cache");
    let build = root.join("build");
    let first = project_run(&project, &cache, &build);
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        text(&first.stdout),
        text(&first.stderr)
    );
    assert!(first.stderr.is_empty(), "{}", text(&first.stderr));
    let second = project_run(&project, &cache, &build);
    assert!(second.status.success(), "{}", text(&second.stderr));

    let source = text(&first.stdout);
    assert_eq!(
        source,
        text(&second.stdout),
        "the project run envelope must be deterministic for one input"
    );

    assert!(source.contains("\"schema\":\"re.native-project-run@0.1.0\""));
    assert!(source.contains("\"outcome_type\":\"process.status\""));
    assert!(source.contains("\"run_digest\":\"sha256:"));
    assert!(source.contains("\"vm_receipt_digest\":\"sha256:"));
    // The boundary: there is no member of any name that carries what the
    // capability call returned, so no flag can print one additively.
    assert!(!source.contains("invocation_values"));
    assert!(!source.contains("\"invocations\""));
    assert!(!source.contains("returned_value"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_value_flag_is_refused_on_the_project_path() {
    let root = temp_root("flag");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    let refused = run(&[
        "--print-values",
        "project-run",
        project.to_str().unwrap(),
        root.join("cache").to_str().unwrap(),
        root.join("build").to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        MODULE,
        INPUT,
    ]);
    assert_eq!(refused.status.code(), Some(64));
    assert!(refused.stdout.is_empty());
    let diagnostics = text(&refused.stderr);
    assert!(
        diagnostics.contains("Usage: revia <"),
        "stderr={diagnostics}"
    );
    // The usage line advertises the flag only where it is accepted.
    assert!(diagnostics.contains("runtime-run [--print-values]"));
    assert!(!diagnostics.contains("project-run [--print-values]"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_project_envelope_cannot_gain_a_value_member_without_a_version_change() {
    let root = temp_root("digest");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    let executed = project_run(&project, &root.join("cache"), &root.join("build"));
    assert!(executed.status.success(), "{}", text(&executed.stderr));
    let run_path = root.join("run.json");
    fs::write(&run_path, &executed.stdout).unwrap();

    let verified = run(&["project-run-verify", run_path.to_str().unwrap()]);
    assert!(verified.status.success(), "{}", text(&verified.stderr));
    let verification = text(&verified.stdout);
    assert!(verification.contains("\"ok\":true"));
    assert!(verification.contains("re.native-project-run-verification@0.1.0"));

    // Insert a value member without disturbing the canonical formatting: the
    // envelope is flat and sorted, so the member belongs after `input_digest`.
    let source = text(&executed.stdout);
    let key = "\"input_digest\":\"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",";
    assert!(source.contains(key), "envelope shape moved: {source}");
    let member = "\"invocation_values\":[{\"type\":\"unit\",\"value\":null}],";
    let widened = source.replacen(key, &format!("{key}{member}"), 1);
    let widened_path = root.join("widened.json");
    fs::write(&widened_path, widened).unwrap();
    let rejected = run(&["project-run-verify", widened_path.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(
        text(&rejected.stderr).contains("unexpected-project-field"),
        "stderr={}",
        text(&rejected.stderr)
    );

    let drifted = source.replacen("\"outcome_code\":0", "\"outcome_code\":1", 1);
    assert_ne!(drifted, source);
    let drifted_path = root.join("drifted.json");
    fs::write(&drifted_path, drifted).unwrap();
    let rejected = run(&["project-run-verify", drifted_path.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(text(&rejected.stderr).contains("native-project-run-digest-mismatch"));

    fs::remove_dir_all(root).unwrap();
}

fn project_run(project: &Path, cache: &Path, build: &Path) -> std::process::Output {
    run(&[
        "project-run",
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        MODULE,
        INPUT,
    ])
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .expect("run revia")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "revia-wp362-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}
