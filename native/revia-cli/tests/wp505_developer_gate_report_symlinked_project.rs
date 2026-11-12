use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const INPUT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn report_may_not_reach_the_project_through_a_symlinked_directory() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let project = root.join("project");
    let outside = root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    assert!(
        run(&root, &["project-init", path_text(&project)])
            .status
            .success()
    );
    let link = outside.join("into");
    symlink_dir(&project, &link);

    let aliased = link.join("report.json");
    let refused = run(&root, &developer_gate(&project, &aliased));
    assert_eq!(refused.status.code(), Some(65), "aliased report exit");
    assert_eq!(
        text(&refused.stderr),
        concat!(
            "{\"diagnostics\":[{\"code\":\"native-developer-gate-report-inside-",
            "project\"}],\"ok\":false,\"schema\":\"re.native-developer-gate@0.1.0\"}\n",
        ),
        "aliased report envelope",
    );
    assert!(refused.stdout.is_empty(), "aliased report stdout");
    assert!(
        !project.join("report.json").exists(),
        "project stayed clean"
    );
    assert!(!aliased.exists(), "no report through the link");

    let report = outside.join("report.json");
    let accepted = run(&root, &developer_gate(&project, &report));
    assert_eq!(accepted.status.code(), Some(0), "sibling report exit");
    assert_eq!(accepted.stdout, fs::read(&report).unwrap(), "report bytes");

    fs::remove_dir_all(&root).unwrap();
}

fn developer_gate<'a>(project: &'a Path, report: &'a Path) -> [&'a str; 5] {
    [
        "developer-gate",
        path_text(project),
        "revia.app.main",
        INPUT_DIGEST,
        path_text(report),
    ]
}

fn run(directory: &Path, arguments: &[&str]) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .current_dir(directory)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap()
}

fn path_text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn symlink_dir(original: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(original, link).unwrap();
    #[cfg(not(unix))]
    std::os::windows::fs::symlink_dir(original, link).unwrap();
}

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp505-{}-{counter}", process::id()))
}
