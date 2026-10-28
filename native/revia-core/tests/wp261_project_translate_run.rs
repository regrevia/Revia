use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    bytecode::NATIVE_BYTECODE_PROFILE,
    digest::sha256_hex,
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, NativeProjectExecutionStep, execute_project_execution_plan,
        execute_project_module, project_translation_digest, serialize_project_execution,
        serialize_project_execution_plan, serialize_project_run, translate_project_module,
    },
    vm::{CapabilityBridge, CapabilityResponse, VmLimits, VmValue},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CONTRACT: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = include_str!("../../../examples/hello.re");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct Bridge {
    calls: usize,
    return_err: bool,
}

impl CapabilityBridge for Bridge {
    fn invoke(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &std::collections::BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        self.calls += 1;
        if self.return_err {
            Ok(CapabilityResponse::err(VmValue::Unit))
        } else {
            Ok(CapabilityResponse::ok(VmValue::Unit))
        }
    }
}

#[test]
fn native_project_translation_and_run_are_deterministic_and_authority_bound() {
    let fixture = make_fixture();
    let first = translate_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    )
    .unwrap();
    let second = translate_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.profile, NATIVE_BYTECODE_PROFILE);
    assert_eq!(first.module, "agent.native.main");
    assert!(first.artifact_source.starts_with("re 0.1 bytecode\n"));

    let mut bridge = Bridge::default();
    let run = execute_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
        &first,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert_eq!(run.translation, first);
    assert_eq!(run.vm.outcome.code, 0);
    assert_eq!(bridge.calls, 1);
    assert_eq!(
        serialize_project_run(&run).unwrap(),
        serialize_project_run(&run).unwrap()
    );

    let mut error_bridge = Bridge {
        return_err: true,
        ..Bridge::default()
    };
    let error_run = execute_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
        &first,
        INPUT,
        &mut error_bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert_eq!(error_run.vm.outcome.code, 1);
    assert_eq!(error_bridge.calls, 1);
    cleanup(&fixture);
}

#[test]
fn native_project_run_rejects_missing_entry_and_stale_translation_before_effect() {
    let fixture = make_fixture();
    let translation = translate_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    )
    .unwrap();

    let mut bridge = Bridge::default();
    let missing = execute_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.missing",
        &translation,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(missing.code, "native-project-entry-not-found");
    assert_eq!(bridge.calls, 0);

    let mut stale = translation.clone();
    stale.artifact_source = stale.artifact_source.replace("Hello", "Goodbye");
    stale.artifact_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
    stale.translation_digest = project_translation_digest(&stale);
    let stale = execute_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
        &stale,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(stale.code, "native-project-translation-mismatch");
    assert_eq!(bridge.calls, 0);
    cleanup(&fixture);
}

#[test]
fn native_project_translation_rejects_source_drift_and_invalid_input() {
    let fixture = make_fixture();
    let translation = translate_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    )
    .unwrap();
    fs::write(
        fixture.root.join("modules/main.re"),
        b"re 0.1 compact\nunit @drift\n",
    )
    .unwrap();
    let drift = translate_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
    )
    .unwrap_err();
    assert_eq!(drift.code, "project-module-source-digest-mismatch");

    fs::write(fixture.root.join("modules/main.re"), SOURCE).unwrap();
    let mut bridge = Bridge::default();
    let invalid = execute_project_module(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        "agent.native.main",
        &translation,
        "not-a-digest",
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(invalid.code, "native-vm-request-input-digest-invalid");
    assert_eq!(bridge.calls, 0);
    cleanup(&fixture);
}

#[test]
fn native_project_execution_plan_runs_explicit_dependency_chain_deterministically() {
    let fixture = make_two_module_fixture();
    let plan = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            fixture.core_interface_digest.clone(),
            CONTRACT.to_owned(),
        )],
    );
    let plan_bytes = serialize_project_execution_plan(&plan).unwrap();
    assert_eq!(
        revia_core::project_runtime::parse_project_execution_plan(&plan_bytes).unwrap(),
        plan
    );
    let mut first_bridge = Bridge::default();
    let first = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut first_bridge,
        VmLimits::default(),
    )
    .unwrap();
    let mut second_bridge = Bridge::default();
    let second = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut second_bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.steps.len(), 2);
    assert_eq!(first.steps[0].module, "agent.native.core");
    assert_eq!(first.steps[1].module, "agent.native.api");
    assert_eq!(first.steps[0].vm.outcome.code, 0);
    assert_eq!(first.steps[1].vm.outcome.code, 0);
    assert_eq!(first_bridge.calls, 2);
    assert_eq!(second_bridge.calls, 2);
    assert_eq!(serialize_project_execution_plan(&plan).unwrap(), plan_bytes);
    cleanup_two_module(&fixture);
}

