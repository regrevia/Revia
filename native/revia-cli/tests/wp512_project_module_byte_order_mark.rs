use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::digest::sha256_hex;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn a_project_module_that_starts_with_a_byte_order_mark_is_refused_by_every_gate() {
    let root = temp_root("bom-module");
    let project = root.join("project");
    fs::create_dir_all(&root).unwrap();

    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let module = project.join("modules").join("main.re");
    let before = fs::read(&module).unwrap();
    let old_digest = sha256_hex(&before);
    let after = b"\xef\xbb\xbfre 0.1 canonical\n";
    fs::write(&module, after).unwrap();

    let manifest = project.join("project.json");
    let source = fs::read_to_string(&manifest).unwrap();
    assert_eq!(source.matches(&old_digest).count(), 2);
    fs::write(&manifest, source.replace(&old_digest, &sha256_hex(after))).unwrap();

    for command in ["project-check", "project-test"] {
        let output = run(&[command, project.to_str().unwrap()]);
        assert_eq!(
            output.status.code(),
            Some(65),
            "{command} admitted a module with a byte-order mark: {}",
            text(&output.stdout),
        );
        assert!(
            text(&output.stdout).contains(r#""code":"byte-order-mark-not-allowed""#),
            "{command} refused for another reason: {}",
            text(&output.stdout),
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
    std::env::temp_dir().join(format!("revia-wp512-{label}-{}-{counter}", process::id()))
}
