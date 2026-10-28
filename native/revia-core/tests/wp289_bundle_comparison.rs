use revia_core::runtime_bundle_comparison::{
    BUNDLE_COMPARISON_SCHEMA, BundleComparisonObservation, BundleComparisonReport,
    ProjectRunAuthority, parse_bundle_comparison_report, serialize_bundle_comparison_report,
};

#[test]
fn bundle_comparison_report_requires_explicit_execution_mode() {
    let report = BundleComparisonReport::new(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        vec![
            BundleComparisonObservation::executed(
                "success",
                "success",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ),
            BundleComparisonObservation::verified_only(
                "closed-error",
                "closed-error",
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            ),
        ],
    );
    let source = serialize_bundle_comparison_report(&report).unwrap();
    assert!(source.contains(BUNDLE_COMPARISON_SCHEMA));
    assert!(source.contains("\"execution_mode\":\"executed\""));
    assert!(source.contains("\"execution_mode\":\"verified-only\""));
}

#[test]
fn project_workflow_observation_carries_project_run_authority() {
    let report = BundleComparisonReport::new(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        vec![BundleComparisonObservation::project_executed(
            "project-workflow",
            "project-workflow",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ProjectRunAuthority {
                artifact_digest:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_owned(),
                project_digest:
                    "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                        .to_owned(),
                module: "agent.enterprise.m000".to_owned(),
                graph_revision:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_owned(),
                input_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_owned(),
                build_key:
                    "sha256:5555555555555555555555555555555555555555555555555555555555555555"
                        .to_owned(),
                build_manifest_digest:
                    "sha256:6666666666666666666666666666666666666666666666666666666666666666"
                        .to_owned(),
                module_cache_key:
                    "sha256:7777777777777777777777777777777777777777777777777777777777777777"
                        .to_owned(),
                module_artifact_digest:
                    "sha256:8888888888888888888888888888888888888888888888888888888888888888"
                        .to_owned(),
                translation_digest:
                    "sha256:9999999999999999999999999999999999999999999999999999999999999999"
                        .to_owned(),
                vm_receipt_digest:
                    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                        .to_owned(),
                outcome_code: 0,
                outcome_type: "process-status".to_owned(),
                profile: "re.native-vm@0.1.0".to_owned(),
                profile_digest:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                        .to_owned(),
                project_graph_revision:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_owned(),
                toolchain_digest:
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                        .to_owned(),
                run_digest:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_owned(),
            },
        )],
    );
    let source = serialize_bundle_comparison_report(&report).unwrap();
    assert!(source.contains("\"project_run\""));
    assert!(source.contains("\"build_key\""));
    assert!(source.contains("\"translation_digest\""));
    assert!(source.contains("\"vm_receipt_digest\""));
    assert!(source.contains("\"outcome_code\":0"));
    let parsed = parse_bundle_comparison_report(&source).unwrap();
    assert_eq!(
        parsed.observations[0]
            .project_run
            .as_ref()
            .map(|value| value.module.as_str()),
        Some("agent.enterprise.m000")
    );
    let mut drifted = parsed;
    drifted.observations[0]
        .project_run
        .as_mut()
        .unwrap()
        .artifact_digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert_eq!(
        serialize_bundle_comparison_report(&drifted)
            .unwrap_err()
            .code,
        "native-runtime-bundle-comparison-project-run-authority-invalid"
    );
}

#[test]
fn bundle_comparison_report_round_trips_with_a_self_checked_digest() {
    let report = BundleComparisonReport::new(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        vec![BundleComparisonObservation::verified_only(
            "host-boundary",
            "host-boundary",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        )],
    );
    let source = serialize_bundle_comparison_report(&report).unwrap();
    let parsed = parse_bundle_comparison_report(&source).unwrap();
    assert_eq!(serialize_bundle_comparison_report(&parsed).unwrap(), source);
    assert!(!parsed.report_digest.is_empty());
}

#[test]
fn bundle_comparison_report_rejects_a_stale_report_digest_after_observation_drift() {
    let report = BundleComparisonReport::new(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        vec![BundleComparisonObservation::verified_only(
            "host-boundary",
            "host-boundary",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        )],
    );
    let source = serialize_bundle_comparison_report(&report).unwrap();
    let mut parsed = parse_bundle_comparison_report(&source).unwrap();
    parsed.observations[0].kind = "success".to_owned();
    let parsed = serialize_bundle_comparison_report(&parsed);
    assert_eq!(
        parsed.unwrap_err().code,
        "native-runtime-bundle-comparison-report-digest-mismatch"
    );
}
