use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn a_project_manifest_with_a_byte_order_mark_is_not_called_malformed_json() {
    let root = temp_root("manifest-bom");
    fs::create_dir_all(&root).unwrap();
    let project = root.join("project");
    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let manifest = project.join("project.json");
    let mut bytes = b"\xef\xbb\xbf".to_vec();
    bytes.extend(fs::read(&manifest).unwrap());
    fs::write(&manifest, &bytes).unwrap();

    for command in ["project-check", "project-test", "project-surface-check"] {
        let output = run(&[command, project.to_str().unwrap()]);
        assert_eq!(
            output.status.code(),
            Some(65),
            "{command} admitted a manifest with a byte-order mark"
        );
        let refusal = text(&output.stdout);
        assert!(
            refusal.contains(r#""code":"byte-order-mark-not-allowed""#),
            "{command} blamed the JSON for a byte-order mark: {refusal}",
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
    std::env::temp_dir().join(format!("revia-wp514-{label}-{}-{counter}", process::id()))
}
