use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("revia-wp492-{}-{counter}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp root");
    root
}

fn run_in(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .current_dir(directory)
        .output()
        .expect("run revia")
}

#[test]
fn developer_gate_reports_an_unreadable_project_like_project_check() {
    let root = temp_root();
    let digest = format!("sha256:{}", "a".repeat(64));
    let gate = run_in(
        &root,
        &[
            "developer-gate",
            "absent",
            "revia.app.main",
            digest.as_str(),
            "report.json",
        ],
    );
    assert_eq!(gate.status.code(), Some(65));
    assert!(
        gate.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&gate.stderr)
    );
    let plain = String::from_utf8_lossy(&gate.stdout);
    assert!(
        plain.contains("\"schema\":\"re.native-project-result@0.1.0\""),
        "{plain}"
    );
    assert!(
        plain.contains("\"code\":\"project-root-unreadable\""),
        "{plain}"
    );
    assert!(plain.contains("\"ok\":false"), "{plain}");

    let check = run_in(&root, &["project-check", "absent"]);
    assert_eq!(check.status.code(), Some(65));
    assert_eq!(gate.stdout, check.stdout);
    assert!(!root.join("report.json").exists(), "report was written");
    assert_eq!(fs::read_dir(&root).expect("root").count(), 0);
    fs::remove_dir_all(&root).expect("remove root");
}
