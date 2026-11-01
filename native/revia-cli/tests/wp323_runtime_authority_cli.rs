use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn runtime_run_authority_pin_blocks_loaded_bundle_drift_before_effect() {
    let root = temp_root("drift");
    let source = root.join("write.re");
    let bundle = root.join("runtime.rebundle");
    let pin = root.join("runtime.pin.json");
    let sandbox = root.join("sandbox");
    let target = sandbox.join("output.txt");
    let clean_sandbox = root.join("clean-sandbox");
    let clean_target = clean_sandbox.join("output.txt");
    fs::create_dir_all(&sandbox).unwrap();
    fs::create_dir_all(&clean_sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/write-check.re")).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    let generated = run(&[
        "runtime-authority-pin",
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        pin.to_str().unwrap(),
    ]);
    assert!(generated.status.success(), "{}", text(&generated.stderr));
    assert_eq!(generated.stdout, fs::read(&pin).unwrap());

    let clean = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        clean_sandbox.to_str().unwrap(),
    ]);
    assert!(clean.status.success(), "{}", text(&clean.stderr));
    assert_eq!(fs::read(clean_target).unwrap(), b"\x41\x00\x42");

    let original_bundle = fs::read(&bundle).unwrap();
    let mut bundle_bytes = original_bundle.clone();
    let index = bundle_bytes
        .iter()
        .position(|byte| *byte == b'0')
        .expect("bundle contains a digest zero");
    bundle_bytes[index] = b'1';
    fs::write(&bundle, bundle_bytes).unwrap();

    let rejected = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        sandbox.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(text(&rejected.stderr).contains("DRIFTED"));
    assert!(!target.exists());

    fs::write(&bundle, original_bundle).unwrap();
    let input_drift_sandbox = root.join("input-drift-sandbox");
    fs::create_dir_all(&input_drift_sandbox).unwrap();
    let input_drift = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        bundle.to_str().unwrap(),
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        input_drift_sandbox.to_str().unwrap(),
    ]);
    assert_eq!(input_drift.status.code(), Some(65));
    assert!(input_drift.stdout.is_empty());
    assert!(text(&input_drift.stderr).contains("DRIFTED"));
    assert!(!input_drift_sandbox.join("output.txt").exists());

    let malformed_pin = root.join("malformed.pin.json");
    fs::write(&malformed_pin, b"{}").unwrap();
    let malformed_sandbox = root.join("malformed-sandbox");
    fs::create_dir_all(&malformed_sandbox).unwrap();
    let malformed = run(&[
        "runtime-run",
        "--authority-pin",
        malformed_pin.to_str().unwrap(),
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        malformed_sandbox.to_str().unwrap(),
    ]);
    assert_eq!(malformed.status.code(), Some(65));
    assert!(malformed.stdout.is_empty());
    assert!(text(&malformed.stderr).contains("native-runtime-load-authority"));
    assert!(!malformed_sandbox.join("output.txt").exists());

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
        "revia-wp323-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
