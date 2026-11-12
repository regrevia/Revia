use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn output_may_not_name_the_source_through_a_relative_alias() {
    let root = temp_root();
    let source = root.join("hello.re");
    fs::create_dir_all(&root).unwrap();

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
        fs::write(&source, SOURCE).unwrap();
        for (relative, absolute) in [
            ("hello.re", source.clone()),
            ("./hello.re", source.clone()),
            ("sub/../hello.re", source.clone()),
        ] {
            if relative.starts_with("sub/") {
                fs::create_dir_all(root.join("sub")).unwrap();
            }
            let output = run(&root, command, relative, &absolute);
            assert_eq!(output.status.code(), Some(65), "{command} {relative} exit");
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
                "{command} {relative} envelope",
            );
            assert!(other.is_empty(), "{command} {relative} other stream");
            assert_eq!(
                fs::read(&source).unwrap(),
                SOURCE.as_bytes(),
                "{command} {relative} source",
            );
        }
    }

    let sibling = root.join("out.bin");
    for command in ["compile", "runtime-package"] {
        fs::write(&source, SOURCE).unwrap();
        let output = run(&root, command, "hello.re", &sibling);
        assert_eq!(output.status.code(), Some(0), "{command} control exit");
        assert_eq!(fs::read(&source).unwrap(), SOURCE.as_bytes(), "{command}");
        assert!(sibling.exists(), "{command} control output");
        fs::remove_file(&sibling).unwrap();
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
    std::env::temp_dir().join(format!("revia-wp502-{}-{counter}", process::id()))
}
