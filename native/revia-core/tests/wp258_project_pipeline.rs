use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use revia_core::digest::sha256_hex;
use revia_core::project::{
    NativeDependency, NativeExport, NativeExternalInterface, NativeInterface, NativeModule,
    NativePackage, NativeProjectModule, build_project, load_project_directory,
    package_manifest_digest, plan_project_recheck, serialize_project_manifest,
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_project_loader_rebuilds_package_digest_and_topological_order() {
    let fixture = make_fixture();
    let project = load_project_directory(&fixture.project).unwrap();

    assert_eq!(project.package, "agent.demo");
    assert_eq!(
        project
            .modules
            .iter()
            .map(|module| module.name.as_str())
            .collect::<Vec<_>>(),
        ["agent.demo.core", "agent.demo.api"],
    );
    assert_eq!(
        project.package_digest,
        package_manifest_digest(&project.package_manifest).unwrap(),
    );
    assert_eq!(
        project.modules[1].dependencies,
        vec![NativeDependency::package(
            "core",
            project.modules[0].interface_digest.clone(),
            "agent.demo.core",
        )],
    );
    cleanup(&fixture.root);
}

#[test]
fn native_project_loader_rejects_stale_pin_cycle_escape_and_unknown_fields() {
    let fixture = make_fixture();
    let core_interface = NativeInterface::new(
        "agent.demo.core",
        vec![],
        vec![NativeExport::function("normalize", DIGEST_A)],
    );
    let stale_api_interface = NativeInterface::new(
        "agent.demo.api",
        vec![NativeDependency::package(
            "core",
            DIGEST_B,
            "agent.demo.core",
        )],
        vec![NativeExport::function("serve", DIGEST_B)],
    );
    let stale_package = NativePackage::new(
        "agent.demo",
        vec![
            NativeModule::new(
                "agent.demo.core",
                fixture.core_source_digest.clone(),
                core_interface,
            ),
            NativeModule::new(
                "agent.demo.api",
                fixture.api_source_digest.clone(),
                stale_api_interface,
            ),
        ],
    );
    let modules = vec![
        NativeProjectModule::new(
            "agent.demo.core",
            "modules/core.re",
            fixture.core_source_digest.clone(),
        ),
        NativeProjectModule::new(
            "agent.demo.api",
            "modules/api.re",
            source_digest(&fs::read(fixture.project.join("modules/api.re")).unwrap()),
        ),
    ];
    write_manifest(
        &fixture.project,
        &serialize_project_manifest(&modules, &stale_package).unwrap(),
    );
    let stale = load_project_directory(&fixture.project).unwrap_err();
    assert_eq!(stale.code, "package-dependency-interface-mismatch");

    let fixture = make_fixture();
    let mut manifest = read_manifest(&fixture.project);
    manifest = manifest.replace(
        "\"schema\":\"re.project-manifest@0.1.0\"",
        "\"unknown\":true,\"schema\":\"re.project-manifest@0.1.0\"",
    );
    write_manifest(&fixture.project, &manifest);
    let unknown = load_project_directory(&fixture.project).unwrap_err();
    assert_eq!(unknown.code, "unexpected-project-manifest-field");

    let fixture = make_fixture();
    let mut manifest = read_manifest(&fixture.project);
    manifest = manifest.replace(
        "\"dependencies\":[]",
        &format!(
            "\"dependencies\":[{{\"binding\":\"api\",\"interface_digest\":\"{}\",\"module\":\"agent.demo.api\",\"scope\":\"package\"}}]",
            fixture.api_interface_digest
        ),
    );
    write_manifest(&fixture.project, &manifest);
    let cycle = load_project_directory(&fixture.project).unwrap_err();
    assert_eq!(cycle.code, "module-dependency-cycle");

    let fixture = make_fixture();
    let mut manifest = read_manifest(&fixture.project);
    manifest = manifest.replace("modules/core.re", "../outside.re");
    write_manifest(&fixture.project, &manifest);
    let escape = load_project_directory(&fixture.project).unwrap_err();
    assert_eq!(escape.code, "project-module-path-escapes-root");

    cleanup(&fixture.root);
}

#[test]
fn native_project_loader_rejects_source_digest_drift_and_unlisted_files() {
    let fixture = make_fixture();
    fs::write(fixture.project.join("README.md"), b"project notes").unwrap();
    fs::write(fixture.project.join("HANDOFF.md"), b"handoff notes").unwrap();
    assert!(load_project_directory(&fixture.project).is_ok());

    fs::write(fixture.project.join("notes.txt"), b"unlisted").unwrap();
    let mut manifest = read_manifest(&fixture.project);
    manifest = manifest.replace(
        &fixture.core_source_digest,
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    write_manifest(&fixture.project, &manifest);

    let error = load_project_directory(&fixture.project).unwrap_err();
    assert_eq!(error.code, "project-module-source-digest-mismatch");
    cleanup(&fixture.root);
}

#[test]
fn native_project_build_reuses_cache_and_invalidates_dependents() {
    let fixture = make_fixture();
    let first = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap();
    assert_eq!(first.stats.built, 2);
    assert_eq!(first.stats.hits, 0);
    assert_eq!(
        first.invalidation.modules,
        ["agent.demo.core", "agent.demo.api"]
    );

    let warm = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(warm.stats.built, 0);
    assert_eq!(warm.stats.hits, 2);
    assert!(warm.invalidation.modules.is_empty());
    assert_eq!(warm.manifest, first.manifest);

    let mut manifest = read_manifest(&fixture.project);
    let original = fs::read_to_string(fixture.project.join("modules/core.re")).unwrap();
    let changed = format!("{original}\n");
    fs::write(fixture.project.join("modules/core.re"), changed.as_bytes()).unwrap();
    manifest = manifest.replace(
        &fixture.core_source_digest,
        &format!("sha256:{}", sha256_hex(changed.as_bytes())),
    );
    write_manifest(&fixture.project, &manifest);
    let changed_build = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(changed_build.invalidation.modules, ["agent.demo.core"]);
    assert_eq!(changed_build.stats.built, 1);
    assert_eq!(changed_build.stats.hits, 1);
    cleanup(&fixture.root);
}

#[test]
fn native_project_build_publishes_closed_cache_and_manifest_files() {
    let fixture = make_fixture();

    let first = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap();

    for module in &first.manifest.modules {
        assert!(
            fixture
                .cache
                .join(module.cache_key.trim_start_matches("sha256:"))
                .join("artifact.json")
                .is_file()
        );
    }
    assert!(
        fixture
            .build
            .join(first.manifest.build_key.trim_start_matches("sha256:"))
            .join("build.json")
            .is_file()
    );

    cleanup(&fixture.root);
}

#[test]
fn native_project_build_reports_manifest_root_stage_without_path_details() {
    let fixture = make_fixture();
    fs::create_dir(&fixture.build).unwrap();
    fs::remove_dir(&fixture.build).unwrap();
    fs::write(&fixture.build, b"not a directory").unwrap();

    let error = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap_err();

    assert_eq!(error.code, "project-build-manifest-root-create-failure");
    assert!(!error.code.contains('/'));
    cleanup(&fixture.root);
}

#[test]
fn native_project_build_invalidates_every_module_on_interface_or_toolchain_drift() {
    let fixture = make_fixture();
    let first = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap();

    let changed_contract =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let core_interface = NativeInterface::new(
        "agent.demo.core",
        vec![],
        vec![NativeExport::function("normalize", changed_contract)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.demo.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest,
            "agent.demo.core",
        )],
        vec![NativeExport::function("serve", DIGEST_B)],
    );
    let package = NativePackage::new(
        "agent.demo",
        vec![
            NativeModule::new(
                "agent.demo.core",
                fixture.core_source_digest.clone(),
                core_interface,
            ),
            NativeModule::new(
                "agent.demo.api",
                fixture.api_source_digest.clone(),
                api_interface,
            ),
        ],
    );
    let modules = vec![
        NativeProjectModule::new(
            "agent.demo.core",
            "modules/core.re",
            fixture.core_source_digest.clone(),
        ),
        NativeProjectModule::new(
            "agent.demo.api",
            "modules/api.re",
            source_digest(&fs::read(fixture.project.join("modules/api.re")).unwrap()),
        ),
    ];
    write_manifest(
        &fixture.project,
        &serialize_project_manifest(&modules, &package).unwrap(),
    );
    let changed = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        Some(&first.manifest),
    );
    let changed = changed.unwrap();
    assert_eq!(
        changed.invalidation.modules,
        ["agent.demo.core", "agent.demo.api"]
    );
    assert_eq!(changed.stats.built, 2);

    let fixture = make_fixture();
    let first = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap();
    let toolchain = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        Some(&first.manifest),
    )
    .unwrap();
    assert_eq!(
        toolchain.invalidation.modules,
        ["agent.demo.core", "agent.demo.api"],
    );
    assert_eq!(toolchain.stats.built, 2);
    cleanup(&fixture.root);
}

