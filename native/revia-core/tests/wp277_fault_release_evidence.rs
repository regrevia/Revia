use revia_core::{
    digest::sha256_hex,
    fault_corpus::{
        FaultEvidenceScope, FaultStage, NativeFaultCorpus, NativeFaultCorpusCase,
        NativeFaultObservation, NativeFaultPendingBackend, NativeFaultReleaseRun,
        build_native_fault_corpus_release_evidence, build_native_fault_corpus_report,
        parse_native_fault_corpus_release_evidence, serialize_native_fault_corpus_release_evidence,
    },
    replay::NativeReplayTranscript,
    replay_fault_catalog::ReplayFaultKind,
};

const INPUT: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOURCE: &str = "re 0.1 compact\nunit @broken\n";
const BINARY: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOOLCHAIN: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[test]
fn fault_release_evidence_binds_binary_toolchain_and_case_authority() {
    let transcript = revia_core::replay::serialize_native_replay_transcript(
        &NativeReplayTranscript::new(Vec::new()),
    )
    .unwrap();
    let cases = (0..5)
        .map(|index| {
            NativeFaultCorpusCase::new(
                format!("case-{index}"),
                SOURCE,
                INPUT,
                transcript.clone(),
                FaultStage::CheckedError,
                ReplayFaultKind::CheckFailure,
                "synthetic-check-failure",
            )
        })
        .collect::<Vec<_>>();
    let corpus = NativeFaultCorpus::new(cases);
    let observations = corpus
        .cases
        .iter()
        .map(|case| {
            NativeFaultObservation::measured(
                &case.case_id,
                &case.source,
                None,
                &case.input_digest,
                &case.transcript,
                case.expected_stage,
                case.expected_kind,
                &case.expected_code,
                FaultEvidenceScope::Exercised,
            )
        })
        .collect();
    let report = build_native_fault_corpus_report(
        &corpus,
        observations,
        vec![
            NativeFaultPendingBackend::new("node", "not-measured"),
            NativeFaultPendingBackend::new("go", "not-measured"),
            NativeFaultPendingBackend::new("jvm", "not-measured"),
        ],
    )
    .expect("report");
    let evidence =
        build_native_fault_corpus_release_evidence(&corpus, &report, run(true)).expect("evidence");
    let source = serialize_native_fault_corpus_release_evidence(&corpus, &report, &evidence)
        .expect("canonical evidence");

    assert_eq!(
        serialize_native_fault_corpus_release_evidence(
            &corpus,
            &report,
            &parse_native_fault_corpus_release_evidence(&source).unwrap()
        )
        .unwrap(),
        source
    );
    assert_eq!(evidence.binary_digest, BINARY);
    assert_eq!(evidence.toolchain_digest, TOOLCHAIN);
    assert_eq!(evidence.cases.len(), 5);
    assert_eq!(
        evidence.cases[0].source_digest,
        format!("sha256:{}", sha256_hex(SOURCE.as_bytes()))
    );
    assert!(build_native_fault_corpus_release_evidence(&corpus, &report, run(false)).is_err());

    let mut tampered = evidence.clone();
    tampered.binary_digest = format!("sha256:{}", sha256_hex(b"replacement"));
    assert!(serialize_native_fault_corpus_release_evidence(&corpus, &report, &tampered).is_err());

    let mut re_signed = evidence;
    re_signed.toolchain_digest = format!("sha256:{}", sha256_hex(b"replacement-toolchain"));
    re_signed.stable_digest = re_signed.stable_digest.clone();
    assert!(serialize_native_fault_corpus_release_evidence(&corpus, &report, &re_signed).is_err());
}

fn run(release_build: bool) -> NativeFaultReleaseRun {
    NativeFaultReleaseRun {
        binary_digest: BINARY.to_owned(),
        toolchain_digest: TOOLCHAIN.to_owned(),
        release_build,
        empty_path: true,
        process_count: 1,
        node_process_count: 0,
        node_load_count: 0,
        node_import_count: 0,
    }
}
