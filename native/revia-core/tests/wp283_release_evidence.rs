use revia_core::release_evidence::{
    NativeComparisonCandidate, NativeDeterministicBuildEvidence, NativeReleaseEvidence,
    NativeReleaseRun, build_native_release_evidence, serialize_native_release_evidence,
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn build() -> NativeReleaseEvidence {
    build_native_release_evidence(
        DIGEST_A,
        DIGEST_B,
        DIGEST_C,
        DIGEST_D,
        DIGEST_C,
        DIGEST_D,
        DIGEST_A,
        DIGEST_B,
        DIGEST_C,
        NativeDeterministicBuildEvidence::new(DIGEST_A, DIGEST_A, DIGEST_B, DIGEST_B),
        DIGEST_C,
        vec![
            NativeComparisonCandidate::measured("native", DIGEST_C, DIGEST_D, DIGEST_A),
            NativeComparisonCandidate::pending("node", DIGEST_C, "migration-oracle-only"),
            NativeComparisonCandidate::pending("go", DIGEST_C, "not-measured"),
            NativeComparisonCandidate::pending("jvm", DIGEST_C, "not-measured"),
        ],
        DIGEST_D,
        "re.native-capability-project-comparison-report@0.1.0",
        DIGEST_A,
        DIGEST_B,
        DIGEST_C,
        NativeReleaseRun::measured(),
    )
    .expect("release evidence")
}

#[test]
fn release_evidence_binds_all_fresh_authorities_and_pending_backends() {
    let evidence = build();
    let source = serialize_native_release_evidence(&evidence).expect("canonical evidence");
    assert!(source.contains("re.native-release-evidence@0.4.0"));
    assert!(source.contains("\"empty_path\":true"));
    assert!(source.contains("\"release_build\":true"));
    assert!(source.contains("\"backend\":\"node\""));
    assert!(source.contains("\"status\":\"pending\""));
}

#[test]
fn release_evidence_rejects_build_or_fixture_drift_before_serialization() {
    let mut build_drift = build();
    build_drift.deterministic_build.first_tree_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&build_drift).is_err());

    let mut fixture_drift = build();
    fixture_drift.comparison[0].fixture_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&fixture_drift).is_err());
}

#[test]
fn release_evidence_rejects_promoted_or_resigned_comparison_authority() {
    let mut promoted = build();
    promoted.comparison[1].status = "measured".to_owned();
    promoted.comparison[1].semantic_digest = DIGEST_A.to_owned();
    promoted.comparison[1].result_digest = DIGEST_B.to_owned();
    assert!(serialize_native_release_evidence(&promoted).is_err());

    let mut resigned = build();
    resigned.stable_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&resigned).is_err());
}

#[test]
fn release_evidence_declares_bundle_comparison_authority() {
    let evidence = build();
    assert_eq!(evidence.schema, "re.native-release-evidence@0.4.0");
    let source = serialize_native_release_evidence(&evidence).unwrap();
    assert!(source.contains("\"bundle_comparison_report_digest\":"));
    assert!(
        source
            .contains("\"bundle_comparison_schema\":\"re.native-runtime-bundle-comparison@0.2.0\"")
    );
}

#[test]
fn release_evidence_rejects_bundle_schema_or_report_drift() {
    let mut schema_drift = build();
    schema_drift.bundle_comparison_schema = "re.other@9.9.9".to_owned();
    assert!(serialize_native_release_evidence(&schema_drift).is_err());

    let mut report_drift = build();
    report_drift.bundle_comparison_report_digest = DIGEST_A.to_owned();
    assert!(serialize_native_release_evidence(&report_drift).is_err());
}
