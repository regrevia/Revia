use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const CORPUS: &str = include_str!("../../../test/fixtures/native-fault-corpus.json");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_fault_corpus_release_gate_rejects_debug_binary_before_execution() {
    let root = temp_root("debug");
    fs::create_dir_all(&root).unwrap();
    let corpus_path = root.join("corpus.json");
    let evidence_path = root.join("evidence.json");
    fs::write(&corpus_path, CORPUS).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "replay-fault-corpus-gate",
            corpus_path.to_str().unwrap(),
            evidence_path.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!evidence_path.exists());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("native-fault-corpus-release-binary-required")
    );
    remove_dir_all_retrying(&root);
}

#[test]
fn native_fault_corpus_release_gate_accepts_relative_corpus_path() {
    let root = temp_root("relative");
    let release_dir = root.join("release");
    fs::create_dir_all(&release_dir).unwrap();
    let release_binary = release_dir.join("revia");
    fs::copy(env!("CARGO_BIN_EXE_revia"), &release_binary).unwrap();
    let evidence_path = root.join("evidence.json");
    fs::write(root.join("corpus.json"), CORPUS).unwrap();

    let output = Command::new(&release_binary)
        .current_dir(&root)
        .args([
            "replay-fault-corpus-gate",
            "corpus.json",
            evidence_path.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let evidence = read_release_evidence(&evidence_path);
    assert_eq!(output.stdout, evidence);
    let source = String::from_utf8(evidence).unwrap();
    assert!(source.contains("re.native-fault-corpus-release-evidence@0.1.0"));
    assert!(source.contains("\"release_build\":true"));
    assert!(source.contains("\"empty_path\":true"));
    assert!(source.contains("\"node_process_count\":0"));
    assert!(!source.contains(root.to_str().unwrap()));
    remove_dir_all_retrying(&root);
}

fn remove_dir_all_retrying(path: &std::path::Path) {
    // Windows keeps the copied release binary locked for a moment after the
    // process exits, so the cleanup retries the same way the read does.
    let mut last = None;
    for _ in 0..40 {
        match fs::remove_dir_all(path) {
            Ok(()) => return,
            Err(error) => {
                last = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    panic!("could not remove {}: {:?}", path.display(), last);
}

fn read_release_evidence(path: &std::path::Path) -> Vec<u8> {
    // On Windows the release binary's rename into place can leave the file
    // briefly locked by the system scanner, so retry before failing.
    let mut last = None;
    for _ in 0..40 {
        match fs::read(path) {
            Ok(bytes) => return bytes,
            Err(error) => {
                last = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    panic!("evidence unreadable at {:?}: {}", path, last.unwrap());
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp277-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
