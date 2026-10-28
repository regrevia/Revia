use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
};

pub const NATIVE_RELEASE_EVIDENCE_SCHEMA: &str = "re.native-release-evidence@0.4.0";
pub const NATIVE_BUNDLE_COMPARISON_SCHEMA: &str = "re.native-runtime-bundle-comparison@0.2.0";
pub const NATIVE_PROJECT_CAPABILITY_COMPARISON_SCHEMA: &str =
    "re.native-capability-project-comparison-report@0.1.0";
const COMPARISON_BACKENDS: [&str; 4] = ["native", "node", "go", "jvm"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeReleaseEvidenceError {
    pub code: String,
}

impl NativeReleaseEvidenceError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeDeterministicBuildEvidence {
    pub first_manifest_digest: String,
    pub second_manifest_digest: String,
    pub first_tree_digest: String,
    pub second_tree_digest: String,
}

impl NativeDeterministicBuildEvidence {
    pub fn new(
        first_manifest_digest: impl Into<String>,
        second_manifest_digest: impl Into<String>,
        first_tree_digest: impl Into<String>,
        second_tree_digest: impl Into<String>,
    ) -> Self {
        Self {
            first_manifest_digest: first_manifest_digest.into(),
            second_manifest_digest: second_manifest_digest.into(),
            first_tree_digest: first_tree_digest.into(),
            second_tree_digest: second_tree_digest.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeComparisonCandidate {
    pub backend: String,
    pub fixture_digest: String,
    pub semantic_digest: String,
    pub result_digest: String,
    pub reason: String,
    pub status: String,
}

impl NativeComparisonCandidate {
    pub fn measured(
        backend: impl Into<String>,
        fixture_digest: impl Into<String>,
        semantic_digest: impl Into<String>,
        result_digest: impl Into<String>,
    ) -> Self {
        Self {
            backend: backend.into(),
            fixture_digest: fixture_digest.into(),
            semantic_digest: semantic_digest.into(),
            result_digest: result_digest.into(),
            reason: "measured-native-release".to_owned(),
            status: "measured".to_owned(),
        }
    }

    pub fn pending(
        backend: impl Into<String>,
        fixture_digest: impl Into<String>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            backend: backend.into(),
            fixture_digest: fixture_digest.into(),
            semantic_digest: String::new(),
            result_digest: String::new(),
            reason: reason.into(),
            status: "pending".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeReleaseRun {
    pub release_build: bool,
    pub empty_path: bool,
    pub process_count: u32,
    pub node_process_count: u32,
    pub node_load_count: u32,
    pub node_import_count: u32,
}

impl NativeReleaseRun {
    pub fn measured() -> Self {
        Self {
            release_build: true,
            empty_path: true,
            process_count: 1,
            node_process_count: 0,
            node_load_count: 0,
            node_import_count: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeReleaseEvidence {
    pub schema: String,
    pub backend: String,
    pub binary_digest: String,
    pub toolchain_digest: String,
    pub source_inventory_digest: String,
    pub project_digest: String,
    pub node_free_stable_digest: String,
    pub node_free_workload_digest: String,
    pub fault_corpus_digest: String,
    pub fault_report_digest: String,
    pub fault_evidence_stable_digest: String,
    pub deterministic_build: NativeDeterministicBuildEvidence,
    pub comparison_fixture_digest: String,
    pub comparison: Vec<NativeComparisonCandidate>,
    pub bundle_comparison_schema: String,
    pub bundle_comparison_report_digest: String,
    pub project_capability_schema: String,
    pub project_capability_catalog_digest: String,
    pub project_capability_project_digest: String,
    pub project_capability_report_digest: String,
    pub release_build: bool,
    pub empty_path: bool,
    pub process_count: u32,
    pub node_process_count: u32,
    pub node_load_count: u32,
    pub node_import_count: u32,
    pub status: String,
    pub stable_digest: String,
    pub evidence_digest: String,
}

#[allow(clippy::too_many_arguments)]
pub fn build_native_release_evidence(
    binary_digest: &str,
    toolchain_digest: &str,
    source_inventory_digest: &str,
    project_digest: &str,
    node_free_stable_digest: &str,
    node_free_workload_digest: &str,
    fault_corpus_digest: &str,
    fault_report_digest: &str,
    fault_evidence_stable_digest: &str,
    deterministic_build: NativeDeterministicBuildEvidence,
    comparison_fixture_digest: &str,
    comparison: Vec<NativeComparisonCandidate>,
    bundle_comparison_report_digest: &str,
    project_capability_schema: &str,
    project_capability_catalog_digest: &str,
    project_capability_project_digest: &str,
    project_capability_report_digest: &str,
    run: NativeReleaseRun,
) -> Result<NativeReleaseEvidence, NativeReleaseEvidenceError> {
    let mut evidence = NativeReleaseEvidence {
        schema: NATIVE_RELEASE_EVIDENCE_SCHEMA.to_owned(),
        backend: "native".to_owned(),
        binary_digest: binary_digest.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
        source_inventory_digest: source_inventory_digest.to_owned(),
        project_digest: project_digest.to_owned(),
        node_free_stable_digest: node_free_stable_digest.to_owned(),
        node_free_workload_digest: node_free_workload_digest.to_owned(),
        fault_corpus_digest: fault_corpus_digest.to_owned(),
        fault_report_digest: fault_report_digest.to_owned(),
        fault_evidence_stable_digest: fault_evidence_stable_digest.to_owned(),
        deterministic_build,
        comparison_fixture_digest: comparison_fixture_digest.to_owned(),
        comparison,
        bundle_comparison_schema: NATIVE_BUNDLE_COMPARISON_SCHEMA.to_owned(),
        bundle_comparison_report_digest: bundle_comparison_report_digest.to_owned(),
        project_capability_schema: project_capability_schema.to_owned(),
        project_capability_catalog_digest: project_capability_catalog_digest.to_owned(),
        project_capability_project_digest: project_capability_project_digest.to_owned(),
        project_capability_report_digest: project_capability_report_digest.to_owned(),
        release_build: run.release_build,
        empty_path: run.empty_path,
        process_count: run.process_count,
        node_process_count: run.node_process_count,
        node_load_count: run.node_load_count,
        node_import_count: run.node_import_count,
        status: "measured".to_owned(),
        stable_digest: String::new(),
        evidence_digest: String::new(),
    };
    validate_content(&evidence)?;
    evidence.stable_digest = stable_digest(&evidence);
    evidence.evidence_digest = evidence_digest(&evidence);
    validate_native_release_evidence(&evidence)?;
    Ok(evidence)
}

pub fn serialize_native_release_evidence(
    evidence: &NativeReleaseEvidence,
) -> Result<String, NativeReleaseEvidenceError> {
    validate_native_release_evidence(evidence)?;
    Ok(format!(
        "{}\n",
        canonicalize(&evidence_json(evidence, true))
    ))
}

pub fn validate_native_release_evidence(
    evidence: &NativeReleaseEvidence,
) -> Result<(), NativeReleaseEvidenceError> {
    validate_content(evidence)?;
    if evidence.stable_digest != stable_digest(evidence) {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-stable-digest-mismatch",
        ));
    }
    if evidence.evidence_digest != evidence_digest(evidence) {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-digest-mismatch",
        ));
    }
    Ok(())
}

fn validate_content(evidence: &NativeReleaseEvidence) -> Result<(), NativeReleaseEvidenceError> {
    if evidence.schema != NATIVE_RELEASE_EVIDENCE_SCHEMA
        || evidence.backend != "native"
        || evidence.status != "measured"
        || !evidence.release_build
        || !evidence.empty_path
        || evidence.process_count == 0
        || evidence.node_process_count != 0
        || evidence.node_load_count != 0
        || evidence.node_import_count != 0
    {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-authority-invalid",
        ));
    }
    for digest in [
        &evidence.binary_digest,
        &evidence.toolchain_digest,
        &evidence.source_inventory_digest,
        &evidence.project_digest,
        &evidence.node_free_stable_digest,
        &evidence.node_free_workload_digest,
        &evidence.fault_corpus_digest,
        &evidence.fault_report_digest,
        &evidence.fault_evidence_stable_digest,
        &evidence.comparison_fixture_digest,
        &evidence.bundle_comparison_report_digest,
    ] {
        if !is_digest(digest) {
            return Err(NativeReleaseEvidenceError::new(
                "native-release-evidence-digest-invalid",
            ));
        }
    }
    if evidence.bundle_comparison_schema != NATIVE_BUNDLE_COMPARISON_SCHEMA {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-bundle-comparison-schema-invalid",
        ));
    }
    if evidence.project_capability_schema != NATIVE_PROJECT_CAPABILITY_COMPARISON_SCHEMA {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-project-capability-schema-invalid",
        ));
    }
    for digest in [
        &evidence.project_capability_catalog_digest,
        &evidence.project_capability_project_digest,
        &evidence.project_capability_report_digest,
    ] {
        if !is_digest(digest) {
            return Err(NativeReleaseEvidenceError::new(
                "native-release-evidence-project-capability-digest-invalid",
            ));
        }
    }
    validate_build(&evidence.deterministic_build)?;
    if evidence.comparison.len() != COMPARISON_BACKENDS.len()
        || evidence
            .comparison
            .iter()
            .map(|candidate| candidate.backend.as_str())
            .ne(COMPARISON_BACKENDS)
    {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-comparison-set-invalid",
        ));
    }
    for (index, candidate) in evidence.comparison.iter().enumerate() {
        if candidate.fixture_digest != evidence.comparison_fixture_digest {
            return Err(NativeReleaseEvidenceError::new(
                "native-release-evidence-comparison-fixture-mismatch",
            ));
        }
        if index == 0 {
            if candidate.status != "measured"
                || candidate.reason != "measured-native-release"
                || !is_digest(&candidate.semantic_digest)
                || !is_digest(&candidate.result_digest)
            {
                return Err(NativeReleaseEvidenceError::new(
                    "native-release-evidence-native-comparison-invalid",
                ));
            }
        } else if candidate.status != "pending"
            || candidate.reason.is_empty()
            || !candidate.semantic_digest.is_empty()
            || !candidate.result_digest.is_empty()
        {
            return Err(NativeReleaseEvidenceError::new(
                "native-release-evidence-pending-comparison-invalid",
            ));
        }
    }
    Ok(())
}

