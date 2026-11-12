use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
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
    std::env::temp_dir().join(format!("revia-wp490-{nanos}-{unique}"))
}

fn run_in(directory: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap()
}

#[test]
fn node_free_gate_reports_an_unreadable_source_as_a_read_failure() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();

    let output = run_in(
        &root,
        &[
            "node-free-gate",
            "absent.re",
            "project",
            "module",
            "report.json",
        ],
    );
    assert_eq!(
        output.status.code(),
        Some(66),
        "an unreadable source is a read failure: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "a read failure leaves stderr empty"
    );
    let plain = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "\"schema\":\"re.source-diagnostic@0.1.0\"",
        "\"code\":\"input-unreadable\"",
        "\"file\":\"absent.re\"",
        "\"rule\":\"source.read\"",
    ] {
        assert!(plain.contains(expected), "missing {expected}: {plain}");
    }
    assert!(
        !plain.contains("re.native-node-free-result@0.1.0"),
        "an unreadable source is not a gate verdict: {plain}"
    );
    assert!(
        !root.join("report.json").exists(),
        "no report is written for an unreadable source"
    );

    fs::remove_dir_all(&root).unwrap();
}
