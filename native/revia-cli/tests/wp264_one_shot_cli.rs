use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = include_str!("../../../examples/hello.re");
const INPUT_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_compile_and_execute_reuse_the_existing_translation_and_run_authority() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("hello.re");
    let artifact_path = root.join("hello.rebc");
    fs::write(&source_path, SOURCE).unwrap();

    let translated = run(["translate", source_path.to_str().unwrap()]);
    assert!(translated.status.success());

    let compile = run([
        "compile",
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);
    assert!(
        compile.status.success(),
        "{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    assert_eq!(fs::read(&artifact_path).unwrap(), translated.stdout);
    assert!(String::from_utf8_lossy(&compile.stdout).contains("re.native-compile-result@0.1.0"));
    assert!(!String::from_utf8_lossy(&compile.stdout).contains(root.to_str().unwrap()));

    let staged = run([
        "run",
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
        INPUT_DIGEST,
    ]);
    assert!(staged.status.success());

    let one_shot = run(["execute", source_path.to_str().unwrap(), INPUT_DIGEST]);
    assert!(
        one_shot.status.success(),
        "{}",
        String::from_utf8_lossy(&one_shot.stderr)
    );
    assert_eq!(one_shot.stdout, staged.stdout);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_compile_write_failure_does_not_leave_partial_output() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let source_path = root.join("hello.re");
    let artifact_path = root.join("artifact");
    fs::write(&source_path, SOURCE).unwrap();
    fs::create_dir(&artifact_path).unwrap();

    let output = run([
        "compile",
        source_path.to_str().unwrap(),
        artifact_path.to_str().unwrap(),
    ]);

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("native-compile-write-failure"));
    assert!(artifact_path.is_dir());
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with("artifact."))
            .count(),
        0,
        "a failed compile must not leave its temporary artifact"
    );

    fs::remove_dir_all(root).unwrap();
}

fn run<const N: usize>(arguments: [&str; N]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp264-one-shot-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