fn validate_build(
    build: &NativeDeterministicBuildEvidence,
) -> Result<(), NativeReleaseEvidenceError> {
    for digest in [
        &build.first_manifest_digest,
        &build.second_manifest_digest,
        &build.first_tree_digest,
        &build.second_tree_digest,
    ] {
        if !is_digest(digest) {
            return Err(NativeReleaseEvidenceError::new(
                "native-release-evidence-build-digest-invalid",
            ));
        }
    }
    if build.first_manifest_digest != build.second_manifest_digest
        || build.first_tree_digest != build.second_tree_digest
    {
        return Err(NativeReleaseEvidenceError::new(
            "native-release-evidence-build-nondeterministic",
        ));
    }
    Ok(())
}

fn stable_digest(evidence: &NativeReleaseEvidence) -> String {
    digest_json(&evidence_json(evidence, false).without("stable_digest"))
}

fn evidence_digest(evidence: &NativeReleaseEvidence) -> String {
    digest_json(&evidence_json(evidence, true).without("evidence_digest"))
}

fn evidence_json(evidence: &NativeReleaseEvidence, include_evidence_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "backend".to_owned(),
            JsonValue::String(evidence.backend.clone()),
        ),
        (
            "binary_digest".to_owned(),
            JsonValue::String(evidence.binary_digest.clone()),
        ),
        (
            "comparison".to_owned(),
            comparison_json(&evidence.comparison),
        ),
        (
            "comparison_fixture_digest".to_owned(),
            JsonValue::String(evidence.comparison_fixture_digest.clone()),
        ),
        (
            "bundle_comparison_report_digest".to_owned(),
            JsonValue::String(evidence.bundle_comparison_report_digest.clone()),
        ),
        (
            "bundle_comparison_schema".to_owned(),
            JsonValue::String(evidence.bundle_comparison_schema.clone()),
        ),
        (
            "project_capability_catalog_digest".to_owned(),
            JsonValue::String(evidence.project_capability_catalog_digest.clone()),
        ),
        (
            "project_capability_project_digest".to_owned(),
            JsonValue::String(evidence.project_capability_project_digest.clone()),
        ),
        (
            "project_capability_report_digest".to_owned(),
            JsonValue::String(evidence.project_capability_report_digest.clone()),
        ),
        (
            "project_capability_schema".to_owned(),
            JsonValue::String(evidence.project_capability_schema.clone()),
        ),
        (
            "deterministic_build".to_owned(),
            build_json(&evidence.deterministic_build),
        ),
        (
            "empty_path".to_owned(),
            JsonValue::Bool(evidence.empty_path),
        ),
        (
            "fault_evidence_stable_digest".to_owned(),
            JsonValue::String(evidence.fault_evidence_stable_digest.clone()),
        ),
        (
            "fault_corpus_digest".to_owned(),
            JsonValue::String(evidence.fault_corpus_digest.clone()),
        ),
        (
            "fault_report_digest".to_owned(),
            JsonValue::String(evidence.fault_report_digest.clone()),
        ),
        (
            "node_free_stable_digest".to_owned(),
            JsonValue::String(evidence.node_free_stable_digest.clone()),
        ),
        (
            "node_free_workload_digest".to_owned(),
            JsonValue::String(evidence.node_free_workload_digest.clone()),
        ),
        (
            "node_import_count".to_owned(),
            JsonValue::Number(evidence.node_import_count.to_string()),
        ),
        (
            "node_load_count".to_owned(),
            JsonValue::Number(evidence.node_load_count.to_string()),
        ),
        (
            "node_process_count".to_owned(),
            JsonValue::Number(evidence.node_process_count.to_string()),
        ),
        (
            "process_count".to_owned(),
            JsonValue::Number(evidence.process_count.to_string()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(evidence.project_digest.clone()),
        ),
        (
            "release_build".to_owned(),
            JsonValue::Bool(evidence.release_build),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(evidence.schema.clone()),
        ),
        (
            "source_inventory_digest".to_owned(),
            JsonValue::String(evidence.source_inventory_digest.clone()),
        ),
        (
            "status".to_owned(),
            JsonValue::String(evidence.status.clone()),
        ),
        (
            "stable_digest".to_owned(),
            JsonValue::String(evidence.stable_digest.clone()),
        ),
        (
            "toolchain_digest".to_owned(),
            JsonValue::String(evidence.toolchain_digest.clone()),
        ),
    ];
    if include_evidence_digest {
        fields.push((
            "evidence_digest".to_owned(),
            JsonValue::String(evidence.evidence_digest.clone()),
        ));
    }
    JsonValue::Object(fields)
}

