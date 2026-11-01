use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::project_receipt::{
    build_project_run_receipt, parse_project_run_receipt, serialize_project_run_receipt,
};

const PROFILE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn project_run_receipt_verify_rejects_run_drift_without_execution() {
    let root = temp_root("verify");
    let project = root.join("project");
    assert!(
        run(&["project-init", project.to_str().unwrap()])
            .status
            .success()
    );
    let cache = root.join("cache");
    let build = root.join("build");
    let run_file = root.join("run.json");
    let receipt = root.join("receipt.json");
    let output = run(&[
        "project-run",
        "--project-receipt",
        receipt.to_str().unwrap(),
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        "revia.app.main",
        INPUT,
    ]);
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        text(&output.stdout),
        text(&output.stderr)
    );
    fs::write(&run_file, &output.stdout).unwrap();

    let verified = run(&[
        "project-run-receipt-verify",
        receipt.to_str().unwrap(),
        run_file.to_str().unwrap(),
    ]);
    assert!(verified.status.success(), "{}", text(&verified.stderr));
    assert!(text(&verified.stdout).contains("re.native-project-run-receipt-verification@0.1.0"));

    let mut tampered = output.stdout;
    let index = tampered.iter().position(|byte| *byte == b'0').unwrap();
    tampered[index] = b'1';
    fs::write(&run_file, tampered).unwrap();
    let rejected = run(&[
        "project-run-receipt-verify",
        receipt.to_str().unwrap(),
        run_file.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(
        text(&rejected.stderr).contains("native-project-run-digest-mismatch")
            || text(&rejected.stderr).contains("DRIFTED")
    );

    let run_source = String::from_utf8(
        run(&[
            "project-run",
            project.to_str().unwrap(),
            cache.to_str().unwrap(),
            build.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            "revia.app.main",
            INPUT,
        ])
        .stdout,
    )
    .unwrap();
    let original_receipt =
        parse_project_run_receipt(&fs::read_to_string(&receipt).unwrap()).unwrap();
    let mismatched_receipt = build_project_run_receipt(
        &original_receipt.project_digest,
        &original_receipt.graph_revision,
        "wrong.module",
        &original_receipt.input_digest,
        &original_receipt.translation_digest,
        &original_receipt.vm_receipt_digest,
        &original_receipt.run_digest,
    );
    fs::write(
        &receipt,
        serialize_project_run_receipt(&mismatched_receipt).unwrap(),
    )
    .unwrap();
    fs::write(&run_file, run_source).unwrap();
    let authority_rejected = run(&[
        "project-run-receipt-verify",
        receipt.to_str().unwrap(),
        run_file.to_str().unwrap(),
    ]);
    assert_eq!(authority_rejected.status.code(), Some(65));
    assert!(authority_rejected.stdout.is_empty());

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp333-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
