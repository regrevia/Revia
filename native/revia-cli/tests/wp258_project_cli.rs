use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::digest::sha256_hex;
use revia_core::project::{
    NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
    serialize_project_manifest,
};

const PROFILE: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn native_cli_project_check_and_build_are_path_free_and_deterministic() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("revia-wp258-cli-{stamp}"));
    let project = root.join("project");
    fs::create_dir_all(project.join("modules")).unwrap();
    let source = b"module agent.cli.main\n";
    fs::write(project.join("modules/main.re"), source).unwrap();
    let interface = NativeInterface::new(
        "agent.cli.main",
        vec![],
        vec![NativeExport::function("main", PROFILE)],
    );
    let package = NativePackage::new(
        "agent.cli",
        vec![NativeModule::new(
            "agent.cli.main",
            format!("sha256:{}", sha256_hex(source)),
            interface,
        )],
    );
    fs::write(
        project.join("project.json"),
        serialize_project_manifest(
            &[NativeProjectModule::new(
                "agent.cli.main",
                "modules/main.re",
                format!("sha256:{}", sha256_hex(source)),
            )],
            &package,
        )
        .unwrap(),
    )
    .unwrap();

    let check = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(check.status.success());
    let check_stdout = String::from_utf8(check.stdout.clone()).unwrap();
    assert!(check_stdout.contains("re.native-project-graph@0.1.0"));
    assert!(!check_stdout.contains(root.to_str().unwrap()));
    let check_again = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-check", project.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(check_again.stdout, check.stdout);

    let build = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "project-build",
            project.to_str().unwrap(),
            root.join("cache").to_str().unwrap(),
            root.join("build").to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
        ])
        .output()
        .unwrap();
    assert!(build.status.success());
    let build_stdout = String::from_utf8(build.stdout).unwrap();
    assert!(build_stdout.contains("re.native-project-build-manifest@0.1.0"));
    assert!(!build_stdout.contains(root.to_str().unwrap()));
    assert!(build_stdout.contains("\"published\":true"));

    let warm_build = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "project-build",
            project.to_str().unwrap(),
            root.join("cache").to_str().unwrap(),
            root.join("build").to_str().unwrap(),
            PROFILE,
            TOOLCHAIN,
        ])
        .output()
        .unwrap();
    assert!(warm_build.status.success());
    let warm_stdout = String::from_utf8(warm_build.stdout).unwrap();
    assert!(warm_stdout.contains("\"built\":0"));
    assert!(warm_stdout.contains("\"hits\":1"));
    assert!(warm_stdout.contains("\"published\":false"));

    fs::remove_dir_all(root).unwrap();
}
