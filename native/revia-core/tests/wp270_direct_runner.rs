use revia_core::{
    project_runtime::{
        NativeProjectExecutionPlan, execute_project_execution_plan,
        execute_project_execution_plan_direct, serialize_project_execution,
    },
    vm::{CapabilityBridge, CapabilityResponse, VmLimits, VmValue},
};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const PROFILE: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const INPUT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const MODULE: &str = "agent.enterprise.m000";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct Bridge;

impl CapabilityBridge for Bridge {
    fn invoke(
        &mut self,
        _instance: &str,
        _member: &str,
        _arguments: &std::collections::BTreeMap<String, VmValue>,
        _invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        Ok(CapabilityResponse::ok(VmValue::Unit))
    }
}

#[test]
fn native_direct_project_execution_matches_plan_execution_byte_for_byte() {
    let plan = NativeProjectExecutionPlan::new(MODULE, "main", Vec::new());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let first_workspace = temp_root("plan");
    let second_workspace = temp_root("direct");

    let mut first_bridge = Bridge;
    let expected = execute_project_execution_plan(
        root.join(PROJECT),
        first_workspace.join("cache"),
        first_workspace.join("build"),
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut first_bridge,
        VmLimits::default(),
    )
    .unwrap();

    let mut second_bridge = Bridge;
    let actual = execute_project_execution_plan_direct(
        root.join(PROJECT),
        second_workspace.join("cache"),
        second_workspace.join("build"),
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut second_bridge,
        VmLimits::default(),
    )
    .unwrap();

    assert_eq!(
        serialize_project_execution(&expected).unwrap(),
        serialize_project_execution(&actual).unwrap()
    );
    cleanup(&first_workspace);
    cleanup(&second_workspace);
}

fn temp_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp270-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(path: &std::path::Path) {
    let _ = fs::remove_dir_all(path);
}
