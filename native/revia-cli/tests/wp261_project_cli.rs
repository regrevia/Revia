use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        serialize_project_manifest,
    },
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SOURCE: &str = include_str!("../../../examples/hello.re");

#[test]
fn native_cli_project_translate_and_run_are_path_free_and_deterministic() {
    let root = std::env::temp_dir().join(format!(
        "revia-wp261-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let cache = root.with_file_name("revia-wp261-cli-cache");
    let build = root.with_file_name("revia-wp261-cli-build");
    fs::create_dir_all(root.join("modules")).unwrap();
    fs::write(root.join("modules/main.re"), SOURCE).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    let package = NativePackage::new(
        "agent.native",
        vec![NativeModule::new(
            "agent.native.main",
            source_digest.clone(),
            NativeInterface::new(
                "agent.native.main",
                vec![],
                vec![NativeExport::function(
                    "main",
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )],
            ),
        )],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[NativeProjectModule::new(
                "agent.native.main",
                "modules/main.re",
                source_digest,
            )],
            &package,
        )
        .unwrap(),
    )
    .unwrap();

    let args = [
        "project-translate",
        root.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    ];
    let first = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap();
    assert!(first.status.success());
    let first_stdout = String::from_utf8(first.stdout.clone()).unwrap();
    assert!(first_stdout.contains("\"module\":\"agent.native.main\""));
    assert!(first_stdout.contains("\"schema\":\"re.native-project-translation@0.1.0\""));
    assert!(!first_stdout.contains(root.to_str().unwrap()));

    let second = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(args)
        .output()
        .unwrap();
    assert_eq!(second.stdout, first.stdout);

    let run_args = [
        "project-run",
        root.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
        INPUT,
    ];
    let run = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(run_args)
        .output()
        .unwrap();
    assert!(run.status.success());
    let run_stdout = String::from_utf8(run.stdout).unwrap();
    assert!(run_stdout.contains("\"outcome_code\":0"));
    assert!(run_stdout.contains("\"schema\":\"re.native-project-run@0.1.0\""));
    assert!(!run_stdout.contains(root.to_str().unwrap()));

    fs::remove_dir_all(root).unwrap();
    let _ = fs::remove_dir_all(cache);
    let _ = fs::remove_dir_all(build);
}
