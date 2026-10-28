use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use revia_core::{
    comparison_catalog::{
        ComparisonApplicability, ComparisonCatalog, ComparisonWorkload,
        serialize_comparison_catalog,
    },
    graph::{check_graph, parse_compact_graph, serialize_canonical_graph},
    project::load_project_directory,
    replay::{NativeReplayInvocation, NativeReplayTranscript, serialize_native_replay_transcript},
    vm::{CapabilityResponse, VmValue},
};

const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const REPOSITORY_FIXTURE: &str =
    include_str!("../../../test/fixtures/native-comparison-catalog.json");
const PROJECT: &str = "test/fixtures/native-node-free-enterprise";
const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn repository_comparison_fixture_is_canonical_and_covers_the_four_domains() {
    let catalog = revia_core::comparison_catalog::parse_comparison_catalog(REPOSITORY_FIXTURE)
        .expect("repository comparison fixture must be canonical");
    assert_eq!(
        catalog
            .workloads
            .iter()
            .map(|workload| workload.kind.as_str())
            .collect::<Vec<_>>(),
        vec![
            "success",
            "closed-error",
            "host-boundary",
            "project-workflow"
        ]
    );
    assert_eq!(
        revia_core::comparison_catalog::serialize_comparison_catalog(&catalog).unwrap(),
        REPOSITORY_FIXTURE
    );
}

#[test]
fn comparison_catalog_cli_runs_four_workload_domains_path_free() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog_path = temp_path("catalog");
    let output_path = temp_path("report");
    let transcript = hello_transcript();
    let closed_error_transcript = args_error_transcript();
    let host_fault_transcript = host_fault_transcript();
    let project_digest = load_project_directory(root.join(PROJECT))
        .unwrap()
        .project_digest;
    let project_source = project_module_source(&root);
    let catalog = ComparisonCatalog::new(vec![
        workload(
            "success",
            "success",
            SOURCE,
            None,
            None,
            ComparisonApplicability::native_result_and_receipt(),
            transcript.clone(),
        ),
        workload(
            "closed-error",
            "closed-error",
            include_str!("../../../test/golden/canonical-args-check.re"),
            None,
            None,
            ComparisonApplicability::native_result_and_receipt(),
            closed_error_transcript,
        ),
        workload(
            "host-boundary",
            "host-boundary",
            SOURCE,
            None,
            None,
            ComparisonApplicability {
                semantic: false,
                result: false,
                receipt: false,
            },
            host_fault_transcript,
        ),
        workload(
            "project-workflow",
            "project-workflow",
            &project_source,
            Some(project_digest),
            Some("agent.enterprise.m000".to_owned()),
            ComparisonApplicability::native_result_and_receipt(),
            transcript,
        ),
    ]);
    fs::write(
        &catalog_path,
        serialize_comparison_catalog(&catalog).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&root)
        .args([
            "comparison-catalog",
            catalog_path.to_str().unwrap(),
            PROJECT,
            output_path.to_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = fs::read_to_string(&output_path).unwrap();
    assert!(report.contains("re.native-comparison-catalog-report@0.1.0"));
    assert!(report.contains("project-workflow"));
    assert!(!report.contains(root.to_str().unwrap()));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(root.to_str().unwrap()));
    cleanup(&catalog_path);
    cleanup(&output_path);
}

#[test]
fn comparison_catalog_cli_rejects_project_digest_drift_before_write() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalog_path = temp_path("drift-catalog");
    let output_path = temp_path("drift-report");
    let transcript = hello_transcript();
    let catalog = ComparisonCatalog::new(vec![
        workload(
            "success",
            "success",
            SOURCE,
            None,
            None,
            ComparisonApplicability::native_result_and_receipt(),
            transcript.clone(),
        ),
        workload(
            "closed-error",
            "closed-error",
            include_str!("../../../test/golden/canonical-args-check.re"),
            None,
            None,
            ComparisonApplicability::native_result_and_receipt(),
            args_error_transcript(),
        ),
        workload(
            "host-boundary",
            "host-boundary",
            SOURCE,
            None,
            None,
            ComparisonApplicability {
                semantic: false,
                result: false,
                receipt: false,
            },
            host_fault_transcript(),
        ),
        workload(
            "project-workflow",
            "project-workflow",
            &project_module_source(&root),
            Some(
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                    .to_owned(),
            ),
            Some("agent.enterprise.m000".to_owned()),
            ComparisonApplicability::native_result_and_receipt(),
            transcript,
        ),
    ]);
    fs::write(
        &catalog_path,
        serialize_comparison_catalog(&catalog).unwrap(),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_revia"))
        .current_dir(&root)
        .args([
            "comparison-catalog",
            catalog_path.to_str().unwrap(),
            PROJECT,
            output_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(!output_path.exists());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("comparison-catalog-project-digest-mismatch")
    );
    cleanup(&catalog_path);
    cleanup(&output_path);
}

fn workload(
    id: &str,
    kind: &str,
    source: &str,
    project_digest: Option<String>,
    module: Option<String>,
    applicability: ComparisonApplicability,
    transcript: String,
) -> ComparisonWorkload {
    ComparisonWorkload::new(
        id,
        kind,
        source,
        INPUT,
        transcript,
        project_digest,
        module,
        applicability,
        None,
    )
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "revia-wp284-{label}-{}-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn cleanup(path: &Path) {
    fs::remove_file(path).ok();
}

fn hello_transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(vec![
        NativeReplayInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            BTreeMap::from([(
                "data".to_owned(),
                VmValue::Text("Hello, World!\n".to_owned()),
            )]),
            CapabilityResponse::ok(VmValue::Unit),
        ),
    ]))
    .unwrap()
}

fn args_error_transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(vec![
        NativeReplayInvocation::new(
            "@args",
            "read",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            BTreeMap::new(),
            CapabilityResponse::err(VmValue::Unit),
        ),
    ]))
    .unwrap()
}

fn host_fault_transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(vec![
        NativeReplayInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            BTreeMap::from([(
                "data".to_owned(),
                VmValue::Text("Hello, World!\n".to_owned()),
            )]),
            CapabilityResponse::host_fault("host-fault-injected"),
        ),
    ]))
    .unwrap()
}

fn project_module_source(root: &Path) -> String {
    let source = fs::read_to_string(root.join(PROJECT).join("modules/m000.re")).unwrap();
    let graph = check_graph(parse_compact_graph(&source, "modules/m000.re").unwrap()).unwrap();
    serialize_canonical_graph(&graph).unwrap()
}
