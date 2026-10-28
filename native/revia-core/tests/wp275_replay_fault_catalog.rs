use revia_core::{
    replay::{NativeReplayTranscript, serialize_native_replay_transcript},
    replay_fault_catalog::{
        ReplayFaultCatalog, ReplayFaultKind, ReplayFaultResult, ReplayFaultWorkload,
        ReplayFaultWorkloadObservation, build_replay_fault_report, parse_replay_fault_catalog,
        parse_replay_fault_report, serialize_replay_fault_catalog, serialize_replay_fault_report,
    },
};

const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GRAPH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRANSCRIPT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TOOLCHAIN: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RESULT: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");

fn transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(Vec::new())).unwrap()
}

fn workload(id: &str, kind: ReplayFaultKind, code: &str) -> ReplayFaultWorkload {
    ReplayFaultWorkload::new(id, SOURCE, INPUT, transcript(), kind, code, None)
}

fn result(
    backend: &str,
    graph_revision: Option<&str>,
    kind: ReplayFaultKind,
    code: &str,
) -> ReplayFaultResult {
    ReplayFaultResult::measured(
        backend,
        graph_revision,
        INPUT,
        TRANSCRIPT_DIGEST,
        kind,
        code,
        TOOLCHAIN,
    )
}

fn observation(
    id: &str,
    kind: ReplayFaultKind,
    code: &str,
    node: Option<ReplayFaultResult>,
) -> ReplayFaultWorkloadObservation {
    ReplayFaultWorkloadObservation::new(
        id,
        Some(GRAPH),
        INPUT,
        TRANSCRIPT_DIGEST,
        result("native", Some(GRAPH), kind, code),
        node,
        vec![("go", "not-measured"), ("jvm", "not-measured")],
    )
}

#[test]
fn replay_fault_catalog_and_report_round_trip_three_closed_failures() {
    let node = result(
        "node",
        Some(GRAPH),
        ReplayFaultKind::ReplayMismatch,
        "native-conformance-replay-invocation-mismatch",
    );
    let catalog = ReplayFaultCatalog::new(vec![
        ReplayFaultWorkload::new(
            "replay-mismatch",
            SOURCE,
            INPUT,
            transcript(),
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
            Some(node.clone()),
        ),
        workload(
            "check-failure",
            ReplayFaultKind::CheckFailure,
            "unexpected-argument",
        ),
        workload(
            "host-fault",
            ReplayFaultKind::HostFault,
            "host-fault-injected",
        ),
    ]);
    let catalog_source = serialize_replay_fault_catalog(&catalog).unwrap();
    assert_eq!(
        serialize_replay_fault_catalog(&parse_replay_fault_catalog(&catalog_source).unwrap())
            .unwrap(),
        catalog_source
    );

    let report = build_replay_fault_report(
        &catalog,
        vec![
            observation(
                "replay-mismatch",
                ReplayFaultKind::ReplayMismatch,
                "native-conformance-replay-invocation-mismatch",
                Some(node),
            ),
            observation(
                "check-failure",
                ReplayFaultKind::CheckFailure,
                "unexpected-argument",
                None,
            ),
            observation(
                "host-fault",
                ReplayFaultKind::HostFault,
                "host-fault-injected",
                None,
            ),
        ],
    )
    .unwrap();
    let report_source = serialize_replay_fault_report(&report).unwrap();
    assert_eq!(
        serialize_replay_fault_report(&parse_replay_fault_report(&report_source).unwrap()).unwrap(),
        report_source
    );
    assert_eq!(report.workloads[0].status, "failure-equivalent");
    assert_eq!(
        report.workloads[1].native.kind,
        ReplayFaultKind::CheckFailure
    );
    assert!(report.workloads[2].native.receipt_digest.is_none());
}

#[test]
fn replay_fault_report_rejects_success_and_authority_or_partition_drift() {
    let catalog = ReplayFaultCatalog::new(vec![
        workload(
            "replay-mismatch",
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
        ),
        workload(
            "check-failure",
            ReplayFaultKind::CheckFailure,
            "unexpected-argument",
        ),
        workload(
            "host-fault",
            ReplayFaultKind::HostFault,
            "host-fault-injected",
        ),
    ]);
    let mut success = result(
        "native",
        Some(GRAPH),
        ReplayFaultKind::CheckFailure,
        "unexpected-argument",
    );
    success.receipt_digest = Some(RESULT.to_owned());
    assert!(
        build_replay_fault_report(
            &catalog,
            vec![
                ReplayFaultWorkloadObservation::new(
                    "replay-mismatch",
                    Some(GRAPH),
                    INPUT,
                    TRANSCRIPT_DIGEST,
                    success,
                    None,
                    vec![("go", "not-measured"), ("jvm", "not-measured")],
                ),
                observation(
                    "check-failure",
                    ReplayFaultKind::CheckFailure,
                    "unexpected-argument",
                    None,
                ),
                observation(
                    "host-fault",
                    ReplayFaultKind::HostFault,
                    "host-fault-injected",
                    None,
                ),
            ],
        )
        .is_err()
    );

    let mut drifted = observation(
        "replay-mismatch",
        ReplayFaultKind::ReplayMismatch,
        "native-conformance-replay-invocation-mismatch",
        None,
    );
    drifted.native.input_digest = INPUT.replace('b', "a");
    assert!(
        build_replay_fault_report(
            &catalog,
            vec![
                drifted,
                observation(
                    "check-failure",
                    ReplayFaultKind::CheckFailure,
                    "unexpected-argument",
                    None,
                ),
                observation(
                    "host-fault",
                    ReplayFaultKind::HostFault,
                    "host-fault-injected",
                    None,
                ),
            ],
        )
        .is_err()
    );
}
