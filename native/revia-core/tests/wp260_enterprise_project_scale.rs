use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProject, NativeProjectModule, build_project, serialize_project_graph,
        serialize_project_manifest, validate_enterprise_project_scale,
    },
};

const CONTRACT_ROUTE: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT_TASK: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_enterprise_project_has_fifty_modules_and_one_hundred_symbols() {
    let normal = make_fixture(false);
    let reversed = make_fixture(true);

    let normal_report = validate_enterprise_project_scale(&normal.project).unwrap();
    let reversed_report = validate_enterprise_project_scale(&reversed.project).unwrap();
    assert_eq!(normal_report.module_count, 50);
    assert_eq!(normal_report.route_count, 50);
    assert_eq!(normal_report.task_count, 50);
    assert_eq!(normal_report.public_symbol_count, 100);
    assert_eq!(normal_report, reversed_report);
    assert_eq!(
        serialize_project_graph(&normal.project).unwrap(),
        serialize_project_graph(&reversed.project).unwrap()
    );

    let first = build_project(
        &normal.root,
        &normal.cache,
        &normal.build,
        PROFILE,
        TOOLCHAIN,
        None,
    )
    .unwrap();
    assert_eq!(first.stats.built, 50);
    assert_eq!(first.stats.hits, 0);
    assert_eq!(first.invalidation.modules.len(), 50);

    let warm = build_project(
        &normal.root,
        &normal.cache,
        &normal.build,
        PROFILE,
        TOOLCHAIN,
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(warm.stats.built, 0);
    assert_eq!(warm.stats.hits, 50);
    assert!(warm.invalidation.modules.is_empty());
    cleanup(&normal);
    cleanup(&reversed);
}

#[test]
fn native_enterprise_project_rejects_missing_public_symbol_inventory() {
    let fixture = make_fixture(false);
    let source_path = fixture.root.join("modules/m000.re");
    let source = fs::read_to_string(&source_path).unwrap();
    fs::write(&source_path, source.replace("route_000", "internal_000")).unwrap();
    let error = revia_core::project::load_project_directory(&fixture.root).unwrap_err();
    assert_eq!(error.code, "project-module-source-digest-mismatch");

    let smaller = make_small_fixture();
    let error = validate_enterprise_project_scale(&smaller.project).unwrap_err();
    assert_eq!(error.code, "enterprise-project-module-count-mismatch");
    cleanup(&fixture);
    cleanup(&smaller);
}

#[test]
fn native_enterprise_project_invalidates_only_changed_implementation() {
    let fixture = make_fixture(false);
    let first = build_project(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        None,
    )
    .unwrap();
    let module = &fixture.project.modules[10];
    let old_source = fs::read_to_string(fixture.root.join(&module.path)).unwrap();
    let new_source = format!("{old_source}// implementation-only change\n");
    fs::write(fixture.root.join(&module.path), new_source.as_bytes()).unwrap();
    rewrite_manifest(&fixture, Some(10), None);

    let changed = build_project(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(changed.invalidation.modules, ["agent.enterprise.m010"]);
    assert_eq!(changed.stats.built, 1);
    assert_eq!(changed.stats.hits, 49);
    cleanup(&fixture);
}

#[test]
fn native_enterprise_project_propagates_interface_change_to_reverse_closure() {
    let fixture = make_fixture(false);
    let first = build_project(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        None,
    )
    .unwrap();
    rewrite_manifest(&fixture, None, Some(10));

    let changed = build_project(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(changed.invalidation.modules.len(), 40);
    assert_eq!(
        changed.invalidation.modules.first().unwrap(),
        "agent.enterprise.m010"
    );
    assert_eq!(
        changed.invalidation.modules.last().unwrap(),
        "agent.enterprise.m049"
    );
    assert_eq!(changed.stats.built, 40);
    assert_eq!(changed.stats.hits, 10);
    cleanup(&fixture);
}

struct Fixture {
    project: NativeProject,
    root: std::path::PathBuf,
    cache: std::path::PathBuf,
    build: std::path::PathBuf,
}

fn make_fixture(reverse: bool) -> Fixture {
    let root = temp_root("enterprise");
    fs::create_dir_all(root.join("modules")).unwrap();
    let mut modules = Vec::new();
    let mut package_modules = Vec::new();
    let mut interface_digests: Vec<String> = Vec::new();
    for index in 0..50 {
        let name = format!("agent.enterprise.m{index:03}");
        let mut dependencies = Vec::new();
        if index > 0 {
            dependencies.push(NativeDependency::package(
                "previous",
                interface_digests[index - 1].clone(),
                format!("agent.enterprise.m{:03}", index - 1),
            ));
        }
        if index == 49 {
            dependencies.push(NativeDependency::package(
                "root",
                interface_digests[1].clone(),
                "agent.enterprise.m001",
            ));
        }
        let interface = NativeInterface::new(
            name.clone(),
            dependencies,
            vec![
                NativeExport::function(format!("route_{index:03}"), CONTRACT_ROUTE),
                NativeExport::function(format!("task_{index:03}"), CONTRACT_TASK),
            ],
        );
        let interface_digest = interface.digest().unwrap();
        interface_digests.push(interface_digest);
        let source = format!(
            "re 1.0 compact\nmodule {name}\nexport route_{index:03}\nexport task_{index:03}\n"
        );
        let path = format!("modules/m{index:03}.re");
        fs::write(root.join(&path), source.as_bytes()).unwrap();
        modules.push(NativeProjectModule::new(
            name.clone(),
            path,
            format!("sha256:{}", sha256_hex(source.as_bytes())),
        ));
        package_modules.push(NativeModule::new(
            name,
            format!("sha256:{}", sha256_hex(source.as_bytes())),
            interface,
        ));
    }
    if reverse {
        modules.reverse();
        package_modules.reverse();
    }
    let package = NativePackage::new("agent.enterprise", package_modules);
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(&modules, &package).unwrap(),
    )
    .unwrap();
    let project = revia_core::project::load_project_directory(&root).unwrap();
    let cache = root.with_file_name(format!(
        "{}-cache",
        root.file_name().unwrap().to_string_lossy()
    ));
    let build = root.with_file_name(format!(
        "{}-build",
        root.file_name().unwrap().to_string_lossy()
    ));
    Fixture {
        project,
        root,
        cache,
        build,
    }
}

fn make_small_fixture() -> Fixture {
    let root = temp_root("small");
    fs::create_dir_all(root.join("modules")).unwrap();
    let source = "re 1.0 compact\nmodule agent.small.main\nexport route_000\n";
    fs::write(root.join("modules/main.re"), source).unwrap();
    let interface = NativeInterface::new(
        "agent.small.main",
        vec![],
        vec![NativeExport::function("route_000", CONTRACT_ROUTE)],
    );
    let package = NativePackage::new(
        "agent.small",
        vec![NativeModule::new(
            "agent.small.main",
            format!("sha256:{}", sha256_hex(source.as_bytes())),
            interface,
        )],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[NativeProjectModule::new(
                "agent.small.main",
                "modules/main.re",
                format!("sha256:{}", sha256_hex(source.as_bytes())),
            )],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    let project = revia_core::project::load_project_directory(&root).unwrap();
    let cache = root.with_file_name(format!(
        "{}-cache",
        root.file_name().unwrap().to_string_lossy()
    ));
    let build = root.with_file_name(format!(
        "{}-build",
        root.file_name().unwrap().to_string_lossy()
    ));
    Fixture {
        project,
        root,
        cache,
        build,
    }
}

fn rewrite_manifest(
    fixture: &Fixture,
    implementation_change: Option<usize>,
    interface_change: Option<usize>,
) {
    let mut interface_digests: Vec<String> = Vec::with_capacity(50);
    let mut package_modules = Vec::with_capacity(50);
    for index in 0..50 {
        let name = format!("agent.enterprise.m{index:03}");
        let old = fixture
            .project
            .package_manifest
            .modules
            .iter()
            .find(|module| module.name == name)
            .unwrap();
        let mut dependencies = Vec::new();
        if index > 0 {
            dependencies.push(NativeDependency::package(
                "previous",
                interface_digests[index - 1].clone(),
                format!("agent.enterprise.m{:03}", index - 1),
            ));
        }
        if index == 49 {
            dependencies.push(NativeDependency::package(
                "root",
                interface_digests[1].clone(),
                "agent.enterprise.m001",
            ));
        }
        let route_contract = if interface_change == Some(index) {
            CONTRACT_TASK
        } else {
            CONTRACT_ROUTE
        };
        let interface = NativeInterface::new(
            name.clone(),
            dependencies,
            vec![
                NativeExport::function(format!("route_{index:03}"), route_contract),
                NativeExport::function(format!("task_{index:03}"), CONTRACT_TASK),
            ],
        );
        let interface_digest = interface.digest().unwrap();
        interface_digests.push(interface_digest);
        let implementation_digest = if implementation_change == Some(index) {
            let source = fs::read(fixture.root.join(&fixture.project.modules[index].path)).unwrap();
            format!("sha256:{}", sha256_hex(&source))
        } else {
            old.implementation_digest.clone()
        };
        package_modules.push(NativeModule::new(name, implementation_digest, interface));
    }
    let modules = fixture
        .project
        .modules
        .iter()
        .enumerate()
        .map(|(index, module)| {
            let source_sha256 = if implementation_change == Some(index) {
                let source = fs::read(fixture.root.join(&module.path)).unwrap();
                format!("sha256:{}", sha256_hex(&source))
            } else {
                module.source_sha256.clone()
            };
            NativeProjectModule::new(module.name.clone(), module.path.clone(), source_sha256)
        })
        .collect::<Vec<_>>();
    let package = NativePackage::new("agent.enterprise", package_modules);
    fs::write(
        fixture.root.join("project.json"),
        serialize_project_manifest(&modules, &package).unwrap(),
    )
    .unwrap();
}

fn cleanup(fixture: &Fixture) {
    let _ = fs::remove_dir_all(&fixture.root);
    let _ = fs::remove_dir_all(&fixture.cache);
    let _ = fs::remove_dir_all(&fixture.build);
}

fn temp_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp260-{label}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}
