use std::collections::BTreeMap;

use revia_core::{
    comparison_catalog::{
        ComparisonApplicability, ComparisonCatalog, ComparisonObservation, ComparisonWorkload,
        build_comparison_report, comparison_semantic_digest, parse_comparison_catalog,
        serialize_comparison_catalog, serialize_comparison_report,
    },
    cross_language::{CrossLanguageBackendResult, CrossLanguageInvocation},
    digest::sha256_hex,
    graph::{graph_revision, load_canonical_graph},
    replay::{NativeReplayTranscript, serialize_native_replay_transcript},
    vm::{CapabilityResponse, VmValue},
};

const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(Vec::new())).unwrap()
}

fn stdout_transcript(response: CapabilityResponse) -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(vec![
        revia_core::replay::NativeReplayInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            BTreeMap::from([(
                "data".to_owned(),
                VmValue::Text("Hello, World!\n".to_owned()),
            )]),
            response,
        ),
    ]))
    .unwrap()
}

fn closed_error_transcript() -> String {
    stdout_transcript(CapabilityResponse::err(VmValue::Unit))
}

fn host_fault_transcript() -> String {
    stdout_transcript(CapabilityResponse::host_fault("host-fault-injected"))
}

fn node_result() -> CrossLanguageBackendResult {
    let graph = graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap();
    let transcript_digest = digest(transcript().as_bytes());
    CrossLanguageBackendResult::measured(
        "node",
        graph,
        INPUT,
        transcript_digest,
        TOOLCHAIN,
        "",
        digest(b"node-receipt"),
        0,
        "process.status",
        vec![CrossLanguageInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            "ok",
        )],
        "",
    )
}