fn build_json(build: &NativeDeterministicBuildEvidence) -> JsonValue {
    JsonValue::Object(vec![
        (
            "first_manifest_digest".to_owned(),
            JsonValue::String(build.first_manifest_digest.clone()),
        ),
        (
            "first_tree_digest".to_owned(),
            JsonValue::String(build.first_tree_digest.clone()),
        ),
        (
            "second_manifest_digest".to_owned(),
            JsonValue::String(build.second_manifest_digest.clone()),
        ),
        (
            "second_tree_digest".to_owned(),
            JsonValue::String(build.second_tree_digest.clone()),
        ),
    ])
}

fn comparison_json(candidates: &[NativeComparisonCandidate]) -> JsonValue {
    JsonValue::Array(
        candidates
            .iter()
            .map(|candidate| {
                JsonValue::Object(vec![
                    (
                        "backend".to_owned(),
                        JsonValue::String(candidate.backend.clone()),
                    ),
                    (
                        "fixture_digest".to_owned(),
                        JsonValue::String(candidate.fixture_digest.clone()),
                    ),
                    (
                        "reason".to_owned(),
                        JsonValue::String(candidate.reason.clone()),
                    ),
                    (
                        "result_digest".to_owned(),
                        JsonValue::String(candidate.result_digest.clone()),
                    ),
                    (
                        "semantic_digest".to_owned(),
                        JsonValue::String(candidate.semantic_digest.clone()),
                    ),
                    (
                        "status".to_owned(),
                        JsonValue::String(candidate.status.clone()),
                    ),
                ])
            })
            .collect(),
    )
}

fn digest_json(value: &JsonValue) -> String {
    format!("sha256:{}", sha256_hex(canonicalize(value).as_bytes()))
}

fn is_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

trait WithoutEvidenceDigest {
    fn without(self, key: &str) -> JsonValue;
}

impl WithoutEvidenceDigest for JsonValue {
    fn without(self, key: &str) -> JsonValue {
        match self {
            JsonValue::Object(fields) => JsonValue::Object(
                fields
                    .into_iter()
                    .filter(|(field, _)| field != key)
                    .collect(),
            ),
            other => other,
        }
    }
}
