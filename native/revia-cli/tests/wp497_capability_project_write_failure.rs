use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command},
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::{
    capability_comparison::parse_capability_comparison_catalog,
    capability_project_comparison::{
        CapabilityProjectComparisonCatalog, CapabilityProjectComparisonWorkload,
        serialize_capability_project_comparison_catalog,
    },
    digest::sha256_hex,
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        serialize_project_manifest,
    },
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn capability_project_comparison_reports_write_failure_as_report_object() {
    let root = temp_root("write-failure");
    fs::create_dir_all(&root).unwrap();
    let (project, catalog) = setup_project(&root);
    let output = root.join("report");
    fs::create_dir_all(&output).unwrap();

    let result = run(&[
        "capability-project-comparison",
        catalog.to_str().unwrap(),
        project.to_str().unwrap(),
        root.join("cache").to_str().unwrap(),
        root.join("build").to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        output.to_str().unwrap(),
    ]);
    assert_eq!(result.status.code(), Some(74));
    assert!(result.stdout.is_empty());
    assert_eq!(
        text(&result.stderr),
        concat!(
            r#"{"diagnostics":[{"code":"native-capability-project-"#,
            r#"comparison-report-write-failure"}],"ok":false,"#,
            r#""schema":"re.native-capability-project-comparison-report@0.1.0"}"#,
        )
    );
    assert!(output.is_dir());
    assert_eq!(fs::read_dir(&output).unwrap().count(), 0);

    fs::remove_dir_all(root).unwrap();
}

fn contract_digest(module_name: &str) -> String {
    format!(
        "sha256:{}",
        sha256_hex(format!("{module_name}.main:process.status@0.1.0").as_bytes())
    )
}

fn run(arguments: &[&str]) -> process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

fn temp_root(label: &str) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revia-wp497-{label}-{}-{counter}", process::id()))
}

fn setup_project(root: &Path) -> (PathBuf, PathBuf) {
    let project = root.join("project");
    let catalog = root.join("catalog.json");
    fs::create_dir_all(project.join("modules")).unwrap();
    let workloads = [
        ("args-success", "revia.capability.args_success", "args.re"),
        ("read-success", "revia.capability.read_success", "read.re"),
        (
            "read-missing",
            "revia.capability.read_missing",
            "read-missing.re",
        ),
        (
            "write-success",
            "revia.capability.write_success",
            "write.re",
        ),
    ];
    let catalog_source =
        include_str!("../../../test/fixtures/native-capability-comparison-catalog.json");
    let base_catalog = parse_capability_comparison_catalog(catalog_source).unwrap();
    let mut project_modules = Vec::new();
    let mut package_modules = Vec::new();
    let mut project_workloads = Vec::new();
    for ((workload_id, module_name, filename), workload) in
        workloads.into_iter().zip(base_catalog.workloads)
    {
        assert_eq!(workload_id, workload.workload_id);
        let source = workload.source.clone();
        let path = format!("modules/{filename}");
        let digest = format!("sha256:{}", sha256_hex(source.as_bytes()));
        fs::write(project.join(&path), &source).unwrap();
        project_modules.push(NativeProjectModule::new(module_name, &path, digest.clone()));
        package_modules.push(NativeModule::new(
            module_name,
            digest,
            NativeInterface::new(
                module_name,
                vec![],
                vec![NativeExport::function("main", contract_digest(module_name))],
            ),
        ));
        project_workloads.push(CapabilityProjectComparisonWorkload::new(
            workload.workload_id,
            module_name,
            path,
            source,
            workload.operation,
            workload.input_digest,
            workload.sandbox_before,
            workload.sandbox_after,
            workload.expected_outcome_code,
        ));
    }
    let project_catalog = CapabilityProjectComparisonCatalog::new(project_workloads);
    fs::write(
        &catalog,
        serialize_capability_project_comparison_catalog(&project_catalog).unwrap(),
    )
    .unwrap();
    let package = NativePackage::new("revia.capability", package_modules);
    fs::write(
        project.join("project.json"),
        serialize_project_manifest(&project_modules, &package).unwrap(),
    )
    .unwrap();
    (project, catalog)
}
