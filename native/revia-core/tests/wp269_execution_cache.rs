use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    digest::sha256_hex,
    project::{
        NativeExport, NativeInterface, NativeModule, NativePackage, NativeProjectModule,
        serialize_project_manifest,
    },
    project_runtime::{
        NativeProjectExecutionPlan, execute_project_execution_plan_cached,
        serialize_project_execution_plan,
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
fn native_project_execution_cache_has_cold_miss_warm_hit_and_plan_drift_rebuild() {
    let fixture = make_fixture();
    let plan = NativeProjectExecutionPlan::new("agent.native.main", "main", Vec::new());
    let plan_source = serialize_project_execution_plan(&plan).unwrap();
    assert!(plan_source.contains("plan_digest"));

    let mut bridge = Bridge;
    let cold = execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert!(!cold.cache_hit);
    assert!(cold.artifact_digest.starts_with("sha256:"));
    assert!(fixture.execution_cache.is_file());

    let mut bridge = Bridge;
    let warm = execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert!(warm.cache_hit);
    assert_eq!(warm.execution, cold.execution);
    assert_eq!(warm.artifact_digest, cold.artifact_digest);

    let profile_drift = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let drifted = execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
        profile_drift,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    assert!(!drifted.cache_hit);
    assert_eq!(drifted.execution.profile_digest, profile_drift);
    assert_ne!(drifted.execution, warm.execution);
    cleanup(&fixture);
}

#[test]
fn native_project_execution_cache_corruption_fails_closed_without_rebuild() {
    let fixture = make_fixture();
    let plan = NativeProjectExecutionPlan::new("agent.native.main", "main", Vec::new());
    let mut bridge = Bridge;
    execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap();
    fs::write(&fixture.execution_cache, b"{}\n").unwrap();

    let error = execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-execution-cache-corrupt");
    cleanup(&fixture);
}

#[cfg(unix)]
#[test]
fn native_project_execution_cache_rejects_symlink_parent_before_write() {
    use std::os::unix::fs::symlink;

    let fixture = make_fixture();
    let outside = fixture.root.with_file_name("revia-wp269-cache-outside");
    fs::create_dir_all(&outside).unwrap();
    let link = fixture.root.with_file_name("revia-wp269-cache-link");
    symlink(&outside, &link).unwrap();
    let cache_path = link.join("execution.json");
    let plan = NativeProjectExecutionPlan::new("agent.native.main", "main", Vec::new());
    let mut bridge = Bridge;
    let error = execute_project_execution_plan_cached(
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &cache_path,
        PROFILE,
        TOOLCHAIN,
        &plan,
        INPUT,
        &mut bridge,
        VmLimits::default(),
    )
    .unwrap_err();
    assert_eq!(error.code, "native-project-execution-cache-write-failure");
    assert!(!outside.join("execution.json").exists());
    let _ = fs::remove_file(&link);
    let _ = fs::remove_dir_all(&outside);
    cleanup(&fixture);
}

struct Fixture {
    root: PathBuf,
    cache: PathBuf,
    build: PathBuf,
    execution_cache: PathBuf,
}

fn make_fixture() -> Fixture {
    let root = temp_root();
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
    Fixture {
        cache: root.with_file_name(format!(
            "{}-module-cache",
            root.file_name().unwrap().to_string_lossy()
        )),
        build: root.with_file_name(format!(
            "{}-build",
            root.file_name().unwrap().to_string_lossy()
        )),
        execution_cache: root.with_file_name(format!(
            "{}-execution.json",
            root.file_name().unwrap().to_string_lossy()
        )),
        root,
    }
}

fn cleanup(fixture: &Fixture) {
    for path in [
        &fixture.root,
        &fixture.cache,
        &fixture.build,
        &fixture.execution_cache,
    ] {
        let _ = fs::remove_dir_all(path);
        let _ = fs::remove_file(path);
    }
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp269-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