#[test]
fn native_project_execution_plan_rejects_private_cycle_and_pin_drift_before_effect() {
    let fixture = make_two_module_fixture();
    let mut bridge = Bridge::default();
    let private = NativeProjectExecutionPlan::new("agent.native.api", "private", vec![]);
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &private,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-entry-not-exported");
    assert_eq!(bridge.calls, 0);

    let wrong_binding_target = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.api",
            "main",
            fixture.api_interface_digest.clone(),
            CONTRACT.to_owned(),
        )],
    );
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &wrong_binding_target,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-call-binding-module-mismatch");
    assert_eq!(bridge.calls, 0);

    let drift = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            CONTRACT.to_owned(),
        )],
    );
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &drift,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-call-interface-mismatch");
    assert_eq!(bridge.calls, 0);
    cleanup_two_module(&fixture);
}

#[test]
fn native_project_execution_serializer_surfaces_nested_authority_errors() {
    let fixture = make_two_module_fixture();
    let plan = NativeProjectExecutionPlan::new("agent.native.api", "main", vec![]);
    let mut bridge = Bridge::default();
    let mut execution = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    execution.steps[0].translation.schema = "re.tampered-translation@0.1.0".to_owned();

    let error = serialize_project_execution(&execution).unwrap_err();

    assert_eq!(error.code, "native-project-translation-digest-mismatch");
    cleanup_two_module(&fixture);
}

struct Fixture {
    root: PathBuf,
    cache: PathBuf,
    build: PathBuf,
}

struct TwoModuleFixture {
    root: PathBuf,
    cache: PathBuf,
    build: PathBuf,
    core_interface_digest: String,
    api_interface_digest: String,
}

fn make_fixture() -> Fixture {
    let root = temp_root("project");
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
                vec![NativeExport::function("main", CONTRACT)],
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
    let cache = root.with_file_name(format!(
        "{}-cache",
        root.file_name().unwrap().to_string_lossy()
    ));
    let build = root.with_file_name(format!(
        "{}-build",
        root.file_name().unwrap().to_string_lossy()
    ));
    Fixture { root, cache, build }
}

fn make_two_module_fixture() -> TwoModuleFixture {
    let root = temp_root("two-module");
    fs::create_dir_all(root.join("modules")).unwrap();
    fs::write(root.join("modules/core.re"), SOURCE).unwrap();
    fs::write(root.join("modules/api.re"), SOURCE).unwrap();
    let core_source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    let core_interface = NativeInterface::new(
        "agent.native.core",
        vec![],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.native.api",
        vec![revia_core::project::NativeDependency::package(
            "core",
            core_interface_digest.clone(),
            "agent.native.core",
        )],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let api_interface_digest = api_interface.digest().unwrap();
    let package = NativePackage::new(
        "agent.native",
        vec![
            NativeModule::new(
                "agent.native.core",
                core_source_digest.clone(),
                core_interface,
            ),
            NativeModule::new(
                "agent.native.api",
                core_source_digest.clone(),
                api_interface,
            ),
        ],
    );
    let modules = vec![
        NativeProjectModule::new(
            "agent.native.core",
            "modules/core.re",
            core_source_digest.clone(),
        ),
        NativeProjectModule::new("agent.native.api", "modules/api.re", core_source_digest),
    ];
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(&modules, &package).unwrap(),
    )
    .unwrap();
    TwoModuleFixture {
        cache: root.with_file_name(format!(
            "{}-cache",
            root.file_name().unwrap().to_string_lossy()
        )),
        build: root.with_file_name(format!(
            "{}-build",
            root.file_name().unwrap().to_string_lossy()
        )),
        root,
        core_interface_digest,
        api_interface_digest,
    }
}

fn cleanup_paths(root: &Path, cache: &Path, build: &Path) {
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(cache);
    let _ = fs::remove_dir_all(build);
}

fn cleanup(fixture: &Fixture) {
    cleanup_paths(&fixture.root, &fixture.cache, &fixture.build);
}

fn cleanup_two_module(fixture: &TwoModuleFixture) {
    cleanup_paths(&fixture.root, &fixture.cache, &fixture.build);
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp261-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
