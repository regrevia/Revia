use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn compile_and_runtime_package_refuse_output_that_is_the_source() {
    let root = temp_root();
    let source = root.join("hello.re");
    fs::create_dir_all(&root).unwrap();

    let cases = [
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
    ];

    for (command, code, schema, to_stderr) in cases {
        fs::write(&source, SOURCE).unwrap();
        let output = run(command, &source, &source);
        assert_eq!(output.status.code(), Some(65), "{command} exit");
        let (refusal, quiet) = if to_stderr {
            (&output.stderr, &output.stdout)
        } else {
            (&output.stdout, &output.stderr)
        };
        assert!(quiet.is_empty(), "{command} other stream");
        assert_eq!(
            String::from_utf8_lossy(refusal),
            format!(
                concat!(
                    "{{\"diagnostics\":[{{\"code\":\"{}\"}}],\"ok\":false,",
                    "\"schema\":\"{}\"}}\n",
                ),
                code, schema,
            ),
            "{command} refusal",
        );
        assert_eq!(fs::read(&source).unwrap(), SOURCE.as_bytes(), "{command}");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1, "{command} files");
    }

    for (command, artifact) in [
        ("compile", root.join("artifact.bin")),
        ("runtime-package", root.join("bundle.bin")),
    ] {
        fs::write(&source, SOURCE).unwrap();
        let output = run(command, &source, &artifact);
        assert_eq!(output.status.code(), Some(0), "{command} control exit");
        assert!(output.stderr.is_empty(), "{command} control stderr");
        assert!(artifact.exists(), "{command} control output");
        assert_eq!(fs::read(&source).unwrap(), SOURCE.as_bytes(), "{command}");
        fs::remove_file(&artifact).unwrap();
    }
}

fn run(command: &str, source: &Path, output: &Path) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([command, source.to_str().unwrap(), output.to_str().unwrap()])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp501-{}-{counter}", process::id()))
}
