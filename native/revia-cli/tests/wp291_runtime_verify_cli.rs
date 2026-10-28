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
fn runtime_verify_checks_a_bundle_without_running_program_effects() {
    let root = temp_root("success");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();

    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success(), "{}", text(&packaged.stderr));

    let verified = run(&["runtime-verify", bundle.to_str().unwrap()]);
    assert!(verified.status.success(), "{}", text(&verified.stderr));
    assert_eq!(
        verified.stdout,
        run(&["runtime-verify", bundle.to_str().unwrap()]).stdout
    );
    let output = text(&verified.stdout);
    assert!(output.contains("re.native-runtime-bundle-verification@0.1.0"));
    assert!(output.contains("\"ok\":true"));
    assert!(output.contains("\"bundle_digest\":\"sha256:"));
    assert!(!output.contains(root.to_str().unwrap()));
    assert!(!output.contains("Hello, World!"));
    assert!(!root.join("sandbox").exists());

    let _ = INPUT_DIGEST;
}

#[test]
fn runtime_verify_rejects_bundle_drift_before_output() {
    let root = temp_root("drift");
    let source = root.join("hello.re");
    let bundle = root.join("runtime.rebundle");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source, include_str!("../../../examples/hello.re")).unwrap();
    let packaged = run(&[
        "runtime-package",
        source.to_str().unwrap(),
        bundle.to_str().unwrap(),
    ]);
    assert!(packaged.status.success());
    let mut bytes = fs::read(&bundle).unwrap();
    bytes.reverse();
    fs::write(&bundle, bytes).unwrap();

    let verified = run(&["runtime-verify", bundle.to_str().unwrap()]);
    assert_eq!(verified.status.code(), Some(65));
    assert!(verified.stdout.is_empty());
    assert!(text(&verified.stderr).contains("native-runtime-bundle"));
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
        "revia-wp291-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