#[test]
fn native_project_plan_recheck_is_deterministic_and_rejects_unknown_module() {
    let fixture = make_fixture();
    let project = load_project_directory(&fixture.project).unwrap();
    let plan = plan_project_recheck(&project, &["agent.demo.core".to_owned()], &[], false).unwrap();
    assert_eq!(plan, vec!["agent.demo.core"]);

    let plan = plan_project_recheck(&project, &[], &["agent.demo.core".to_owned()], false).unwrap();
    assert_eq!(plan, vec!["agent.demo.core", "agent.demo.api"]);

    let error =
        plan_project_recheck(&project, &["agent.demo.unknown".to_owned()], &[], false).unwrap_err();
    assert_eq!(error.code, "changed-module-not-found");
    cleanup(&fixture.root);
}

#[test]
fn native_project_build_keeps_previous_manifest_when_cache_is_corrupt() {
    let fixture = make_fixture();
    let first = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        None,
    )
    .unwrap();
    let cache_key = first.manifest.modules[0].cache_key.clone();
    fs::write(
        fixture
            .cache
            .join(cache_key.trim_start_matches("sha256:"))
            .join("artifact.json"),
        b"{partial",
    )
    .unwrap();

    let error = build_project(
        &fixture.project,
        &fixture.cache,
        &fixture.build,
        DIGEST_A,
        DIGEST_B,
        Some(&first.manifest),
    )
    .unwrap_err();
    assert_eq!(error.code, "module-artifact-cache-corrupt");
    assert!(
        fixture
            .build
            .join(first.manifest.build_key.trim_start_matches("sha256:"))
            .join("build.json")
            .is_file()
    );
    cleanup(&fixture.root);
}

