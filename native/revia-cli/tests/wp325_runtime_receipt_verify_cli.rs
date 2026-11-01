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
fn runtime_receipt_verify_replays_result_and_stdout_authority() {
    let root = temp_root("verify");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    let pin = root.join("runtime.pin.json");
    let receipt = root.join("runtime.receipt.json");
    let result = root.join("runtime.result.json");
    let stdout = root.join("runtime.stdout");
    let sandbox = root.join("sandbox");
    fs::create_dir_all(&sandbox).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

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
    fs::write(&result, &executed.stdout).unwrap();
    fs::write(&stdout, b"Hello, World!\n").unwrap();

    let verified = run(&[
        "runtime-receipt-verify",
        pin.to_str().unwrap(),
        receipt.to_str().unwrap(),
        result.to_str().unwrap(),
        stdout.to_str().unwrap(),
    ]);
    assert!(verified.status.success(), "{}", text(&verified.stderr));
    assert!(text(&verified.stdout).contains("re.native-runtime-load-receipt-verification@0.1.0"));
    assert_eq!(
        verified.stdout,
        run(&[
            "runtime-receipt-verify",
            pin.to_str().unwrap(),
            receipt.to_str().unwrap(),
            result.to_str().unwrap(),
            stdout.to_str().unwrap(),
        ])
        .stdout
    );

    let mut changed = fs::read(&result).unwrap();
    let index = changed.iter().position(|byte| *byte == b'0').unwrap();
    changed[index] = b'1';
    fs::write(&result, changed).unwrap();
    let rejected = run(&[
        "runtime-receipt-verify",
        pin.to_str().unwrap(),
        receipt.to_str().unwrap(),
        result.to_str().unwrap(),
        stdout.to_str().unwrap(),
    ]);
    assert_eq!(rejected.status.code(), Some(65));
    assert!(rejected.stdout.is_empty());
    assert!(text(&rejected.stderr).contains("DRIFTED"));

    let missing_result = root.join("missing-result.json");
    let unreadable = run(&[
        "runtime-receipt-verify",
        pin.to_str().unwrap(),
        receipt.to_str().unwrap(),
        missing_result.to_str().unwrap(),
        stdout.to_str().unwrap(),
    ]);
    assert_eq!(unreadable.status.code(), Some(66));
    assert!(unreadable.stdout.is_empty());
    assert!(!text(&unreadable.stderr).contains(missing_result.to_str().unwrap()));

    let mut unknown_pin = fs::read_to_string(&pin).unwrap();
    unknown_pin.insert(unknown_pin.len() - 1, ',');
    unknown_pin.insert(unknown_pin.len() - 1, '"');
    unknown_pin.insert(unknown_pin.len() - 1, 'x');
    unknown_pin.insert(unknown_pin.len() - 1, '"');
    unknown_pin.insert(unknown_pin.len() - 1, ':');
    unknown_pin.insert(unknown_pin.len() - 1, '"');
    unknown_pin.insert(unknown_pin.len() - 1, '1');
    unknown_pin.insert(unknown_pin.len() - 1, '"');
    let unknown_pin_path = root.join("unknown.pin.json");
    fs::write(&unknown_pin_path, unknown_pin).unwrap();
    let unknown = run(&[
        "runtime-receipt-verify",
        unknown_pin_path.to_str().unwrap(),
        receipt.to_str().unwrap(),
        result.to_str().unwrap(),
        stdout.to_str().unwrap(),
    ]);
    assert_eq!(unknown.status.code(), Some(65));
    assert!(unknown.stdout.is_empty());

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
        "revia-wp325-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
