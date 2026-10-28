use revia_core::{
    digest::sha256_hex,
    node_free::{
        NODE_FREE_BENCHMARK_SCHEMA, NODE_FREE_REPORT_SCHEMA, NativeCandidate, NativeGateError,
        NativeSample, NativeWorkloadEvidence, NodeFreeReport, serialize_node_free_report,
        stable_digest, workload_digest, workload_semantic_digest,
    },
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn report() -> NodeFreeReport {
    let workloads = [
        "check",
        "translate",
        "run",
        "project-init",
        "project-check",
        "project-test",
        "project-build",
        "project-translate",
        "project-run",
        "server-smoke",
        "project-server-smoke",
        "project-execute-plan",
        "project-execute-plan-direct",
        "project-execute-plan-cached",
    ]
    .into_iter()
    .map(|command| NativeWorkloadEvidence {
        command: command.to_owned(),
        exit_code: 0,
        output_digest: DIGEST_B.to_owned(),
        semantic_digest: DIGEST_B.to_owned(),
        status: "passed".to_owned(),
    })
    .collect::<Vec<_>>();
    let sample_semantic_digest = workload_semantic_digest(&workloads);
    let sample_workload_digest = workload_digest(&workloads);
    let samples = (0..3)
        .map(|round| NativeSample {
            adapter_overhead_ns: 3,
            cold_build_ns: 10,
            p50_ns: 20,
            p95_ns: 30,
            p99_ns: 40,
            peak_rss_bytes: 50,
            project_overhead_ns: 7,
            round,
            semantic_digest: sample_semantic_digest.clone(),
            startup_ns: 5,
            throughput_ops_per_sec_milli: 1000,
            warm_build_ns: 6,
            workload_digest: sample_workload_digest.clone(),
        })
        .collect::<Vec<_>>();
    let mut value = NodeFreeReport {
        benchmark_schema: NODE_FREE_BENCHMARK_SCHEMA.to_owned(),
        binary_digest: DIGEST_A.to_owned(),
        candidate_status: vec![
            NativeCandidate::measured("native", 3),
            NativeCandidate::pending("go", "not-measured"),
            NativeCandidate::pending("jvm", "not-measured"),
            NativeCandidate::pending("node", "oracle-only"),
        ],
        dependency_scan: "test-static-scan".to_owned(),
        evidence_digest: String::new(),
        node_import_count: 0,
        node_load_count: 0,
        node_process_count: 0,
        performance_eligible: false,
        process_count: 8,
        profile_digest: DIGEST_C.to_owned(),
        production_claim: false,
        release_build: true,
        report_schema: NODE_FREE_REPORT_SCHEMA.to_owned(),
        samples,
        semantic_mismatch_count: 0,
        source_inventory_digest: DIGEST_B.to_owned(),
        source_js_file_count: 0,
        stable_digest: String::new(),
        stable_v1_claim: false,
        toolchain_digest: DIGEST_C.to_owned(),
        workloads,
    };
    value.stable_digest = stable_digest(&value);
    value.evidence_digest = value.computed_evidence_digest();
    value
}

#[test]
fn node_free_report_is_path_free_and_deterministic() {
    let first = serialize_node_free_report(&report()).unwrap();
    let second = serialize_node_free_report(&report()).unwrap();
    assert_eq!(first, second);
    assert!(!first.contains("/Users/") && !first.contains("\\"));
    assert!(first.contains("re.native-node-free-report@0.1.0"));
    assert!(first.contains("re.native-node-free-benchmark@0.1.0"));
    assert!(first.contains("\"project_overhead_ns\""));
}

#[test]
fn node_free_report_rejects_pending_candidate_promotion_and_metric_drift() {
    let mut promoted = report();
    promoted.candidate_status[1] = NativeCandidate::measured("go", 3);
    promoted.stable_digest = stable_digest(&promoted);
    promoted.evidence_digest = promoted.computed_evidence_digest();
    assert_eq!(
        serialize_node_free_report(&promoted).unwrap_err(),
        NativeGateError::new("node-free-candidate-status-invalid")
    );

    let mut drifted = report();
    drifted.samples[0].p95_ns = 1;
    drifted.evidence_digest = drifted.computed_evidence_digest();
    assert_eq!(
        serialize_node_free_report(&drifted).unwrap_err(),
        NativeGateError::new("node-free-metric-order-invalid")
    );
}

#[test]
fn node_free_report_rejects_semantic_digest_and_authority_tampering() {
    let mut tampered = report();
    tampered.workloads[0].semantic_digest = format!("sha256:{}", sha256_hex(b"wrong"));
    tampered.stable_digest = stable_digest(&tampered);
    tampered.evidence_digest = tampered.computed_evidence_digest();
    assert_eq!(
        serialize_node_free_report(&tampered).unwrap_err(),
        NativeGateError::new("node-free-semantic-mismatch")
    );

    let mut authority = report();
    authority.binary_digest = DIGEST_B.to_owned();
    assert_eq!(
        serialize_node_free_report(&authority).unwrap_err(),
        NativeGateError::new("node-free-evidence-digest-mismatch")
    );
}
