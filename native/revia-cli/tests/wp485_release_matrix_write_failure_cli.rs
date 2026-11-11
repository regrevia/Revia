use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp485-{nanos}-{unique}"))
}

#[test]
fn native_release_matrix_write_failure_keeps_its_own_exit_code_and_envelope() {
    let root = temp_root();
    let matrix_path = root.join("matrix");
    fs::create_dir_all(&matrix_path).unwrap();

    // A directory at the destination makes the atomic rename fail after the
    // matrix has been serialized, so this is the write branch only.
    let write_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "release-matrix",
            "darwin-arm64",
            matrix_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(
        write_output.status.code(),
        Some(74),
        "a write failure is not the rejected-target code"
    );
    assert!(write_output.stderr.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&write_output.stdout).trim_end(),
        "{\"diagnostics\":[{\"code\":\"native-release-matrix-write-failure\"}],\
\"ok\":false,\"schema\":\"re.native-release-result@0.1.0\"}"
    );
    assert!(matrix_path.is_dir(), "the destination must stay untouched");
    let residue: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("matrix."))
        .collect();
    assert!(
        residue.is_empty(),
        "temporary files left behind: {residue:?}"
    );

    // The same command rejects an unknown target earlier, with its own code,
    // so a caller can still tell the two failure classes apart.
    let target_path = root.join("matrix.json");
    let target_output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "release-matrix",
            "not-a-target",
            target_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(target_output.status.code(), Some(65));
    assert!(target_output.stderr.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&target_output.stdout).trim_end(),
        "{\"diagnostics\":[{\"code\":\"native-release-target-invalid\"}],\
\"ok\":false,\"schema\":\"re.native-release-result@0.1.0\"}"
    );
    assert!(!target_path.exists(), "a rejected target writes no matrix");

    fs::remove_dir_all(&root).unwrap();
}
