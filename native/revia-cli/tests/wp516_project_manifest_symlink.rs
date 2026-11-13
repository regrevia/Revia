use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn a_project_manifest_reached_through_a_symlink_is_refused() {
    let root = temp_root("manifest-symlink");
    fs::create_dir_all(&root).unwrap();
    let project = root.join("project");
    let init = run(&["project-init", project.to_str().unwrap()]);
    assert!(init.status.success(), "{}", text(&init.stderr));

    let manifest = project.join("project.json");
    let elsewhere = root.join("manifest-copy.json");
    fs::rename(&manifest, &elsewhere).unwrap();
    link_file(&elsewhere, &manifest);

    for command in ["project-check", "project-test", "project-surface-check"] {
        let output = run(&[command, project.to_str().unwrap()]);
        assert_eq!(
            output.status.code(),
            Some(65),
            "{command} followed a manifest symlink pointing outside the project",
        );
        let refusal = text(&output.stdout);
        assert!(
            refusal.contains(r#""code":"project-manifest-symlink-not-allowed""#),
            "{command} accepted a symlinked manifest: {refusal}",
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

fn link_file(original: &std::path::Path, link: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(original, link).unwrap();
    #[cfg(not(unix))]
    std::os::windows::fs::symlink_file(original, link).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp516-{label}-{}-{counter}", process::id()))
}
