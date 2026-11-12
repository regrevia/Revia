use std::{
    fs,
    path::PathBuf,
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn server_gate_refuses_project_output_before_resolving_sqlite() {
    let root = temp_root();
    let project = root.join("project");
    let plan = root.join("plan.json");
    let database = project.join("gate.db");
    let report = project.join("gate.json");
    fs::create_dir_all(&project).unwrap();
    fs::write(&plan, b"{}\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "project-server-gate",
            project.to_str().unwrap(),
            plan.to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
            INPUT,
            root.join("missing-sqlite3").to_str().unwrap(),
            database.to_str().unwrap(),
            report.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();

    assert_eq!(
        output.status.code(),
        Some(65),
        "stdout={} stderr={}",
        text(&output.stdout),
        text(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-project-server-gate-"#,
            r#"output-inside-project"}],"ok":false,"#,
            r#""schema":"re.native-project-server-gate@0.2.0"}"#,
        )
    );
    assert!(!database.exists());
    assert!(!report.exists());

    fs::remove_dir_all(root).unwrap();
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root() -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp500-{}-{counter}", process::id()))
}
