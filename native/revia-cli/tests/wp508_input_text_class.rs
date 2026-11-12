use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const DIGEST: &str = "sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083";

/// Every JSON input the runtime authority commands read is classified the same
/// way: bytes that were read but do not decode are a content rejection (exit
/// 65 with the `-json-invalid` code the same file produces when it is merely
/// malformed), and only a path that cannot be opened is an unreadable input
/// (exit 66 with the `-unreadable` code). Asserting both halves at each site
/// keeps the two classes from merging again in either direction.
#[test]
fn a_runtime_authority_input_that_is_not_utf8_is_a_content_rejection() {
    let root = temp_root("input-text-class");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    let pin = root.join("authority.pin");
    let sandbox = root.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    let good = fs::read(&bundle).unwrap();
    let mut bad = good.clone();
    bad[0] = 0xff;
    let bad_bundle = root.join("bad.rebundle");
    fs::write(&bad_bundle, &bad).unwrap();

    // The bundle read by `runtime-authority-pin`.
    assert_refusal(
        &run(&[
            "runtime-authority-pin",
            bad_bundle.to_str().unwrap(),
            DIGEST,
            pin.to_str().unwrap(),
        ]),
        65,
        "native-runtime-bundle-json-invalid",
        "re.native-runtime-load-authority@0.1.0",
    );
    assert_refusal(
        &run(&[
            "runtime-authority-pin",
            root.join("absent.rebundle").to_str().unwrap(),
            DIGEST,
            pin.to_str().unwrap(),
        ]),
        66,
        "native-runtime-load-authority-bundle-unreadable",
        "re.native-runtime-load-authority@0.1.0",
    );

    // A real pin, so the receipt command can get past its own pin read.
    let pinned = run(&[
        "runtime-authority-pin",
        bundle.to_str().unwrap(),
        DIGEST,
        pin.to_str().unwrap(),
    ]);
    assert!(pinned.status.success(), "{}", text(&pinned.stderr));

    let bad_pin = root.join("bad.pin");
    fs::write(&bad_pin, b"\xff\xfe\n").unwrap();
    let absent_pin = root.join("absent.pin");
    let receipt = root.join("receipt.json");
    let result = root.join("result.json");
    let program_stdout = root.join("stdout.bin");

    // The pin read by `runtime-run`.
    assert_refusal(
        &run(&[
            "runtime-run",
            "--authority-pin",
            bad_pin.to_str().unwrap(),
            bundle.to_str().unwrap(),
            DIGEST,
            sandbox.to_str().unwrap(),
        ]),
        65,
        "native-runtime-load-authority-json-invalid",
        "re.native-runtime-load-authority@0.1.0",
    );
    assert_refusal(
        &run(&[
            "runtime-run",
            "--authority-pin",
            absent_pin.to_str().unwrap(),
            bundle.to_str().unwrap(),
            DIGEST,
            sandbox.to_str().unwrap(),
        ]),
        66,
        "native-runtime-load-authority-pin-unreadable",
        "re.native-runtime-load-authority@0.1.0",
    );

    // The pin read by `runtime-receipt-verify`.
    assert_refusal(
        &run(&[
            "runtime-receipt-verify",
            bad_pin.to_str().unwrap(),
            receipt.to_str().unwrap(),
            result.to_str().unwrap(),
            program_stdout.to_str().unwrap(),
        ]),
        65,
        "native-runtime-load-authority-json-invalid",
        "re.native-runtime-load-authority@0.1.0",
    );
    assert_refusal(
        &run(&[
            "runtime-receipt-verify",
            absent_pin.to_str().unwrap(),
            receipt.to_str().unwrap(),
            result.to_str().unwrap(),
            program_stdout.to_str().unwrap(),
        ]),
        66,
        "native-runtime-load-authority-pin-unreadable",
        "re.native-runtime-load-authority@0.1.0",
    );

    // The receipt read by `runtime-receipt-verify`.
    fs::write(&receipt, b"\xff\xfe\n").unwrap();
    assert_refusal(
        &run(&[
            "runtime-receipt-verify",
            pin.to_str().unwrap(),
            receipt.to_str().unwrap(),
            result.to_str().unwrap(),
            program_stdout.to_str().unwrap(),
        ]),
        65,
        "native-runtime-load-receipt-json-invalid",
        "re.native-runtime-load-receipt@0.1.0",
    );
    assert_refusal(
        &run(&[
            "runtime-receipt-verify",
            pin.to_str().unwrap(),
            root.join("absent.receipt").to_str().unwrap(),
            result.to_str().unwrap(),
            program_stdout.to_str().unwrap(),
        ]),
        66,
        "native-runtime-load-receipt-unreadable",
        "re.native-runtime-load-receipt@0.1.0",
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
            "{{\"diagnostics\":[{{\"code\":{}}}],\"ok\":false,\"schema\":{}}}\n",
            quoted(code),
            quoted(schema)
        )
    );
}

fn quoted(value: &str) -> String {
    format!("\"{value}\"")
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
    temp_dir_join(label, std::process::id(), counter())
}

fn temp_dir_join(label: &str, process: u32, unique: u64) -> PathBuf {
    Path::new(&std::env::temp_dir()).join(format!("revia-wp508-{label}-{process}-{unique}"))
}

fn counter() -> u64 {
    TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
}
