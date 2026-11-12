use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn output_may_not_reach_the_source_through_a_hard_link() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let real = root.join("real.re");
    let link = root.join("link.re");

    #[cfg(unix)]
    for (command, code, schema, to_stderr) in [
        (
            "compile",
            "native-compile-output-overwrites-source",
            "re.native-compile-result@0.1.0",
            false,
        ),
        (
            "runtime-package",
            "native-runtime-bundle-output-overwrites-source",
            "re.native-runtime-bundle@0.1.0",
            true,
        ),
    ] {
        fs::write(&real, SOURCE).unwrap();
        let _ = fs::remove_file(&link);
        fs::hard_link(&real, &link).unwrap();

        let output = run(&root, command, "link.re", &real);
        assert_eq!(output.status.code(), Some(65), "{command} hard link exit");
        let envelope = format!(
            concat!(
                "{{\"diagnostics\":[{{\"code\":\"{}\"}}],\"ok\":false,",
                "\"schema\":\"{}\"}}\n",
            ),
            code, schema,
        );
        let (refusal, other) = if to_stderr {
            (&output.stderr, &output.stdout)
        } else {
            (&output.stdout, &output.stderr)
        };
        assert_eq!(
            String::from_utf8_lossy(refusal),
            envelope,
            "{command} envelope",
        );
        assert!(other.is_empty(), "{command} other stream");
        assert_eq!(
            fs::read(&real).unwrap(),
            SOURCE.as_bytes(),
            "{command} source",
        );
        assert_eq!(
            fs::read(&link).unwrap(),
            SOURCE.as_bytes(),
            "{command} link kept its bytes",
        );
    }

    let control = root.join("out.bin");
    for command in ["compile", "runtime-package"] {
        fs::write(&real, SOURCE).unwrap();
        let _ = fs::remove_file(&link);
        fs::hard_link(&real, &link).unwrap();
        let sibling = root.join("sibling.re");
        fs::copy(&real, &sibling).unwrap();
        let output = run(&root, command, "sibling.re", &control);
        assert_eq!(output.status.code(), Some(0), "{command} control exit");
        assert!(control.exists(), "{command} control output");
        let _ = fs::remove_file(&control);
        let _ = fs::remove_file(&sibling);
    }
}

fn run(directory: &Path, command: &str, source: &str, output: &Path) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([command, source, output.to_str().unwrap()])
        .current_dir(directory)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp504-{}-{counter}", process::id()))
}