#[test]
fn native_project_loader_handles_external_pins_and_bounded_chain_dags() {
    let mut previous_interface_digest = None;
    for count in [50usize, 500usize, 5000usize] {
        let root = std::env::temp_dir().join(format!(
            "revia-wp258-chain-{}-{}",
            std::process::id(),
            unique_counter()
        ));
        let project = root.join("project");
        let modules_directory = project.join("modules");
        fs::create_dir_all(&modules_directory).unwrap();
        let mut package_modules = Vec::with_capacity(count);
        let mut project_modules = Vec::with_capacity(count);
        let mut dependency_digest = None;
        for index in 0..count {
            let name = format!("agent.chain.m{index:04}");
            let source = format!("module {name}\n");
            let source_digest = source_digest(source.as_bytes());
            fs::write(modules_directory.join(format!("m{index:04}.re")), source).unwrap();
            let dependencies = dependency_digest
                .take()
                .map(|digest| {
                    vec![NativeDependency::package(
                        "previous",
                        digest,
                        format!("agent.chain.m{:04}", index - 1),
                    )]
                })
                .unwrap_or_default();
            let interface = NativeInterface::new(
                &name,
                dependencies,
                vec![NativeExport::function("run", DIGEST_A)],
            );
            let module = NativeModule::new(&name, source_digest.clone(), interface);
            dependency_digest = Some(module.interface_digest.clone());
            package_modules.push(module);
            project_modules.push(NativeProjectModule::new(
                &name,
                format!("modules/m{index:04}.re"),
                source_digest,
            ));
        }
        let package = NativePackage::new("agent.chain", package_modules);
        fs::write(
            project.join("project.json"),
            serialize_project_manifest(&project_modules, &package).unwrap(),
        )
        .unwrap();
        let loaded = load_project_directory(&project).unwrap();
        assert_eq!(loaded.modules.len(), count);
        assert_eq!(loaded.modules.first().unwrap().name, "agent.chain.m0000");
        assert_eq!(
            loaded.modules.last().unwrap().name,
            format!("agent.chain.m{:04}", count - 1)
        );
        assert_eq!(
            plan_project_recheck(&loaded, &[], &["agent.chain.m0000".to_owned()], false)
                .unwrap()
                .len(),
            count
        );
        cleanup(&root);
        previous_interface_digest = dependency_digest;
    }
    assert!(previous_interface_digest.is_some());

    let fixture = make_fixture();
    let external_interface = NativeInterface::new(
        "vendor.text",
        vec![],
        vec![NativeExport::function("normalize", DIGEST_A)],
    );
    let external_digest = external_interface.digest().unwrap();
    let mut package = fixture_package(&fixture);
    package.external_interfaces.push(NativeExternalInterface {
        interface: external_interface,
        interface_digest: external_digest.clone(),
        module: "vendor.text".to_owned(),
        package_digest: DIGEST_B.to_owned(),
    });
    package.modules[0]
        .interface
        .dependencies
        .push(NativeDependency::external(
            "vendor",
            external_digest,
            "vendor.text",
            DIGEST_B,
        ));
    package.modules[0].interface_digest = package.modules[0].interface.digest().unwrap();
    package.modules[1].interface.dependencies[0].interface_digest =
        package.modules[0].interface_digest.clone();
    package.modules[1].interface_digest = package.modules[1].interface.digest().unwrap();
    fs::write(
        fixture.project.join("project.json"),
        serialize_project_manifest(
            &[
                NativeProjectModule::new(
                    "agent.demo.core",
                    "modules/core.re",
                    fixture.core_source_digest.clone(),
                ),
                NativeProjectModule::new(
                    "agent.demo.api",
                    "modules/api.re",
                    fixture.api_source_digest.clone(),
                ),
            ],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(load_project_directory(&fixture.project).is_ok());
    package.external_interfaces[0].package_digest = DIGEST_A.to_owned();
    fs::write(
        fixture.project.join("project.json"),
        serialize_project_manifest(
            &[
                NativeProjectModule::new(
                    "agent.demo.core",
                    "modules/core.re",
                    fixture.core_source_digest.clone(),
                ),
                NativeProjectModule::new(
                    "agent.demo.api",
                    "modules/api.re",
                    fixture.api_source_digest.clone(),
                ),
            ],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        load_project_directory(&fixture.project).unwrap_err().code,
        "external-dependency-not-found"
    );
    cleanup(&fixture.root);
}

#[test]
fn native_project_loader_rejects_duplicate_identity_and_declared_symlink() {
    let fixture = make_fixture();
    let package = fixture_package(&fixture);
    let duplicate = vec![
        NativeProjectModule::new(
            "agent.demo.core",
            "modules/core.re",
            fixture.core_source_digest.clone(),
        ),
        NativeProjectModule::new(
            "agent.demo.core",
            "modules/api.re",
            fixture.api_source_digest.clone(),
        ),
        NativeProjectModule::new(
            "agent.demo.api",
            "modules/api.re",
            fixture.api_source_digest.clone(),
        ),
    ];
    fs::write(
        fixture.project.join("project.json"),
        serialize_project_manifest(&duplicate, &package).unwrap(),
    )
    .unwrap();
    assert_eq!(
        load_project_directory(&fixture.project).unwrap_err().code,
        "duplicate-project-module"
    );
    cleanup(&fixture.root);

    #[cfg(unix)]
    {
        let fixture = make_fixture();
        fs::remove_file(fixture.project.join("modules/core.re")).unwrap();
        std::os::unix::fs::symlink(
            fixture.project.join("modules/api.re"),
            fixture.project.join("modules/core.re"),
        )
        .unwrap();
        assert_eq!(
            load_project_directory(&fixture.project).unwrap_err().code,
            "project-module-symlink-not-allowed"
        );
        cleanup(&fixture.root);
    }
}

#[derive(Debug)]
struct Fixture {
    root: PathBuf,
    project: PathBuf,
    cache: PathBuf,
    build: PathBuf,
    core_source_digest: String,
    api_source_digest: String,
    api_interface_digest: String,
}

fn make_fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "revia-wp258-{}-{}",
        std::process::id(),
        unique_counter(),
    ));
    let project = root.join("project");
    let modules = project.join("modules");
    fs::create_dir_all(&modules).unwrap();
    let core_source = b"module agent.demo.core\n";
    let api_source = b"module agent.demo.api\n";
    fs::write(modules.join("core.re"), core_source).unwrap();
    fs::write(modules.join("api.re"), api_source).unwrap();

    let core_interface = NativeInterface::new(
        "agent.demo.core",
        vec![],
        vec![NativeExport::function("normalize", DIGEST_A)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.demo.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest.clone(),
            "agent.demo.core",
        )],
        vec![NativeExport::function("serve", DIGEST_B)],
    );
    let api_interface_digest = api_interface.digest().unwrap();
    let package = NativePackage::new(
        "agent.demo",
        vec![
            NativeModule::new(
                "agent.demo.core",
                source_digest(core_source),
                core_interface,
            ),
            NativeModule::new("agent.demo.api", source_digest(api_source), api_interface),
        ],
    );
    let project_manifest = serialize_project_manifest(
        &[
            NativeProjectModule::new(
                "agent.demo.core",
                "modules/core.re",
                source_digest(core_source),
            ),
            NativeProjectModule::new(
                "agent.demo.api",
                "modules/api.re",
                source_digest(api_source),
            ),
        ],
        &package,
    )
    .unwrap();
    fs::write(project.join("project.json"), project_manifest).unwrap();

    Fixture {
        root: root.clone(),
        project,
        cache: root.join("cache"),
        build: root.join("build"),
        core_source_digest: source_digest(core_source),
        api_source_digest: source_digest(api_source),
        api_interface_digest,
    }
}

fn source_digest(source: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(source))
}

fn fixture_package(fixture: &Fixture) -> NativePackage {
    let core_interface = NativeInterface::new(
        "agent.demo.core",
        vec![],
        vec![NativeExport::function("normalize", DIGEST_A)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.demo.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest,
            "agent.demo.core",
        )],
        vec![NativeExport::function("serve", DIGEST_B)],
    );
    NativePackage::new(
        "agent.demo",
        vec![
            NativeModule::new(
                "agent.demo.core",
                fixture.core_source_digest.clone(),
                core_interface,
            ),
            NativeModule::new(
                "agent.demo.api",
                fixture.api_source_digest.clone(),
                api_interface,
            ),
        ],
    )
}

fn read_manifest(project: &Path) -> String {
    fs::read_to_string(project.join("project.json")).unwrap()
}

fn write_manifest(project: &Path, source: &str) {
    fs::write(project.join("project.json"), source).unwrap();
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

fn unique_counter() -> u128 {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    (timestamp << 16) | u128::from(FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed))
}
