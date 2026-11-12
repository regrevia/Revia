use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A native project run and the receipt that describes it are read as text,
/// so the two ways that read can fail are kept apart: bytes that were read but
/// do not decode are a content rejection at exit 65 with the code the same
/// file already produced when it was merely malformed, and only a path that
/// cannot be opened is an unreadable input at exit 66. Each site is asserted
/// both ways so the classes cannot merge in either direction.
#[test]
fn a_project_run_input_that_is_not_utf8_is_a_content_rejection() {
    let root = temp_root("input-text-class");
    fs::create_dir_all(&root).unwrap();

    let bad = root.join("bad.json");
    fs::write(&bad, b"\xff\xfe\n").unwrap();
    let junk = root.join("junk.json");
    fs::write(&junk, b"not json\n").unwrap();
    let absent = root.join("absent.json");

    // `project-run-verify`.
    assert_refusal(
        &run(&["project-run-verify", bad.to_str().unwrap()]),
        65,
        "project-manifest-json-invalid",
        "re.native-project-runtime-result@0.1.0",
    );
    assert_refusal(
        &run(&["project-run-verify", absent.to_str().unwrap()]),
        66,
        "native-project-run-unreadable",
        "re.native-project-runtime-result@0.1.0",
    );

    // `project-run-receipt-verify` reads the receipt first.
    assert_refusal(
        &run(&[
            "project-run-receipt-verify",
            bad.to_str().unwrap(),
            junk.to_str().unwrap(),
        ]),
        65,
        "project-manifest-json-invalid",
        "re.native-project-run-receipt-verification@0.1.0",
    );
    assert_refusal(
        &run(&[
            "project-run-receipt-verify",
            absent.to_str().unwrap(),
            junk.to_str().unwrap(),
        ]),
        66,
        "native-project-run-receipt-unreadable",
        "re.native-project-run-receipt-verification@0.1.0",
    );

    // ...and then the run itself, which is a separate read.
    assert_refusal(
        &run(&[
            "project-run-receipt-verify",
            junk.to_str().unwrap(),
            bad.to_str().unwrap(),
        ]),
        65,
        "project-manifest-json-invalid",
        "re.native-project-run-receipt-verification@0.1.0",
    );
    assert_refusal(
        &run(&[
            "project-run-receipt-verify",
            junk.to_str().unwrap(),
            absent.to_str().unwrap(),
        ]),
        66,
        "native-project-run-unreadable",
        "re.native-project-run-receipt-verification@0.1.0",
    );

    let _ = fs::remove_dir_all(&root);
}

fn assert_refusal(output: &std::process::Output, status: i32, code: &str, schema: &str) {
    assert_eq!(
        output.status.code(),
        Some(status),
        "{}",
        text(&output.stderr)
    );
    assert!(output.stdout.is_empty(), "{}", text(&output.stdout));
    assert_eq!(
        text(&output.stderr),
        format!(
            "{{\"diagnostics\":[{{\"code\":\"{code}\"}}],\"ok\":false,\"schema\":\"{schema}\"}}\n"
        )
    );
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
    Path::new(&std::env::temp_dir()).join(format!(
        "revia-wp509-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
