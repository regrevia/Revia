use revia_core::{
    capability_comparison::CapabilitySandboxFile,
    capability_project_comparison::{
        CapabilityProjectComparisonCatalog, CapabilityProjectComparisonWorkload,
        parse_capability_project_comparison_catalog,
        serialize_capability_project_comparison_catalog,
    },
    graph::{check_graph, parse_compact_graph, serialize_canonical_graph},
};

const INPUT_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE: &str = include_str!("../../../examples/read-check.re");

fn canonical_source() -> String {
    let graph = parse_compact_graph(SOURCE, "examples/read-check.re").unwrap();
    serialize_canonical_graph(&check_graph(graph).unwrap()).unwrap()
}

#[test]
fn project_catalog_round_trips_explicit_module_authority() {
    let catalog =
        CapabilityProjectComparisonCatalog::new(vec![CapabilityProjectComparisonWorkload::new(
            "read-existing",
            "revia.capability.read_existing",
            "modules/read.re",
            canonical_source(),
            "fs.read@0.1.0.read_file",
            INPUT_DIGEST,
            vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
            vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
            0,
        )]);

    let source = serialize_capability_project_comparison_catalog(&catalog).unwrap();
    let parsed = parse_capability_project_comparison_catalog(&source).unwrap();
    assert_eq!(parsed, catalog);

    let mut drifted = parsed;
    drifted.workloads[0].source_sha256 =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert_eq!(
        serialize_capability_project_comparison_catalog(&drifted)
            .unwrap_err()
            .code,
        "native-capability-project-comparison-source-digest-mismatch"
    );
}

#[test]
fn project_catalog_rejects_ambiguous_module_paths_and_sandbox_overlap() {
    let workload = CapabilityProjectComparisonWorkload::new(
        "read-existing",
        "revia.capability.read_existing",
        "modules/read.re",
        canonical_source(),
        "fs.read@0.1.0.read_file",
        INPUT_DIGEST,
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        0,
    );
    let duplicate_path = CapabilityProjectComparisonWorkload::new(
        "read-other",
        "revia.capability.read_other",
        "modules/read.re",
        canonical_source(),
        "fs.read@0.1.0.read_file",
        INPUT_DIGEST,
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        vec![CapabilitySandboxFile::new("input.txt", b"hello\n")],
        0,
    );
    assert_eq!(
        serialize_capability_project_comparison_catalog(&CapabilityProjectComparisonCatalog::new(
            vec![workload.clone(), duplicate_path]
        ))
        .unwrap_err()
        .code,
        "native-capability-project-comparison-module-authority-invalid"
    );

    let mut overlap = workload;
    overlap.sandbox_before = vec![CapabilitySandboxFile::new("modules/read.re", b"bad")];
    assert_eq!(
        serialize_capability_project_comparison_catalog(&CapabilityProjectComparisonCatalog::new(
            vec![overlap]
        ))
        .unwrap_err()
        .code,
        "native-capability-project-comparison-sandbox-authority-mismatch"
    );
}
