use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
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
        load_project_directory, serialize_project_manifest,
    },
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn capability_project_comparison_runs_real_project_authority_three_ways() {
    let root = temp_root("success");
    let output = root.join("project-capability-report.json");
    let cache = root.join("cache");
    let build = root.join("build");
    let (project, catalog) = setup_project(&root);

    let first = run(&[
        "capability-project-comparison",
        catalog.to_str().unwrap(),
        project.to_str().unwrap(),
        cache.to_str().unwrap(),
        build.to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        output.to_str().unwrap(),
    ]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    assert_eq!(first.stdout, fs::read(&output).unwrap());
    assert!(text(&first.stdout).contains("re.native-capability-project-comparison-report@0.1.0"));
    assert!(text(&first.stdout).contains("\"project_run_digest\""));
    assert!(text(&first.stdout).contains("\"workload_id\":\"write-success\""));
    assert!(!text(&first.stdout).contains(root.to_str().unwrap()));

    let second_output = root.join("project-capability-report-second.json");
    let second = run(&[
        "capability-project-comparison",
        catalog.to_str().unwrap(),
        project.to_str().unwrap(),
        root.join("cache-second").to_str().unwrap(),
        root.join("build-second").to_str().unwrap(),
        PROFILE,
        TOOLCHAIN,
        second_output.to_str().unwrap(),
    ]);
    assert!(second.status.success(), "{}", text(&second.stderr));
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.stdout, fs::read(&second_output).unwrap());
}

#[test]
fn capability_project_comparison_rejects_project_module_source_drift_before_write() {
    let root = temp_root("drift");
    let (project, catalog) = setup_project(&root);
    let output = root.join("report.json");
    fs::write(
        project.join("modules/args.re"),
        b"re 0.1 compact\nunit @drift\n",
    )
    .unwrap();

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
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(!output.exists());
    assert!(text(&result.stderr).contains("native-capability-project-comparison"));
}

#[test]
fn capability_project_comparison_rejects_project_entry_contract_drift_before_write() {
    let root = temp_root("contract-drift");
    let (project, catalog) = setup_project(&root);
    let output = root.join("report.json");
    let loaded = load_project_directory(&project).unwrap();
    let mut package = loaded.package_manifest;
    let target = package
        .modules
        .iter_mut()
        .find(|module| module.name == "revia.capability.args_success")
        .unwrap();
    target.interface.exports[0].contract_digest =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_owned();
    target.interface_digest = target.interface.digest().unwrap();
    let project_modules = loaded
        .modules
        .iter()
        .map(|module| NativeProjectModule::new(&module.name, &module.path, &module.source_sha256))
        .collect::<Vec<_>>();
    fs::write(
        project.join("project.json"),
        serialize_project_manifest(&project_modules, &package).unwrap(),
    )
    .unwrap();

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
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(!output.exists());
    assert!(
        text(&result.stderr).contains("contract"),
        "{}",
        text(&result.stderr)
    );
}

#[test]
fn capability_project_comparison_rejects_report_inside_project_before_effect() {
    let root = temp_root("containment");
    let (project, catalog) = setup_project(&root);
    let output = project.join("report.json");

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
    assert_eq!(result.status.code(), Some(65));
    assert!(result.stdout.is_empty());
    assert!(!output.exists());
    assert!(
        text(&result.stderr)
            .contains("native-capability-project-comparison-output-or-build-path-invalid")
    );
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

fn contract_digest(module_name: &str) -> String {
    format!(
        "sha256:{}",
        sha256_hex(format!("{module_name}.main:process.status@0.1.0").as_bytes())
    )
}

fn run(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_revia"))
        .args(arguments)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp294-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
