use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeDependency, NativeExport, NativeInterface, NativeModule, NativePackage,
        NativeProjectModule, serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, NativeProjectExecutionStep, NativeProjectHandoff,
        execute_project_execution_plan, serialize_project_execution,
        serialize_project_execution_plan,
    },
    vm::{
        CapabilityBridge, CapabilityResponse, VmLimits, VmValue, serialize_vm_value,
        vm_value_digest,
    },
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
    received: Vec<Option<VmValue>>,
}

impl CapabilityBridge for Bridge {
    fn invoke(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        Ok(CapabilityResponse::ok(VmValue::Unit))
    }

    fn invoke_with_input(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &BTreeMap<String, VmValue>,
        _invocation_id: &str,
        input: Option<&VmValue>,
    ) -> Result<CapabilityResponse, String> {
        self.calls += 1;
        self.received.push(input.cloned());
        if self.calls == 1 {
            Ok(CapabilityResponse::ok(VmValue::Text(
                "core-output".to_owned(),
            )))
        } else if input == Some(&VmValue::Text("core-output".to_owned())) {
            Ok(CapabilityResponse::ok(VmValue::Unit))
        } else {
            Err("handoff-not-received".to_owned())
        }
    }
}

#[test]
fn native_execution_handoff_uses_the_previous_vm_value_and_is_canonical() {
    let fixture = make_fixture();
    let value = VmValue::Text("core-output".to_owned());
    let handoff = NativeProjectHandoff::new("text.utf8", 128, vm_value_digest(&value));
    let plan = NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            fixture.core_interface_digest.clone(),
            CONTRACT,
        )],
    )
    .with_root_handoff(handoff);

    let plan_source = serialize_project_execution_plan(&plan).unwrap();
    assert_eq!(
        revia_core::project_runtime::parse_project_execution_plan(&plan_source).unwrap(),
        plan
    );
    let mut bridge = Bridge::default();
    let execution = execute_project_execution_plan(
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

    assert_eq!(bridge.calls, 2);
    assert_eq!(bridge.received, vec![None, Some(value.clone())]);
    assert_eq!(execution.handoffs.len(), 1);
    assert_eq!(execution.handoffs[0].type_name, "text.utf8");
    assert_eq!(execution.handoffs[0].value, serialize_vm_value(&value));
    assert_eq!(execution.handoffs[0].value_digest, vm_value_digest(&value));
    cleanup(&fixture);
}

#[test]
fn native_execution_handoff_rejects_type_digest_and_size_drift_before_target_effect() {
    let fixture = make_fixture();
    let value = VmValue::Text("core-output".to_owned());

    let wrong_type = plan_with_handoff(
        &fixture,
        NativeProjectHandoff::new("bytes", 128, vm_value_digest(&value)),
    );
    let mut type_bridge = Bridge::default();
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &wrong_type,
        INPUT,
        &mut type_bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-value-handoff-type-mismatch");
    assert_eq!(type_bridge.calls, 1);

    let wrong_digest = plan_with_handoff(
        &fixture,
        NativeProjectHandoff::new(
            "text.utf8",
            128,
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ),
    );
    let mut digest_bridge = Bridge::default();
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &wrong_digest,
        INPUT,
        &mut digest_bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-value-handoff-digest-mismatch");
    assert_eq!(digest_bridge.calls, 1);

    let oversized = plan_with_handoff(
        &fixture,
        NativeProjectHandoff::new("text.utf8", 1, vm_value_digest(&value)),
    );
    let mut size_bridge = Bridge::default();
    let error = execute_project_execution_plan(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        PROFILE,
        TOOLCHAIN,
        &oversized,
        INPUT,
        &mut size_bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-value-handoff-too-large");
    assert_eq!(size_bridge.calls, 1);
    cleanup(&fixture);
}

#[test]
fn native_execution_handoff_rejects_zero_bound_before_any_effect() {
    let fixture = make_fixture();
    let value = VmValue::Text("core-output".to_owned());
    let plan = plan_with_handoff(
        &fixture,
        NativeProjectHandoff::new("text.utf8", 0, vm_value_digest(&value)),
    );
    let mut bridge = Bridge::default();
    let error = execute_project_execution_plan(
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
    .unwrap_err();
    assert_eq!(error.code, "native-project-value-handoff-bound-invalid");
    assert_eq!(bridge.calls, 0);
    cleanup(&fixture);
}

#[test]
fn native_execution_serializer_rejects_resigned_handoff_type_drift() {
    let fixture = make_fixture();
    let value = VmValue::Text("core-output".to_owned());
    let plan = plan_with_handoff(
        &fixture,
        NativeProjectHandoff::new("text.utf8", 128, vm_value_digest(&value)),
    );
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
    execution.handoffs[0].type_name = "bytes".to_owned();
    execution.handoffs[0].value_digest = format!(
        "sha256:{}",
        sha256_hex(execution.handoffs[0].value.as_bytes())
    );

    let error = serialize_project_execution(&execution).unwrap_err();
    assert_eq!(error.code, "native-project-value-handoff-value-mismatch");
    let _ = serialize_project_execution_plan(&plan).unwrap();
    cleanup(&fixture);
}

fn plan_with_handoff(
    fixture: &Fixture,
    handoff: NativeProjectHandoff,
) -> NativeProjectExecutionPlan {
    NativeProjectExecutionPlan::new(
        "agent.native.api",
        "main",
        vec![NativeProjectExecutionStep::new(
            "core",
            "agent.native.core",
            "main",
            fixture.core_interface_digest.clone(),
            CONTRACT,
        )],
    )
    .with_root_handoff(handoff)
}

struct Fixture {
    root: PathBuf,
    cache: PathBuf,
    build: PathBuf,
    core_interface_digest: String,
}

fn make_fixture() -> Fixture {
    let root = temp_root("project");
    fs::create_dir_all(root.join("modules")).unwrap();
    fs::write(root.join("modules/core.re"), SOURCE).unwrap();
    fs::write(root.join("modules/api.re"), SOURCE).unwrap();
    let source_digest = format!("sha256:{}", sha256_hex(SOURCE.as_bytes()));
    let core_interface = NativeInterface::new(
        "agent.native.core",
        vec![],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let core_interface_digest = core_interface.digest().unwrap();
    let api_interface = NativeInterface::new(
        "agent.native.api",
        vec![NativeDependency::package(
            "core",
            core_interface_digest.clone(),
            "agent.native.core",
        )],
        vec![NativeExport::function("main", CONTRACT)],
    );
    let package = NativePackage::new(
        "agent.native",
        vec![
            NativeModule::new("agent.native.core", source_digest.clone(), core_interface),
            NativeModule::new("agent.native.api", source_digest.clone(), api_interface),
        ],
    );
    fs::write(
        root.join("project.json"),
        serialize_project_manifest(
            &[
                NativeProjectModule::new(
                    "agent.native.core",
                    "modules/core.re",
                    source_digest.clone(),
                ),
                NativeProjectModule::new("agent.native.api", "modules/api.re", source_digest),
            ],
            &package,
        )
        .unwrap(),
    )
    .unwrap();
    Fixture {
        cache: root.with_file_name(format!(
            "{}-cache",
            root.file_name().unwrap().to_string_lossy()
        )),
        build: root.with_file_name(format!(
            "{}-build",
            root.file_name().unwrap().to_string_lossy()
        )),
        core_interface_digest,
        root,
    }
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp271-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(fixture: &Fixture) {
    let _ = fs::remove_dir_all(&fixture.root);
    let _ = fs::remove_dir_all(&fixture.cache);
    let _ = fs::remove_dir_all(&fixture.build);
}
