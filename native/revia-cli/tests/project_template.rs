use std::{
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const PROFILE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "revia-project-template-{}-{id}",
        std::process::id()
    ))
}

fn run(args: &[String]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn checked_in_project_template_completes_native_project_workflow() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../projects/_template")
        .canonicalize()
        .unwrap();
    let workspace = temp_root();
    let cache = workspace.join("cache");
    let build = workspace.join("build");
    let project_arg = project.to_string_lossy().into_owned();
    let cache_arg = cache.to_string_lossy().into_owned();
    let build_arg = build.to_string_lossy().into_owned();

    for args in [
        vec!["project-check".to_owned(), project_arg.clone()],
        vec!["project-test".to_owned(), project_arg.clone()],
        vec![
            "project-build".to_owned(),
            project_arg.clone(),
            cache_arg.clone(),
            build_arg.clone(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
        ],
        vec![
            "project-translate".to_owned(),
            project_arg.clone(),
            cache_arg.clone(),
            build_arg.clone(),
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            "revia.app.main".to_owned(),
        ],
        vec![
            "project-run".to_owned(),
            project_arg,
            cache_arg,
            build_arg,
            PROFILE.to_owned(),
            TOOLCHAIN.to_owned(),
            "revia.app.main".to_owned(),
            INPUT.to_owned(),
        ],
    ] {
        let output = run(&args);
        assert!(
            output.status.success(),
            "command {:?} failed:\nstdout: {}\nstderr: {}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let _ = std::fs::remove_dir_all(workspace);
}
