use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The three replay catalog commands all reach their catalog through
/// `read_text_input`, so bytes that were read but do not decode were reported
/// as `input-unreadable` at exit 66 in the source-diagnostic shape, while the
/// very same file merely malformed was refused at exit 65 in a different
/// envelope. A damaged catalog is a content rejection on every command, so
/// each one is asserted both ways: the decode failure must match the shape and
/// status of the malformed-input refusal, and an absent path must stay in the
/// unreadable class.
#[test]
fn a_replay_catalog_that_is_not_utf8_is_refused_like_a_malformed_one() {
    let root = temp_root("catalog-text-class");
    fs::create_dir_all(&root).unwrap();

    let bad = root.join("bad.json");
    fs::write(&bad, b"\xff\xfe\n").unwrap();
    let junk = root.join("junk.json");
    fs::write(&junk, b"not json\n").unwrap();
    let absent = root.join("absent.json");
    let output = root.join("out.json");

    let cases: [(&str, &str, &str, &str); 3] = [
        (
            "replay-catalog",
            "replay-workload-catalog-json-invalid",
            "re.native-replay-workload-report@0.1.0",
            "input-unreadable",
        ),
        (
            "replay-fault-catalog",
            "replay-fault-catalog-json-invalid",
            "re.native-replay-fault-report@0.1.0",
            "input-unreadable",
        ),
        (
            "replay-fault-corpus",
            "native-fault-corpus-json-invalid",
            "re.native-fault-observation-report@0.1.0",
            "input-unreadable",
        ),
    ];

    for (command, invalid_code, schema, unreadable_code) in cases.iter() {
        let out = output.to_str().unwrap();
        assert_diagnostics(
            &run(&[command, bad.to_str().unwrap(), out]),
            65,
            invalid_code,
            schema,
        );
        assert_diagnostics(
            &run(&[command, junk.to_str().unwrap(), out]),
            65,
            invalid_code,
            schema,
        );
        let missing = run(&[command, absent.to_str().unwrap(), out]);
        assert_eq!(missing.status.code(), Some(66), "{command}");
        assert!(missing.stderr.is_empty(), "{command}");
        assert!(
            text(&missing.stdout).contains(&format!("\"code\":\"{unreadable_code}\"")),
            "{command}: {}",
            text(&missing.stdout)
        );
    }

    let _ = fs::remove_dir_all(&root);
}

fn assert_diagnostics(output: &std::process::Output, status: i32, code: &str, schema: &str) {
    assert_eq!(
        output.status.code(),
        Some(status),
        "{}",
        text(&output.stdout)
    );
    let expected = format!(
        "{{\"diagnostics\":[{{\"code\":\"{code}\"}}],\"ok\":false,\"schema\":\"{schema}\"}}\n"
    );
    assert_eq!(text(&output.stderr), expected);
    assert!(output.stdout.is_empty(), "{}", text(&output.stdout));
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
    Path::new(&std::env::temp_dir()).join(format!(
        "revia-wp510-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
