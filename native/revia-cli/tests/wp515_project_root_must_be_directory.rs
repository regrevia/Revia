use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn a_project_root_that_is_a_file_is_not_reported_as_a_missing_manifest() {
    let root = temp_root("root-file");
    fs::create_dir_all(&root).unwrap();
    let not_a_directory = root.join("revia");
    fs::write(&not_a_directory, b"").unwrap();

    for command in ["project-check", "project-test", "project-surface-check"] {
        let output = run(&[command, not_a_directory.to_str().unwrap()]);
        assert_eq!(
            output.status.code(),
            Some(65),
            "{command} accepted a regular file as a project root",
        );
        let refusal = text(&output.stdout);
        assert!(
            refusal.contains(r#""code":"project-root-not-a-directory""#),
            "{command} blamed the manifest for a root that is a file: {refusal}",
        );
    }

    fs::remove_dir_all(root).unwrap();
}

fn run(arguments: &[&str]) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp515-{label}-{}-{counter}", process::id()))
}
