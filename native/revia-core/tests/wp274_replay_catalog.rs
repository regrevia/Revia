use revia_core::{
    cross_language::{CrossLanguageBackendResult, CrossLanguageInvocation, PendingBackend},
    replay::{NativeReplayTranscript, serialize_native_replay_transcript},
    replay_catalog::{
        ReplayWorkload, ReplayWorkloadCatalog, ReplayWorkloadObservation,
        build_replay_workload_report, parse_replay_workload_catalog, parse_replay_workload_report,
        serialize_replay_workload_catalog, serialize_replay_workload_report,
    },
};

const GRAPH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSCRIPT: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RESULT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RECEIPT: &str = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

fn transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(Vec::new())).unwrap()
}

fn workload(id: &str) -> ReplayWorkload {
    ReplayWorkload::new(id, SOURCE, INPUT, transcript(), None)
}

fn backend(name: &str) -> CrossLanguageBackendResult {
    CrossLanguageBackendResult::measured(
        name,
        GRAPH,
        INPUT,
        TRANSCRIPT,
        TOOLCHAIN,
        RESULT,
        RECEIPT,
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

fn observation(
    id: &str,
    matrix: Option<revia_core::cross_language::CrossLanguageReplayMatrix>,
) -> ReplayWorkloadObservation {
    ReplayWorkloadObservation::new(
        id,
        GRAPH,
        INPUT,
        TRANSCRIPT,
        backend("native"),
        matrix,
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    )
}

#[test]
fn replay_catalog_and_report_round_trip_three_workloads() {
    let node = backend("node");
    let catalog = ReplayWorkloadCatalog::new(vec![
        ReplayWorkload::new("hello-ok", SOURCE, INPUT, transcript(), Some(node.clone())),
        workload("args-err"),
        workload("multi-ok"),
    ]);
    let catalog_source = serialize_replay_workload_catalog(&catalog).unwrap();
    let parsed_catalog = parse_replay_workload_catalog(&catalog_source).unwrap();
    assert_eq!(
        serialize_replay_workload_catalog(&parsed_catalog).unwrap(),
        catalog_source
    );

    let matrix = revia_core::cross_language::build_cross_language_matrix(
        "hello-ok",
        GRAPH,
        INPUT,
        TRANSCRIPT,
        vec![backend("native"), node],
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    )
    .unwrap();
    let report = build_replay_workload_report(
        &catalog,
        vec![
            observation("hello-ok", Some(matrix)),
            observation("args-err", None),
            observation("multi-ok", None),
        ],
    )
    .unwrap();
    let report_source = serialize_replay_workload_report(&report).unwrap();
    assert_eq!(
        serialize_replay_workload_report(&parse_replay_workload_report(&report_source).unwrap())
            .unwrap(),
        report_source
    );
    assert_eq!(report.workloads.len(), 3);
}

#[test]
fn replay_catalog_rejects_duplicate_ids_and_too_few_workloads() {
    let duplicate =
        ReplayWorkloadCatalog::new(vec![workload("same"), workload("same"), workload("third")]);
    assert!(serialize_replay_workload_catalog(&duplicate).is_err());

    let too_few = ReplayWorkloadCatalog::new(vec![workload("one"), workload("two")]);
    assert!(serialize_replay_workload_catalog(&too_few).is_err());
}

#[test]
fn replay_report_rejects_observation_and_node_authority_drift() {
    let catalog = ReplayWorkloadCatalog::new(vec![
        ReplayWorkload::new(
            "hello-ok",
            "re 0.1 canonical\nunit @hello\n",
            INPUT,
            transcript(),
            Some(backend("node")),
        ),
        workload("args-err"),
        workload("multi-ok"),
    ]);
    let mut node = backend("node");
    node.input_digest =
        "sha256:9999999999999999999999999999999999999999999999999999999999999999".to_owned();
    let matrix = revia_core::cross_language::build_cross_language_matrix(
        "hello-ok",
        GRAPH,
        INPUT,
        TRANSCRIPT,
        vec![backend("native"), node],
        vec![
            PendingBackend::new("go", "not-measured"),
            PendingBackend::new("jvm", "not-measured"),
        ],
    );
    assert!(matrix.is_err());

    let report_result = build_replay_workload_report(
        &catalog,
        vec![
            observation("wrong-id", None),
            observation("args-err", None),
            observation("multi-ok", None),
        ],
    );
    assert!(report_result.is_err());
}
