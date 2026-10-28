use revia_core::{
    comparison_catalog::{
        ComparisonObservation, build_comparison_report, parse_comparison_catalog,
    },
    digest::sha256_hex,
    experiment_kit::{
        ExperimentKit, build_experiment_kit, parse_experiment_kit, serialize_experiment_kit,
        validate_experiment_kit, validate_experiment_kit_against_report,
    },
    graph::{graph_revision, load_canonical_graph},
};

const CATALOG: &str = include_str!("../../../test/fixtures/native-comparison-catalog.json");
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn native_report() -> (
    revia_core::comparison_catalog::ComparisonCatalog,
    revia_core::comparison_catalog::ComparisonReport,
) {
    let catalog = parse_comparison_catalog(CATALOG).unwrap();
    let observations = catalog
        .workloads
        .iter()
        .map(|workload| {
            let graph = load_canonical_graph(&workload.source).unwrap();
            let revision = graph_revision(&graph).unwrap();
            let transcript_digest = digest(workload.transcript.as_bytes());
            if workload.kind == "host-boundary" {
                ComparisonObservation::fault(
                    workload,
                    revision,
                    transcript_digest,
                    "host-fault-injected",
                )
            } else {
                let native = revia_core::cross_language::CrossLanguageBackendResult::measured(
                    "native",
                    revision.clone(),
                    workload.input_digest.clone(),
                    transcript_digest.clone(),
                    TOOLCHAIN,
                    "",
                    digest(workload.workload_id.as_bytes()),
                    0,
                    "process.status",
                    Vec::new(),
                    "",
                );
                ComparisonObservation::new(workload, revision, transcript_digest, native, None)
            }
        })
        .collect();
    let report = build_comparison_report(&catalog, observations).unwrap();
    (catalog, report)
}

#[test]
fn experiment_kit_round_trip_has_non_empty_population_and_explicit_backend_partition() {
    let (catalog, report) = native_report();
    let kit = build_experiment_kit(&catalog, &report, "darwin-arm64", TOOLCHAIN).unwrap();
    assert_eq!(kit.workloads.len(), 4);
    for workload in &kit.workloads {
        assert_eq!(workload.backends.len(), 4);
        assert_eq!(workload.backends[0].backend, "native");
        assert_eq!(
            workload.backends[0].status,
            if workload.kind == "host-boundary" {
                "fault-observed"
            } else {
                "measured"
            }
        );
        assert_eq!(
            workload.backends[1..]
                .iter()
                .map(|backend| (backend.backend.as_str(), backend.status.as_str()))
                .collect::<Vec<_>>(),
            vec![("node", "pending"), ("go", "pending"), ("jvm", "pending")]
        );
        assert_eq!(
            workload
                .backends
                .iter()
                .map(|backend| backend.timing_status.as_str())
                .collect::<Vec<_>>(),
            vec!["not-measured"; 4]
        );
    }
    let source = serialize_experiment_kit(&kit).unwrap();
    assert_eq!(
        serialize_experiment_kit(&parse_experiment_kit(&source).unwrap()).unwrap(),
        source
    );
}

#[test]
fn experiment_kit_rejects_empty_population_and_prose_only_measured_result() {
    let empty = ExperimentKit::new(Vec::new());
    assert!(validate_experiment_kit(&empty).is_err());

    let (catalog, report) = native_report();
    let mut kit = build_experiment_kit(&catalog, &report, "darwin-arm64", TOOLCHAIN).unwrap();
    kit.workloads[0].backends[0].result_digest = None;
    assert!(validate_experiment_kit(&kit).is_err());
}

#[test]
fn experiment_kit_rejects_wrong_target_and_copied_receipt_authority() {
    let (catalog, report) = native_report();
    let mut kit = build_experiment_kit(&catalog, &report, "darwin-arm64", TOOLCHAIN).unwrap();
    kit.workloads[0].backends[0].target = "linux-x64".to_owned();
    assert!(validate_experiment_kit(&kit).is_err());

    let mut kit = build_experiment_kit(&catalog, &report, "darwin-arm64", TOOLCHAIN).unwrap();
    kit.workloads[1].backends[0].receipt_digest =
        kit.workloads[0].backends[0].receipt_digest.clone();
    assert!(validate_experiment_kit(&kit).is_err());
}

#[test]
fn experiment_kit_binds_the_trusted_comparison_report() {
    let (catalog, report) = native_report();
    let kit = build_experiment_kit(&catalog, &report, "darwin-arm64", TOOLCHAIN).unwrap();
    assert_eq!(kit.comparison_report_digest, report.report_digest);
    validate_experiment_kit_against_report(&catalog, &report, &kit).unwrap();

    let mut changed_observations = report.observations.clone();
    let native = changed_observations[0].native_result.as_ref().unwrap();
    changed_observations[0].native_result = Some(
        revia_core::cross_language::CrossLanguageBackendResult::measured(
            "native",
            native.graph_revision.clone(),
            native.input_digest.clone(),
            native.transcript_digest.clone(),
            native.toolchain_digest.clone(),
            "",
            native.receipt_digest.clone(),
            native.outcome_code + 1,
            native.outcome_type.clone(),
            native.invocations.clone(),
            "",
        ),
    );
    let changed_report = build_comparison_report(&catalog, changed_observations).unwrap();
    assert_ne!(changed_report.report_digest, report.report_digest);
    assert!(validate_experiment_kit_against_report(&catalog, &changed_report, &kit).is_err());
}

#[test]
fn experiment_kit_validator_accepts_authority_bound_non_darwin_target() {
    let (catalog, report) = native_report();
    let kit = build_experiment_kit(&catalog, &report, "linux-x64", TOOLCHAIN).unwrap();
    validate_experiment_kit_against_report(&catalog, &report, &kit).unwrap();
    assert_eq!(kit.target, "linux-x64");
    assert!(
        kit.workloads
            .iter()
            .flat_map(|workload| workload.backends.iter())
            .filter(|backend| backend.backend == "native")
            .all(|backend| backend.target == "linux-x64")
    );
    assert!(build_experiment_kit(&catalog, &report, "", TOOLCHAIN).is_err());
}
