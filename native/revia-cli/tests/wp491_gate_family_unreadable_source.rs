use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("revia-wp491-{}-{counter}", std::process::id()));
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
fn every_gate_reports_an_unreadable_source_as_a_read_failure() {
    let root = temp_root();
    let digest = format!("sha256:{}", "a".repeat(64));
    let gates: Vec<Vec<&str>> = vec![
        vec![
            "node-free-gate",
            "absent.re",
            "project",
            "module",
            "report.json",
        ],
        vec![
            "toolchain-gate",
            "absent.re",
            "project",
            "module",
            digest.as_str(),
            "report.json",
        ],
        vec![
            "release-evidence-gate",
            "absent.re",
            "project",
            "module",
            "corpus.json",
            "evidence.json",
        ],
    ];
    let mut expected: Option<Vec<u8>> = None;
    for args in &gates {
        let output = run_in(&root, args);
        assert_eq!(output.status.code(), Some(66), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
        let plain = String::from_utf8_lossy(&output.stdout);
        assert!(
            plain.contains("\"schema\":\"re.source-diagnostic@0.1.0\""),
            "{args:?}: {plain}"
        );
        assert!(
            plain.contains("\"code\":\"input-unreadable\""),
            "{args:?}: {plain}"
        );
        assert!(
            plain.contains("\"file\":\"absent.re\""),
            "{args:?}: {plain}"
        );
        assert!(
            plain.contains("\"rule\":\"source.read\""),
            "{args:?}: {plain}"
        );
        assert!(!plain.contains("\"ok\":"), "{args:?}: {plain}");
        match &expected {
            None => expected = Some(output.stdout.clone()),
            Some(first) => assert_eq!(&output.stdout, first, "{args:?}"),
        }
    }
    for name in ["report.json", "evidence.json"] {
        assert!(!root.join(name).exists(), "{name} was written");
    }
    assert_eq!(fs::read_dir(&root).expect("root").count(), 0);
    fs::remove_dir_all(&root).expect("remove root");
}
