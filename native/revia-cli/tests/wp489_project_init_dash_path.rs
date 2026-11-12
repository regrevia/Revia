use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_root() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp489-{nanos}-{unique}"))
}

fn run_in(directory: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(directory)
        .args(args)
        .output()
        .expect("native revia binary runs")
}

#[test]
fn project_init_refuses_a_directory_that_starts_with_a_dash() {
    let root = temp_root();
    fs::create_dir_all(&root).unwrap();
    let usage = "Usage: revia project-init <directory>";

    // A mistyped option looks like a directory name, and `project-init`
    // creates the directory before reading anything else. Refusing it keeps
    // an argv mistake from fabricating a tree at a path starting with '-'.
    let refused = run_in(&root, &["project-init", "--definitely-bogus-flag"]);
    assert_eq!(
        refused.status.code(),
        Some(64),
        "dash path is a usage error"
    );
    assert!(
        refused.stdout.is_empty(),
        "usage error writes nothing to stdout, saw {:?}",
        String::from_utf8_lossy(&refused.stdout)
    );
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(
        stderr.starts_with(usage),
        "usage error names the command, saw {stderr}"
    );
    assert!(
        stderr.contains("./<name>"),
        "usage error names the spelling that works, saw {stderr}"
    );
    assert!(
        !root.join("--definitely-bogus-flag").exists(),
        "a refused directory must not be created"
    );
    assert_eq!(
        fs::read_dir(&root).unwrap().count(),
        0,
        "the refusal leaves the working directory empty"
    );

    // The same name is a directory when it is written with a path prefix.
    let escaped = run_in(&root, &["project-init", "./-dashed-name"]);
    assert_eq!(
        escaped.status.code(),
        Some(0),
        "prefixed name is a directory"
    );
    assert!(
        root.join("-dashed-name/project.json").is_file(),
        "the prefixed directory receives a manifest"
    );
    assert!(
        root.join("-dashed-name/modules/main.re").is_file(),
        "the prefixed directory receives a module"
    );

    // A plain name is unaffected.
    let plain = run_in(&root, &["project-init", "starter"]);
    assert_eq!(plain.status.code(), Some(0), "plain name still works");
    assert!(
        root.join("starter/project.json").is_file(),
        "the plain directory receives a manifest"
    );
    assert!(
        String::from_utf8_lossy(&plain.stdout)
            .contains("\"schema\":\"re.native-project-init@0.1.0\""),
        "success keeps its envelope, saw {:?}",
        String::from_utf8_lossy(&plain.stdout)
    );

    fs::remove_dir_all(&root).unwrap();
}
