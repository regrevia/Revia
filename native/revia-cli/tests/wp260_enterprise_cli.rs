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

#[test]
fn native_cli_project_scale_reports_fifty_modules_and_one_hundred_symbols() {
    let root = std::env::temp_dir().join(format!(
        "revia-wp260-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("modules")).unwrap();
    let mut project_modules = Vec::new();
    let mut package_modules = Vec::new();
    let mut interface_digests: Vec<String> = Vec::new();
    for index in 0..50 {
        let name = format!("agent.cli.enterprise.m{index:03}");
        let source = format!(
            "re 1.0 compact\nmodule {name}\nexport route_{index:03}\nexport task_{index:03}\n"
        );
        let path = format!("modules/m{index:03}.re");
        fs::write(root.join(&path), source.as_bytes()).unwrap();
        let mut dependencies = Vec::new();
        if index > 0 {
            dependencies.push(revia_core::project::NativeDependency::package(
                "previous",
                interface_digests[index - 1].clone(),
                format!("agent.cli.enterprise.m{:03}", index - 1),
            ));
        }
        if index == 49 {
            dependencies.push(revia_core::project::NativeDependency::package(
                "root",
                interface_digests[1].clone(),
                "agent.cli.enterprise.m001",
            ));
        }
        let interface = NativeInterface::new(
            name.clone(),
            dependencies,
            vec![
                NativeExport::function(
                    format!("route_{index:03}"),
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                ),
                NativeExport::function(
                    format!("task_{index:03}"),
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                ),
            ],
        );
        interface_digests.push(interface.digest().unwrap());
        package_modules.push(NativeModule::new(
            name.clone(),
            format!("sha256:{}", sha256_hex(source.as_bytes())),
            interface,
        ));
        project_modules.push(NativeProjectModule::new(
            name,
            path,
            format!("sha256:{}", sha256_hex(source.as_bytes())),
        ));
    }
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &project_modules,
            &NativePackage::new("agent.cli.enterprise", package_modules),
        )
        .unwrap(),
    )
    .unwrap();

    let first = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-scale", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(first.status.success());
    let stdout = String::from_utf8(first.stdout.clone()).unwrap();
    assert!(stdout.contains("\"module_count\":50"));
    assert!(stdout.contains("\"route_count\":50"));
    assert!(stdout.contains("\"task_count\":50"));
    assert!(stdout.contains("\"public_symbol_count\":100"));
    assert!(!stdout.contains(root.to_str().unwrap()));

    let second = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(["project-scale", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(second.stdout, first.stdout);
    fs::remove_dir_all(root).unwrap();
}
