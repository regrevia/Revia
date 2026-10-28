use std::{
    fs,
    path::PathBuf,
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

const SOURCE: &str = include_str!("../../../examples/hello.re");

#[test]
fn native_node_free_gate_runs_all_workloads_with_empty_path() {
    let root = temp_root("node-free-cli");
    let project = root.join("project");
    fs::create_dir_all(project.join("modules")).unwrap();
    fs::write(project.join("modules/main.re"), SOURCE).unwrap();
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
        project.join("project.json"),
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

    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let report_path = root.join("report.json");
    let source_path = project.join("modules/main.re");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .args([
            "node-free-gate",
            source_path.to_str().unwrap(),
            project.to_str().unwrap(),
            "agent.native.main",
            report_path.to_str().unwrap(),
        ])
        .env("PATH", &empty_path)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let report = fs::read_to_string(&report_path).unwrap();
    assert_eq!(stdout, report);
    assert!(report.contains("\"node_process_count\":0"));
    assert!(report.contains("\"node_load_count\":0"));
    assert!(report.contains("\"node_import_count\":0"));
    assert!(report.contains("\"performance_eligible\":false"));
    assert!(report.contains("\"status\":\"pending\""));
    assert!(report.contains("\"command\":\"project-server-smoke\""));
    assert!(!report.contains(root.to_str().unwrap()));
    assert!(!report.contains("node_modules"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_node_free_gate_accepts_relative_source_and_project_paths() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = temp_root("node-free-relative-cli");
    fs::create_dir_all(&root).unwrap();
    let empty_path = root.join("empty-path");
    fs::create_dir_all(&empty_path).unwrap();
    let report_path = root.join("report.json");
    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&repo_root)
        .args([
            "node-free-gate",
            "test/fixtures/native-node-free-enterprise/modules/m000.re",
            "test/fixtures/native-node-free-enterprise",
            "agent.enterprise.m000",
            report_path.to_str().unwrap(),
        ])
        .env("PATH", &empty_path)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, fs::read(&report_path).unwrap());
    assert!(!String::from_utf8_lossy(&output.stdout).contains(repo_root.to_str().unwrap()));
    fs::remove_dir_all(root).unwrap();
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp262-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
