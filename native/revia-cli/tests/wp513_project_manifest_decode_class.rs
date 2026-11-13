use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn a_project_manifest_that_cannot_be_decoded_is_not_reported_as_unreadable() {
    let root = temp_root("manifest-decode");
    fs::create_dir_all(&root).unwrap();

    let corrupt = root.join("corrupt");
    let init = run(&["project-init", corrupt.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));
    fs::write(corrupt.join("project.json"), b"\xff\xfe").unwrap();

    let output = run(&["project-check", corrupt.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(65));
    let refusal = text(&output.stdout);
    assert!(
        refusal.contains(r#""code":"project-manifest-invalid-utf8""#),
        "a readable manifest with undecodable bytes was not told apart from a missing one: {refusal}",
    );

    let missing = root.join("missing");
    let init = run(&["project-init", missing.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));
    fs::remove_file(missing.join("project.json")).unwrap();

    let output = run(&["project-check", missing.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(65));
    let refusal = text(&output.stdout);
    assert!(
        refusal.contains(r#""code":"project-manifest-unreadable""#),
        "a manifest that could not be opened lost its own class: {refusal}",
    );

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
    std::env::temp_dir().join(format!("revia-wp513-{label}-{}-{counter}", process::id()))
}
