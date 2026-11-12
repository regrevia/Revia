use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Every command that decodes a source file refuses a byte-order mark at the
/// same point, but only `check` reported where that point was: `canonical`,
/// `translate` and `compile` kept the code and dropped the rest of the
/// diagnostic, so the caller learned that the source was refused without
/// learning that the offending byte was the first one. The position is part
/// of the refusal, so each of them is asserted to carry the same offsets the
/// `check` stage reports for the same file.
#[test]
fn a_graph_refusal_keeps_the_position_of_the_byte_that_could_not_decode() {
    let root = temp_root("graph-diagnostic");
    fs::create_dir_all(&root).unwrap();

    let bom = root.join("bom.re");
    fs::write(&bom, b"\xef\xbb\xbfre 0.1 canonical\n").unwrap();
    let bom_path = bom.to_str().unwrap();
    let artifact = root.join("out.bin");

    for arguments in [
        vec!["canonical", bom_path],
        vec!["translate", bom_path],
        vec!["compile", bom_path, artifact.to_str().unwrap()],
    ] {
        let output = run(&arguments);
        assert_eq!(
            output.status.code(),
            Some(65),
            "{}: {}",
            arguments[0],
            text(&output.stdout)
        );
        let stdout = text(&output.stdout);
        assert!(
            stdout.contains("\"schema\":\"re.native-graph-result@0.1.0\""),
            "{}: {stdout}",
            arguments[0]
        );
        assert!(
            stdout.contains("\"code\":\"byte-order-mark-not-allowed\""),
            "{}: {stdout}",
            arguments[0]
        );
        assert_position(&stdout, arguments[0], 0, 1, 1);
    }

    // The same is true of a byte that is not valid UTF-8, which sits after
    // three line breaks and so cannot be described by the first byte alone.
    let late = root.join("late.re");
    fs::write(&late, b"re 0.1 canonical\n\n\nlet x = \"\xff\"").unwrap();
    for arguments in [
        vec!["canonical", late.to_str().unwrap()],
        vec!["translate", late.to_str().unwrap()],
    ] {
        let output = run(&arguments);
        assert_eq!(output.status.code(), Some(65), "{}", arguments[0]);
        let stdout = text(&output.stdout);
        assert!(
            stdout.contains("\"code\":\"invalid-utf8-source\""),
            "{}: {stdout}",
            arguments[0]
        );
        assert_position(&stdout, arguments[0], 28, 4, 10);
    }

    let _ = fs::remove_dir_all(&root);
}

fn assert_position(stdout: &str, command: &str, byte_start: usize, line: usize, column: usize) {
    for field in [
        format!("\"byte_start\":{byte_start}"),
        format!("\"line\":{line}"),
        format!("\"column\":{column}"),
    ] {
        assert!(
            stdout.contains(&field),
            "{command} is missing {field}: {stdout}"
        );
    }
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
        "revia-wp511-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
