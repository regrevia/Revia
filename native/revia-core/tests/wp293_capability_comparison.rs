use revia_core::capability_comparison::{
    CAPABILITY_COMPARISON_CATALOG_SCHEMA, CapabilityComparisonCatalog, CapabilityComparisonReport,
    CapabilityComparisonWorkload, CapabilitySandboxFile, parse_capability_comparison_catalog,
    serialize_capability_comparison_catalog,
};
use revia_core::graph::{check_graph, parse_compact_graph, serialize_canonical_graph};

const INPUT_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE: &str = include_str!("../../../examples/read-check.re");

fn canonical_source() -> String {
    let graph = parse_compact_graph(SOURCE, "examples/read-check.re").unwrap();
    serialize_canonical_graph(&check_graph(graph).unwrap()).unwrap()
}

#[test]
fn capability_catalog_round_trips_explicit_sandbox_authority() {
    let catalog = CapabilityComparisonCatalog::new(vec![CapabilityComparisonWorkload::new(
        "read-existing",
        "fs.read@0.1.0.read_file",
        canonical_source(),
        INPUT_DIGEST,
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        0,
    )]);

    let source = serialize_capability_comparison_catalog(&catalog).unwrap();
    assert!(source.contains(CAPABILITY_COMPARISON_CATALOG_SCHEMA));
    let parsed = parse_capability_comparison_catalog(&source).unwrap();
    assert_eq!(parsed, catalog);

    let mut drifted = parsed;
    drifted.workloads[0].sandbox_before[0].bytes_hex = "hex:6869".to_owned();
    assert_eq!(
        serialize_capability_comparison_catalog(&drifted)
            .unwrap_err()
            .code,
        "native-capability-comparison-sandbox-authority-mismatch"
    );
}

#[test]
fn capability_catalog_rejects_operation_and_path_authority_drift() {
    let source = serialize_canonical_graph(
        &check_graph(parse_compact_graph(SOURCE, "examples/read-check.re").unwrap()).unwrap(),
    )
    .unwrap();
    let mut workload = CapabilityComparisonWorkload::new(
        "read-existing",
        "process.args@0.1.0.read",
        source,
        INPUT_DIGEST,
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        0,
    );
    let catalog = CapabilityComparisonCatalog::new(vec![workload.clone()]);
    assert_eq!(
        serialize_capability_comparison_catalog(&catalog)
            .unwrap_err()
            .code,
        "native-capability-comparison-operation-authority-mismatch"
    );

    workload.operation = "fs.read@0.1.0.read_file".to_owned();
    workload.sandbox_before[0].path = "../outside.txt".to_owned();
    assert_eq!(
        serialize_capability_comparison_catalog(&CapabilityComparisonCatalog::new(vec![workload]))
            .unwrap_err()
            .code,
        "native-capability-comparison-sandbox-invalid"
    );
}

#[test]
fn capability_report_requires_exact_direct_and_bundle_authority() {
    let catalog = CapabilityComparisonCatalog::new(vec![CapabilityComparisonWorkload::new(
        "read-existing",
        "fs.read@0.1.0.read_file",
        canonical_source(),
        INPUT_DIGEST,
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        0,
    )]);
    let report = CapabilityComparisonReport::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        Vec::new(),
    );
    assert_eq!(
        revia_core::capability_comparison::serialize_capability_comparison_report(
            &catalog, &report
        )
        .unwrap_err()
        .code,
        "native-capability-comparison-report-authority-invalid"
    );
}
