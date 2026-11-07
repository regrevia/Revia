//! Boundary evidence for value printing on the project path (WP-362, WP-363).
//!
//! `--print-values` is opt-in on the paths that execute a verified artifact
//! directly: `execute`, `run`, `runtime-run`, and now `project-run`. On the
//! project path the flag does not edit the `re.native-project-run@0.1.0`
//! envelope in place — it selects the versioned envelope
//! `re.native-project-run@0.2.0`, whose only addition is `invocation_values`.
//! Without the flag the emitted bytes are the ones `@0.1.0` always had: flat,
//! 19 members, no value data of any name. These tests pin that boundary from
//! the CLI:
//!
//! 1. the default project run envelope exposes outcome and digests only — no
//!    per-invocation value data of any shape — and is byte-identical on a
//!    rerun, digests included;
//! 2. the value flag is refused on the rest of the project path instead of
//!    being silently ignored, and the usage text advertises it only where it is
//!    accepted;
//! 3. an envelope cannot gain a member its schema does not declare and still
//!    verify, and any field edit moves `run_digest`;
//! 4. with the flag the envelope is `@0.2.0`, carries exactly the observed
//!    invocation values, moves `run_digest`, keeps `vm_receipt_digest`, and
//!    verifies;
//! 5. the run receipt is bound to whichever envelope produced it, so a receipt
//!    from the default run does not verify against the value-carrying run.
//!
//! The consequence is recorded in
//! `docs/work-packages/result-value-interface.md` §4: the project path reports
//! value evidence under a new schema version, never as an additive member of
//! the old one.

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
const UNIT_VALUES: &str = "\"invocation_values\":[{\"type\":\"unit\",\"value\":null}],";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn the_default_project_run_envelope_carries_no_value_evidence() {
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
    // The default bytes are insensitive to the value work: the digests a rerun
    // computes are the ones it always computed.
    for field in ["run_digest", "vm_receipt_digest"] {
        let member = format!("\"{field}\":\"sha256:");
        assert!(source.contains(&member), "{field} missing: {source}");
    }
    // The boundary: there is no member of any name that carries what the
    // capability call returned, so the flag version, not an additive member,
    // is what reports it.
    assert!(!source.contains("invocation_values"));
    assert!(!source.contains("\"invocations\""));
    assert!(!source.contains("returned_value"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_value_flag_is_refused_on_the_other_project_commands() {
    let root = temp_root("flag");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    // Every project command that is not `project-run` keeps refusing the flag
    // instead of stripping it and running anyway.
    for command in [
        "project-execute",
        "project-execute-plan",
        "project-execute-plan-direct",
        "project-execute-plan-cached",
        "project-run-sandbox",
    ] {
        let refused = run(&[command, "--print-values"]);
        assert_eq!(
            refused.status.code(),
            Some(64),
            "{command} accepted the flag: stdout={} stderr={}",
            text(&refused.stdout),
            text(&refused.stderr)
        );
        assert!(
            refused.stdout.is_empty(),
            "{command}: {}",
            text(&refused.stdout)
        );
        let diagnostics = text(&refused.stderr);
        assert!(
            diagnostics.contains("Usage: revia <"),
            "{command}: stderr={diagnostics}"
        );
        // The usage line advertises the flag only where it is accepted.
        assert!(diagnostics.contains("project-run [--project-receipt <receipt>] [--print-values]"));
        assert!(diagnostics.contains("runtime-run [--print-values]"));
        assert!(!diagnostics.contains("project-execute [--print-values]"));
    }

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
    let cache = root.join("cache");
    let build = root.join("build");
    let executed = project_run(&project, &cache, &build);
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
    // The bytes stay canonical, so this is a shape rejection, not a formatting
    // one — the 0.1.0 schema does not declare the member.
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

    // The same rules apply to the versioned envelope: it declares exactly one
    // more member, and a member outside that set is still rejected.
    let valued = text(&project_run_with_values(&project, &cache, &build).stdout);
    assert!(valued.contains(UNIT_VALUES), "valued envelope: {valued}");
    let widened = valued.replacen(
        UNIT_VALUES,
        &format!("{UNIT_VALUES}\"invocation_values_note\":[],"),
        1,
    );
    let widened_path = root.join("valued-widened.json");
    fs::write(&widened_path, widened).unwrap();
    let rejected = run(&["project-run-verify", widened_path.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(
        text(&rejected.stderr).contains("unexpected-project-field"),
        "stderr={}",
        text(&rejected.stderr)
    );

    // Dropping the member makes the source stop matching the schema it claims.
    let stripped = valued.replacen(UNIT_VALUES, "", 1);
    assert_ne!(stripped, valued);
    let stripped_path = root.join("valued-stripped.json");
    fs::write(&stripped_path, stripped).unwrap();
    let rejected = run(&["project-run-verify", stripped_path.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(
        text(&rejected.stderr).contains("native-project-run-schema-mismatch"),
        "stderr={}",
        text(&rejected.stderr)
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_value_flag_emits_a_versioned_envelope_that_verifies() {
    let root = temp_root("valued");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    let cache = root.join("cache");
    let build = root.join("build");
    let default = project_run(&project, &cache, &build);
    assert!(default.status.success(), "{}", text(&default.stderr));
    let valued = project_run_with_values(&project, &cache, &build);
    assert!(
        valued.status.success(),
        "stdout={} stderr={}",
        text(&valued.stdout),
        text(&valued.stderr)
    );
    assert!(valued.stderr.is_empty(), "{}", text(&valued.stderr));

    let source = text(&valued.stdout);
    assert!(source.contains("\"schema\":\"re.native-project-run@0.2.0\""));
    assert!(source.contains(UNIT_VALUES), "{source}");
    assert!(!source.contains("\"returned_value\""));
    // The value evidence is inside the digest, so the same run reports a
    // different `run_digest`; what the capability did is unchanged.
    let default_source = text(&default.stdout);
    assert_ne!(
        field(&source, "run_digest"),
        field(&default_source, "run_digest"),
        "the versioned envelope must bind its own byte order"
    );
    assert_eq!(
        field(&source, "vm_receipt_digest"),
        field(&default_source, "vm_receipt_digest")
    );

    for (label, envelope) in [("default", default_source), ("valued", source)] {
        let path = root.join(format!("{label}.json"));
        fs::write(&path, envelope).unwrap();
        let verified = run(&["project-run-verify", path.to_str().unwrap()]);
        assert!(
            verified.status.success(),
            "{label} envelope did not verify: {}",
            text(&verified.stderr)
        );
        assert!(text(&verified.stdout).contains("\"ok\":true"), "{label}");
        assert!(
            text(&verified.stdout).contains("re.native-project-run-verification@0.1.0"),
            "{label}"
        );
    }

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_project_receipt_covers_both_envelopes() {
    let root = temp_root("receipt");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success(),
        "project-init failed"
    );
    let cache = root.join("cache");
    let build = root.join("build");
    let default_run = root.join("default.json");
    let default_receipt = root.join("default-receipt.json");
    let produced = run(&[
        "project-run",
        "--project-receipt",
        default_receipt.to_str().unwrap(),
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        MODULE,
        INPUT,
    ]);
    assert!(
        produced.status.success(),
        "stdout={} stderr={}",
        text(&produced.stdout),
        text(&produced.stderr)
    );
    fs::write(&default_run, &produced.stdout).unwrap();

    let valued_run = root.join("valued.json");
    let valued_receipt = root.join("valued-receipt.json");
    let produced = run(&[
        "project-run",
        "--project-receipt",
        valued_receipt.to_str().unwrap(),
        "--print-values",
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        MODULE,
        INPUT,
    ]);
    assert!(
        produced.status.success(),
        "stdout={} stderr={}",
        text(&produced.stdout),
        text(&produced.stderr)
    );
    fs::write(&valued_run, &produced.stdout).unwrap();

    for (receipt, run_file) in [
        (&default_receipt, &default_run),
        (&valued_receipt, &valued_run),
    ] {
        let verified = run(&[
            "project-run-receipt-verify",
            receipt.to_str().unwrap(),
            run_file.to_str().unwrap(),
        ]);
        assert!(
            verified.status.success(),
            "receipt did not verify: {}",
            text(&verified.stderr)
        );
        assert!(
            text(&verified.stdout).contains("re.native-project-run-receipt-verification@0.1.0")
        );
    }

    // A receipt is bound to the envelope it attested: the run digest differs
    // between the two, so the pairing does not cross over.
    let crossed = run(&[
        "project-run-receipt-verify",
        default_receipt.to_str().unwrap(),
        valued_run.to_str().unwrap(),
    ]);
    assert_eq!(crossed.status.code(), Some(65));
    assert!(crossed.stdout.is_empty());
    assert!(
        text(&crossed.stderr).contains("DRIFTED")
            || text(&crossed.stderr).contains("digest-mismatch"),
        "stderr={}",
        text(&crossed.stderr)
    );

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

fn project_run_with_values(project: &Path, cache: &Path, build: &Path) -> std::process::Output {
    run(&[
        "project-run",
        "--print-values",
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        MODULE,
        INPUT,
    ])
}

fn field(source: &str, name: &str) -> String {
    let prefix = format!("\"{name}\":\"");
    let start = source
        .find(&prefix)
        .unwrap_or_else(|| panic!("{name} missing: {source}"))
        + prefix.len();
    let rest = &source[start..];
    let end = rest.find('"').unwrap();
    rest[..end].to_owned()
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
