use revia_core::release_evidence::{
    NativeComparisonCandidate, NativeDeterministicBuildEvidence, NativeReleaseEvidence,
    NativeReleaseRun, build_native_release_evidence, serialize_native_release_evidence,
};

const DIGEST_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const PROJECT_CAPABILITY_SCHEMA: &str = "re.native-capability-project-comparison-report@0.1.0";

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
        PROJECT_CAPABILITY_SCHEMA,
        DIGEST_A,
        DIGEST_B,
        DIGEST_C,
        NativeReleaseRun::measured(),
    )
    .expect("release evidence")
}

#[test]
fn release_evidence_binds_project_capability_authority() {
    let evidence = build();

    let source = serialize_native_release_evidence(&evidence).expect("canonical evidence");
    assert!(source.contains("re.native-release-evidence@0.4.0"));
    assert!(source.contains(PROJECT_CAPABILITY_SCHEMA));
    assert!(source.contains("\"project_capability_catalog_digest\":"));
    assert!(source.contains("\"project_capability_project_digest\":"));
    assert!(source.contains("\"project_capability_report_digest\":"));
}

#[test]
fn release_evidence_rejects_project_capability_authority_or_resign_drift() {
    let mut missing = build();
    missing.project_capability_schema.clear();
    assert!(serialize_native_release_evidence(&missing).is_err());

    let mut schema_drift = build();
    schema_drift.project_capability_schema = "re.other@9.9.9".to_owned();
    assert!(serialize_native_release_evidence(&schema_drift).is_err());

    let mut catalog_drift = build();
    catalog_drift.project_capability_catalog_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&catalog_drift).is_err());

    let mut report_drift = schema_drift;
    report_drift.project_capability_schema = PROJECT_CAPABILITY_SCHEMA.to_owned();
    report_drift.project_capability_report_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&report_drift).is_err());

    let mut resigned = build();
    resigned.stable_digest = DIGEST_D.to_owned();
    assert!(serialize_native_release_evidence(&resigned).is_err());
}
