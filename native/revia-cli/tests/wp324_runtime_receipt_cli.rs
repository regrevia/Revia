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
fn runtime_run_writes_result_bound_authority_receipt() {
    let root = temp_root("receipt");
    let source = root.join("write.re");
    let bundle = root.join("runtime.rebundle");
    let pin = root.join("runtime.pin.json");
    let receipt = root.join("runtime.receipt.json");
    let sandbox = root.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/write-check.re")).unwrap();

    assert!(
        run(&[
            "runtime-package",
            source.to_str().unwrap(),
            bundle.to_str().unwrap(),
        ])
        .status
        .success()
    );
    assert!(
        run(&[
            "runtime-authority-pin",
            bundle.to_str().unwrap(),
            INPUT_DIGEST,
            pin.to_str().unwrap(),
        ])
        .status
        .success()
    );

    let executed = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        "--authority-receipt",
        receipt.to_str().unwrap(),
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        sandbox.to_str().unwrap(),
    ]);
    assert!(executed.status.success(), "{}", text(&executed.stderr));
    let receipt_source = fs::read_to_string(&receipt).unwrap();
    assert!(receipt_source.contains("re.native-runtime-load-receipt@0.1.0"));
    assert!(receipt_source.contains("\"result_digest\":\"sha256:"));
    assert!(receipt_source.contains("\"vm_artifact_digest\":\"sha256:"));
    assert!(receipt_source.contains("\"vm_receipt_digest\":\"sha256:"));
    assert!(receipt_source.contains("\"stdout_digest\":\"sha256:"));
    assert!(fs::read(sandbox.join("output.txt")).is_ok());

    let second = run(&[
        "runtime-run",
        "--authority-pin",
        pin.to_str().unwrap(),
        "--authority-receipt",
        receipt.to_str().unwrap(),
        bundle.to_str().unwrap(),
        INPUT_DIGEST,
        sandbox.to_str().unwrap(),
    ]);
    assert_eq!(second.status.code(), Some(74));

    let original_receipt = receipt_source.clone();
    let mut tampered = receipt_source.into_bytes();
    let index = tampered
        .iter()
        .rposition(|byte| *byte == b'0')
        .expect("receipt contains a digest zero");
    tampered[index] = b'1';
    fs::write(&receipt, tampered).unwrap();
    assert_ne!(fs::read_to_string(&receipt).unwrap(), original_receipt);

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
        "revia-wp324-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