fn catalog() -> ComparisonCatalog {
    ComparisonCatalog::new(vec![
        ComparisonWorkload::new(
            "success",
            "success",
            SOURCE,
            INPUT,
            transcript(),
            None,
            None,
            ComparisonApplicability::all(),
            Some(node_result()),
        ),
        ComparisonWorkload::new(
            "closed-error",
            "closed-error",
            SOURCE,
            INPUT,
            closed_error_transcript(),
            None,
            None,
            ComparisonApplicability::native_result_and_receipt(),
            None,
        ),
        ComparisonWorkload::new(
            "host-boundary",
            "host-boundary",
            SOURCE,
            INPUT,
            host_fault_transcript(),
            None,
            None,
            ComparisonApplicability {
                semantic: false,
                result: false,
                receipt: false,
            },
            None,
        ),
        ComparisonWorkload::new(
            "project-workflow",
            "project-workflow",
            SOURCE,
            INPUT,
            transcript(),
            Some(PROJECT.to_owned()),
            Some("agent.enterprise.m000".to_owned()),
            ComparisonApplicability::all(),
            Some(node_result()),
        ),
    ])
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn native_result(transcript_source: &str) -> CrossLanguageBackendResult {
    let graph = graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap();
    CrossLanguageBackendResult::measured(
        "native",
        graph,
        INPUT,
        digest(transcript_source.as_bytes()),
        TOOLCHAIN,
        "",
        digest(b"native-receipt"),
        0,
        "process.status",
        vec![CrossLanguageInvocation::new(
            "@stdout",
            "write",
            "aaaaaadaaaaaaaaaaaaaaaaaaa",
            "ok",
        )],
        "",
    )
}

#[test]
fn comparison_catalog_round_trips_four_domains_and_report_is_canonical() {
    let catalog = catalog();
    let source = serialize_comparison_catalog(&catalog).unwrap();
    let parsed = parse_comparison_catalog(&source).unwrap();
    assert_eq!(serialize_comparison_catalog(&parsed).unwrap(), source);

    let report = build_comparison_report(
        &catalog,
        catalog
            .workloads
            .iter()
            .map(|workload| {
                let transcript_digest = digest(workload.transcript.as_bytes());
                if workload.kind == "host-boundary" {
                    ComparisonObservation::fault(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        "host-fault-injected",
                    )
                } else {
                    ComparisonObservation::new(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        native_result(&workload.transcript),
                        workload.node_result.clone(),
                    )
                }
            })
            .collect(),
    )
    .unwrap();
    let report_source = serialize_comparison_report(&report).unwrap();
    assert!(report_source.contains("project-workflow"));
    assert!(report_source.contains("semantic"));
}

#[test]
fn comparison_catalog_rejects_missing_duplicate_unknown_and_project_authority() {
    let mut duplicate = catalog();
    duplicate.workloads[1].workload_id = duplicate.workloads[0].workload_id.clone();
    assert!(serialize_comparison_catalog(&duplicate).is_err());

    let mut missing = catalog();
    missing.workloads.pop();
    assert!(serialize_comparison_catalog(&missing).is_err());

    let mut project_drift = catalog();
    project_drift.workloads[3].project_module = None;
    assert!(serialize_comparison_catalog(&project_drift).is_err());
}

#[test]
fn comparison_catalog_rejects_applicability_and_backend_authority_drift() {
    let mut semantic_without_node = catalog();
    semantic_without_node.workloads[0].node_result = None;
    assert!(serialize_comparison_catalog(&semantic_without_node).is_err());

    let mut unknown_backend = catalog();
    unknown_backend.workloads[0]
        .node_result
        .as_mut()
        .unwrap()
        .backend = "go".to_owned();
    assert!(serialize_comparison_catalog(&unknown_backend).is_err());

    let mut pending_promotion = catalog();
    pending_promotion.workloads[1].applicability.semantic = true;
    assert!(serialize_comparison_catalog(&pending_promotion).is_err());
}

#[test]
fn comparison_report_rejects_reused_result_and_receipt_or_fixture_digests() {
    let catalog = catalog();
    let mut report = build_comparison_report(
        &catalog,
        catalog
            .workloads
            .iter()
            .map(|workload| {
                let transcript_digest = digest(workload.transcript.as_bytes());
                if workload.kind == "host-boundary" {
                    ComparisonObservation::fault(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        "host-fault-injected",
                    )
                } else {
                    ComparisonObservation::new(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        native_result(&workload.transcript),
                        workload.node_result.clone(),
                    )
                }
            })
            .collect(),
    )
    .unwrap();
    report.observations[0]
        .native_result
        .as_mut()
        .unwrap()
        .result_digest = report.observations[0]
        .node_result
        .as_ref()
        .unwrap()
        .result_digest
        .clone();
    assert!(serialize_comparison_report(&report).is_err());
}

#[test]
fn comparison_report_rejects_node_and_host_fault_authority_drift() {
    let catalog = catalog();
    let mut report = build_comparison_report(
        &catalog,
        catalog
            .workloads
            .iter()
            .map(|workload| {
                let transcript_digest = digest(workload.transcript.as_bytes());
                if workload.kind == "host-boundary" {
                    ComparisonObservation::fault(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        "host-fault-injected",
                    )
                } else {
                    ComparisonObservation::new(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        native_result(&workload.transcript),
                        workload.node_result.clone(),
                    )
                }
            })
            .collect(),
    )
    .unwrap();
    report.observations[0]
        .node_result
        .as_mut()
        .unwrap()
        .receipt_digest = digest(b"node-authority-drift");
    assert!(serialize_comparison_report(&report).is_err());

    let mut report = build_comparison_report(
        &catalog,
        catalog
            .workloads
            .iter()
            .map(|workload| {
                let transcript_digest = digest(workload.transcript.as_bytes());
                if workload.kind == "host-boundary" {
                    ComparisonObservation::fault(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        "host-fault-injected",
                    )
                } else {
                    ComparisonObservation::new(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        native_result(&workload.transcript),
                        workload.node_result.clone(),
                    )
                }
            })
            .collect(),
    )
    .unwrap();
    let host_index = report
        .observations
        .iter()
        .position(|observation| observation.kind == "host-boundary")
        .unwrap();
    report.observations[host_index].native_fault_code = Some("different-fault".to_owned());
    assert!(serialize_comparison_report(&report).is_err());
}

#[test]
fn comparison_semantic_digest_is_bound_to_catalog_observations() {
    let catalog = catalog();
    let report = build_comparison_report(
        &catalog,
        catalog
            .workloads
            .iter()
            .map(|workload| {
                let transcript_digest = digest(workload.transcript.as_bytes());
                if workload.kind == "host-boundary" {
                    ComparisonObservation::fault(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        "host-fault-injected",
                    )
                } else {
                    ComparisonObservation::new(
                        workload,
                        graph_revision(&load_canonical_graph(SOURCE).unwrap()).unwrap(),
                        transcript_digest,
                        native_result(&workload.transcript),
                        workload.node_result.clone(),
                    )
                }
            })
            .collect(),
    )
    .unwrap();
    let first = comparison_semantic_digest(&catalog, &report).unwrap();
    let second = comparison_semantic_digest(&catalog, &report).unwrap();
    assert_eq!(first, second);

    let mut changed_catalog = catalog.clone();
    let original = changed_catalog.workloads[0].node_result.as_ref().unwrap();
    changed_catalog.workloads[0].node_result = Some(CrossLanguageBackendResult::measured(
        "node",
        original.graph_revision.clone(),
        original.input_digest.clone(),
        original.transcript_digest.clone(),
        original.toolchain_digest.clone(),
        "",
        original.receipt_digest.clone(),
        1,
        original.outcome_type.clone(),
        original.invocations.clone(),
        "",
    ));
    let changed = build_comparison_report(
        &changed_catalog,
        report
            .observations
            .iter()
            .enumerate()
            .map(|(index, observation)| {
                if observation.kind == "host-boundary" {
                    observation.clone()
                } else if observation.workload_id == "success" {
                    let native = observation.native_result.as_ref().unwrap();
                    ComparisonObservation::new(
                        &changed_catalog.workloads[index],
                        observation.graph_revision.clone(),
                        observation.transcript_digest.clone(),
                        CrossLanguageBackendResult::measured(
                            "native",
                            native.graph_revision.clone(),
                            native.input_digest.clone(),
                            native.transcript_digest.clone(),
                            native.toolchain_digest.clone(),
                            "",
                            native.receipt_digest.clone(),
                            1,
                            native.outcome_type.clone(),
                            native.invocations.clone(),
                            "",
                        ),
                        changed_catalog.workloads[index].node_result.clone(),
                    )
                } else {
                    observation.clone()
                }
            })
            .collect(),
    )
    .unwrap();
    assert_ne!(
        first,
        comparison_semantic_digest(&changed_catalog, &changed).unwrap()
    );
}
