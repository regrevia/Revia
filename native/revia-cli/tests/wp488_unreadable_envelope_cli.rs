use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

const DIAGNOSTIC_SCHEMA: &str = "re.source-diagnostic@0.1.0";

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp488-{nanos}-{unique}"))
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .expect("native revia binary runs")
}

#[test]
fn every_source_reader_prints_the_same_bare_unreadable_diagnostic() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let missing = root.join("absent.re");
    let shown = missing.to_str().unwrap();
    let schema_field = format!("\"schema\":\"{DIAGNOSTIC_SCHEMA}\"");
    let mut diagnostics = Vec::new();

    for verb in [
        "check",
        "lex",
        "digest",
        "canonical",
        "manifest",
        "graph-check",
    ] {
        let output = run(&[verb, shown]);
        assert_eq!(
            output.status.code(),
            Some(66),
            "{verb} must report an unreadable input with exit 66"
        );
        assert!(
            output.stderr.is_empty(),
            "{verb} must leave stderr empty for an unreadable input"
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let text = stdout.trim_end_matches('\n');
        assert!(
            text.lines().count() <= 1,
            "{verb} must print one stdout line, saw {text}"
        );
        assert!(
            text.starts_with("{\"byte_end\":0,"),
            "{verb} must print a bare diagnostic object, saw {text}"
        );
        assert!(
            text.ends_with("\"severity\":\"error\"}"),
            "{verb} diagnostic must close as a diagnostic object, saw {text}"
        );
        assert!(
            !text.contains("\"ok\":") && !text.contains("\"diagnostics\":["),
            "{verb} must not wrap the diagnostic in a command envelope, saw {text}"
        );
        for field in [
            "\"code\":\"input-unreadable\"",
            "\"phase\":\"source\"",
            "\"repair\":\"inspect\"",
            "\"rule\":\"source.read\"",
            "\"severity\":\"error\"",
            "\"lexeme\":\"\"",
            "\"byte_start\":0",
            "\"line\":1",
        ] {
            assert!(
                text.contains(field),
                "{verb} diagnostic must carry {field}, saw {text}"
            );
        }
        let file_field = format!("\"file\":\"{shown}\"");
        assert!(
            text.contains(&file_field),
            "{verb} must name the path it was given, saw {text}"
        );
        assert_eq!(
            text.matches(&schema_field).count(),
            1,
            "{verb} must embed exactly one diagnostic schema tag, saw {text}"
        );
        diagnostics.push(text.to_string());
    }

    assert!(
        diagnostics.len() >= 6,
        "every source reader must be exercised, saw {}",
        diagnostics.len()
    );
    assert!(
        diagnostics.windows(2).all(|pair| pair[0] == pair[1]),
        "every source reader must print the same diagnostic: {diagnostics:?}"
    );
    let _ = fs::remove_dir_all(&root);
}
