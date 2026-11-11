use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = include_str!("../../../examples/write-check.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_compile_write_failure_keeps_its_own_exit_code_and_envelope() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("write-check.re");
    let artifact_path = root.join("artifact");
    fs::write(&source_path, SOURCE).unwrap();
    // A directory at the artifact path makes the final rename fail after the
    // artifact has already been serialized and verified.
    fs::create_dir(&artifact_path).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "compile",
            source_path.to_str().unwrap(),
            artifact_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(74), "write failure is not a 65");
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        envelope.trim_end(),
        r#"{"diagnostics":[{"code":"native-compile-write-failure"}],"ok":false,"schema":"re.native-compile-result@0.1.0"}"#
    );
    assert!(artifact_path.is_dir(), "the destination stays untouched");
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with("artifact."))
            .count(),
        0,
        "a failed compile leaves no temporary artifact"
    );

    fs::remove_dir_all(&root).unwrap();
}

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "revia-wp484-{}-{}-{}",
        std::process::id(),
        nanos,
        counter
    ))
}
