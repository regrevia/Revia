use revia_core::{
    digest::sha256_hex,
    fault_corpus::{
        FaultEvidenceScope, FaultStage, NativeFaultCorpus, NativeFaultCorpusCase,
        NativeFaultObservation, NativeFaultPendingBackend, build_native_fault_corpus_report,
        parse_native_fault_corpus, parse_native_fault_corpus_report, serialize_native_fault_corpus,
        serialize_native_fault_corpus_report,
    },
    replay::{NativeReplayTranscript, serialize_native_replay_transcript},
    replay_fault_catalog::ReplayFaultKind,
};

const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE: &str = include_str!("../../../test/golden/canonical-hello.re");
const GRAPH: &str = "sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083";
const INVALID_COMPACT: &str = "re 0.1 compact\nunit @broken\nfn @main() -> process.status {\n";

fn transcript() -> String {
    serialize_native_replay_transcript(&NativeReplayTranscript::new(Vec::new())).unwrap()
}

fn case(
    id: &str,
    source: &str,
    stage: FaultStage,
    kind: ReplayFaultKind,
    code: &str,
    transcript: String,
) -> NativeFaultCorpusCase {
    NativeFaultCorpusCase::new(id, source, INPUT, transcript, stage, kind, code)
}

fn observation(
    case_id: &str,
    source: &str,
    stage: FaultStage,
    kind: ReplayFaultKind,
    code: &str,
    transcript: &str,
) -> NativeFaultObservation {
    NativeFaultObservation::measured(
        case_id,
        source,
        (source == SOURCE).then_some(GRAPH),
        INPUT,
        transcript,
        stage,
        kind,
        code,
        FaultEvidenceScope::Exercised,
    )
}

fn corpus() -> NativeFaultCorpus {
    NativeFaultCorpus::new(vec![
        case(
            "empty-transcript",
            SOURCE,
            FaultStage::ReplayMismatch,
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
            transcript(),
        ),
        case(
            "identity-drift",
            SOURCE,
            FaultStage::ReplayMismatch,
            ReplayFaultKind::ReplayMismatch,
            "native-conformance-replay-invocation-mismatch",
            transcript(),
        ),
        case(
            "unsupported-version",
            "re 1.0 compact\nmodule broken\n",
            FaultStage::CheckedError,
            ReplayFaultKind::CheckFailure,
            "unsupported-language-version",
            transcript(),
        ),
        case(
            "invalid-module",
            INVALID_COMPACT,
            FaultStage::CheckedError,
            ReplayFaultKind::CheckFailure,
            "unexpected-token",
            transcript(),
        ),
        case(
            "host-observation",
            SOURCE,
            FaultStage::HostObservation,
            ReplayFaultKind::HostFault,
            "host-fault-injected",
            transcript(),
        ),
    ])
}

fn report_observations(corpus: &NativeFaultCorpus) -> Vec<NativeFaultObservation> {
    corpus
        .cases
        .iter()
        .map(|item| {
            observation(
                &item.case_id,
                &item.source,
                item.expected_stage,
                item.expected_kind,
                &item.expected_code,
                &item.transcript,
            )
        })
        .collect()
}

#[test]
fn fault_corpus_and_observation_report_are_canonical_and_exercised() {
    let corpus = corpus();
    let corpus_source = serialize_native_fault_corpus(&corpus).unwrap();
    assert_eq!(
        serialize_native_fault_corpus(&parse_native_fault_corpus(&corpus_source).unwrap()).unwrap(),
        corpus_source
    );

    let report = build_native_fault_corpus_report(
        &corpus,
        report_observations(&corpus),
        vec![
            NativeFaultPendingBackend::new("node", "not-measured"),
            NativeFaultPendingBackend::new("go", "not-measured"),
            NativeFaultPendingBackend::new("jvm", "not-measured"),
        ],
    )
    .unwrap();
    assert_eq!(
        report
            .observations
            .iter()
            .map(|item| item.evidence_scope)
            .collect::<Vec<_>>(),
        vec![FaultEvidenceScope::Exercised; 5]
    );
    assert_eq!(report.observations[2].stage, FaultStage::CheckedError);
    assert_eq!(report.observations[4].stage, FaultStage::HostObservation);

    let report_source = serialize_native_fault_corpus_report(&report).unwrap();
    assert_eq!(
        serialize_native_fault_corpus_report(
            &parse_native_fault_corpus_report(&report_source).unwrap()
        )
        .unwrap(),
        report_source
    );
}

#[test]
fn fault_report_rejects_unexercised_claims_receipts_and_authority_drift() {
    let corpus = corpus();
    let pending = vec![
        NativeFaultPendingBackend::new("node", "not-measured"),
        NativeFaultPendingBackend::new("go", "not-measured"),
        NativeFaultPendingBackend::new("jvm", "not-measured"),
    ];

    let mut unexercised = report_observations(&corpus);
    unexercised[0].evidence_scope = FaultEvidenceScope::Reachable;
    assert!(build_native_fault_corpus_report(&corpus, unexercised, pending.clone()).is_err());

    let mut with_receipt = report_observations(&corpus);
    with_receipt[0].receipt_digest = Some(format!("sha256:{}", sha256_hex(b"forged-receipt")));
    assert!(build_native_fault_corpus_report(&corpus, with_receipt, pending.clone()).is_err());

    let mut drifted = report_observations(&corpus);
    drifted[0].input_digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert!(build_native_fault_corpus_report(&corpus, drifted, pending.clone()).is_err());

    let mut graph_drifted = report_observations(&corpus);
    graph_drifted[0].graph_revision =
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned());
    assert!(build_native_fault_corpus_report(&corpus, graph_drifted, pending.clone()).is_err());

    let mut wrong_partition = pending;
    wrong_partition[0] = NativeFaultPendingBackend::new("node", "copied-from-native");
    let mut observations = report_observations(&corpus);
    observations[0].status = "success".to_owned();
    assert!(build_native_fault_corpus_report(&corpus, observations, wrong_partition).is_err());
}
