//! A source diagnostic for undecodable bytes must point at those bytes.
//!
//! `re.source-diagnostic@0.1.0` carries one-based `line`/`column` beside the
//! zero-based `byte_start`, and the Node reference decoder derives both from
//! the bytes before the offending one. The native path reported the file start
//! for every file, so a bad byte on line 4 still read `"line":1,"column":1`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()
        .expect("revia runs")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("output is utf-8")
}

fn temp_root(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "revia-wp507-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp root");
    root
}

/// Assert the printed diagnostic places the failure at one position.
fn assert_position(stdout: &str, byte_start: usize, line: usize, column: usize) {
    for field in [
        format!("\"byte_start\":{byte_start}"),
        format!("\"line\":{line}"),
        format!("\"column\":{column}"),
        format!("\"end_line\":{line}"),
        format!("\"end_column\":{}", column + 1),
    ] {
        assert!(
            stdout.contains(&field),
            "diagnostic should carry {field}, got {stdout}"
        );
    }
}

#[test]
fn a_source_diagnostic_points_at_the_byte_before_it_failed_to_decode() {
    let root = temp_root("position");

    // A byte-order mark is refused at offset 0, which is line 1, column 1.
    let bom = root.join("bom.re");
    fs::write(&bom, b"\xef\xbb\xbfre 0.1 canonical\n").expect("write bom");
    let bom_out = run(&["check", bom.to_str().expect("bom path")]);
    assert_eq!(bom_out.status.code(), Some(65), "{}", text(&bom_out.stderr));
    let bom_stdout = text(&bom_out.stdout);
    assert!(bom_stdout.contains("\"code\":\"byte-order-mark-not-allowed\""));
    assert_position(&bom_stdout, 0, 1, 1);

    // Three line breaks precede the bad byte, so it sits on line 4.
    let late = root.join("late.re");
    fs::write(&late, b"re 0.1 canonical\n\n\nlet x = \"\xff\"").expect("write late");
    let late_out = run(&["check", late.to_str().expect("late path")]);
    assert_eq!(
        late_out.status.code(),
        Some(65),
        "{}",
        text(&late_out.stderr)
    );
    let late_stdout = text(&late_out.stdout);
    assert!(late_stdout.contains("\"code\":\"invalid-utf8-source\""));
    assert_position(&late_stdout, 28, 4, 10);

    // Columns count Unicode scalars, not bytes: the three bytes of U+4E2D are
    // one column, so the bad byte is column 12 and not column 14.
    let wide = root.join("wide.re");
    let mut wide_bytes = "re 0.1 canonical\nlet greeting = \"\u{4e2d}\"\nlet bad = \""
        .to_owned()
        .into_bytes();
    assert_eq!(wide_bytes.len(), 49);
    wide_bytes.push(0xff);
    wide_bytes.extend_from_slice(b"\"");
    fs::write(&wide, &wide_bytes).expect("write wide");
    let wide_out = run(&["check", wide.to_str().expect("wide path")]);
    assert_eq!(
        wide_out.status.code(),
        Some(65),
        "{}",
        text(&wide_out.stderr)
    );
    let wide_stdout = text(&wide_out.stdout);
    assert!(wide_stdout.contains("\"code\":\"invalid-utf8-source\""));
    assert_position(&wide_stdout, 49, 3, 12);

    let _ = fs::remove_dir_all(&root);
}
