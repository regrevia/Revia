use std::collections::BTreeSet;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
};

pub const BUNDLE_COMPARISON_SCHEMA: &str = "re.native-runtime-bundle-comparison@0.2.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleComparisonError {
    pub code: String,
}

impl BundleComparisonError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleComparisonObservation {
    pub workload_id: String,
    pub kind: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub bundle_digest: String,
    pub bundle_source_digest: String,
    pub bundle_artifact_digest: String,
    pub execution_mode: String,
    pub direct_result_digest: Option<String>,
    pub bundle_result_digest: Option<String>,
    pub direct_fault_code: Option<String>,
    pub bundle_fault_code: Option<String>,
    pub project_run: Option<ProjectRunAuthority>,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRunAuthority {
    pub artifact_digest: String,
    pub project_digest: String,
    pub module: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub build_key: String,
    pub build_manifest_digest: String,
    pub module_cache_key: String,
    pub module_artifact_digest: String,
    pub translation_digest: String,
    pub vm_receipt_digest: String,
    pub outcome_code: u8,
    pub outcome_type: String,
    pub profile: String,
    pub profile_digest: String,
    pub project_graph_revision: String,
    pub toolchain_digest: String,
    pub run_digest: String,
}

impl BundleComparisonObservation {
    #[allow(clippy::too_many_arguments)]
    pub fn executed(
        workload_id: impl Into<String>,
        kind: impl Into<String>,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
        bundle_digest: impl Into<String>,
        bundle_source_digest: impl Into<String>,
        bundle_artifact_digest: impl Into<String>,
        result_digest: impl Into<String>,
    ) -> Self {
        let result_digest = result_digest.into();
        Self {
            workload_id: workload_id.into(),
            kind: kind.into(),
            graph_revision: graph_revision.into(),
            input_digest: input_digest.into(),
            bundle_digest: bundle_digest.into(),
            bundle_source_digest: bundle_source_digest.into(),
            bundle_artifact_digest: bundle_artifact_digest.into(),
            execution_mode: "executed".to_owned(),
            direct_result_digest: Some(result_digest.clone()),
            bundle_result_digest: Some(result_digest),
            direct_fault_code: None,
            bundle_fault_code: None,
            project_run: None,
            status: "matched".to_owned(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn project_executed(
        workload_id: impl Into<String>,
        kind: impl Into<String>,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
        bundle_digest: impl Into<String>,
        bundle_source_digest: impl Into<String>,
        bundle_artifact_digest: impl Into<String>,
        result_digest: impl Into<String>,
        project_run: ProjectRunAuthority,
    ) -> Self {
        let mut observation = Self::executed(
            workload_id,
            kind,
            graph_revision,
            input_digest,
            bundle_digest,
            bundle_source_digest,
            bundle_artifact_digest,
            result_digest,
        );
        observation.project_run = Some(project_run);
        observation
    }

    pub fn verified_only(
        workload_id: impl Into<String>,
        kind: impl Into<String>,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
        bundle_digest: impl Into<String>,
        bundle_source_digest: impl Into<String>,
        bundle_artifact_digest: impl Into<String>,
    ) -> Self {
        Self {
            workload_id: workload_id.into(),
            kind: kind.into(),
            graph_revision: graph_revision.into(),
            input_digest: input_digest.into(),
            bundle_digest: bundle_digest.into(),
            bundle_source_digest: bundle_source_digest.into(),
            bundle_artifact_digest: bundle_artifact_digest.into(),
            execution_mode: "verified-only".to_owned(),
            direct_result_digest: None,
            bundle_result_digest: None,
            direct_fault_code: None,
            bundle_fault_code: None,
            project_run: None,
            status: "verified-only".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleComparisonReport {
    pub schema: String,
    pub catalog_digest: String,
    pub observations: Vec<BundleComparisonObservation>,
    pub status: String,
    pub report_digest: String,
}

impl BundleComparisonReport {
    pub fn new(
        catalog_digest: impl Into<String>,
        observations: Vec<BundleComparisonObservation>,
    ) -> Self {
        Self {
            schema: BUNDLE_COMPARISON_SCHEMA.to_owned(),
            catalog_digest: catalog_digest.into(),
            observations,
            status: "passed".to_owned(),
            report_digest: String::new(),
        }
    }
}

pub fn serialize_bundle_comparison_report(
    report: &BundleComparisonReport,
) -> Result<String, BundleComparisonError> {
    validate_report(report)?;
    let without_digest = report_json(report, false);
    let report_digest = digest(canonicalize(&without_digest).as_bytes());
    if !report.report_digest.is_empty() && report.report_digest != report_digest {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-report-digest-mismatch",
        ));
    }
    let mut fields = match without_digest {
        JsonValue::Object(fields) => fields,
        _ => unreachable!(),
    };
    fields.push(("report_digest".to_owned(), JsonValue::String(report_digest)));
    Ok(format!("{}\n", canonicalize(&JsonValue::Object(fields))))
}

pub fn parse_bundle_comparison_report(
    source: &str,
) -> Result<BundleComparisonReport, BundleComparisonError> {
    if !source.ends_with('\n') {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-trailing-newline-missing",
        ));
    }
    let value = parse_json(source)
        .map_err(|_| BundleComparisonError::new("native-runtime-bundle-comparison-json-invalid"))?;
    let JsonValue::Object(entries) = value else {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-json-invalid",
        ));
    };
    let expected = [
        "catalog_digest",
        "observations",
        "report_digest",
        "schema",
        "status",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-fields-invalid",
        ));
    }
    let schema = string_field(&entries, "schema")?;
    let catalog_digest = string_field(&entries, "catalog_digest")?;
    let status = string_field(&entries, "status")?;
    let report_digest = string_field(&entries, "report_digest")?;
    let observations_value = entries
        .iter()
        .find(|(key, _)| key == "observations")
        .map(|(_, value)| value)
        .ok_or_else(|| {
            BundleComparisonError::new("native-runtime-bundle-comparison-fields-invalid")
        })?;
    let JsonValue::Array(observations) = observations_value else {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-observations-invalid",
        ));
    };
    let observations = observations
        .iter()
        .map(parse_observation)
        .collect::<Result<Vec<_>, _>>()?;
    let report = BundleComparisonReport {
        schema,
        catalog_digest,
        observations,
        status,
        report_digest,
    };
    let canonical = serialize_bundle_comparison_report(&report)?;
    if canonical != source {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-noncanonical",
        ));
    }
    Ok(report)
}

fn validate_report(report: &BundleComparisonReport) -> Result<(), BundleComparisonError> {
    if report.schema != BUNDLE_COMPARISON_SCHEMA || report.status != "passed" {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-schema-mismatch",
        ));
    }
    if !is_digest(&report.catalog_digest) {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-catalog-digest-invalid",
        ));
    }
    if report.observations.is_empty() {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-observations-empty",
        ));
    }
    let mut ids = BTreeSet::new();
    for observation in &report.observations {
        if observation.workload_id.is_empty() || !ids.insert(observation.workload_id.clone()) {
            return Err(BundleComparisonError::new(
                "native-runtime-bundle-comparison-workload-id-invalid",
            ));
        }
        if !is_digest(&observation.graph_revision)
            || !is_digest(&observation.input_digest)
            || !is_digest(&observation.bundle_digest)
            || !is_digest(&observation.bundle_source_digest)
            || !is_digest(&observation.bundle_artifact_digest)
        {
            return Err(BundleComparisonError::new(
                "native-runtime-bundle-comparison-authority-invalid",
            ));
        }
        if observation.kind == "project-workflow" && observation.project_run.is_none() {
            return Err(BundleComparisonError::new(
                "native-runtime-bundle-comparison-project-run-authority-missing",
            ));
        }
        match observation.execution_mode.as_str() {
            "executed" => {
                if observation.status != "matched"
                    || observation.direct_result_digest.is_none()
                    || observation.bundle_result_digest.is_none()
                    || observation.direct_result_digest != observation.bundle_result_digest
                    || observation.direct_fault_code.is_some()
                    || observation.bundle_fault_code.is_some()
                {
                    return Err(BundleComparisonError::new(
                        "native-runtime-bundle-comparison-execution-mismatch",
                    ));
                }
                if !is_digest(observation.direct_result_digest.as_deref().unwrap()) {
                    return Err(BundleComparisonError::new(
                        "native-runtime-bundle-comparison-result-invalid",
                    ));
                }
                if let Some(project_run) = &observation.project_run
                    && (!is_digest(&project_run.artifact_digest)
                        || !is_digest(&project_run.project_digest)
                        || project_run.module.is_empty()
                        || !is_digest(&project_run.graph_revision)
                        || !is_digest(&project_run.input_digest)
                        || !is_digest(&project_run.build_key)
                        || !is_digest(&project_run.build_manifest_digest)
                        || !is_digest(&project_run.module_cache_key)
                        || !is_digest(&project_run.module_artifact_digest)
                        || !is_digest(&project_run.translation_digest)
                        || !is_digest(&project_run.vm_receipt_digest)
                        || project_run.outcome_type.is_empty()
                        || !is_digest(&project_run.profile_digest)
                        || !is_digest(&project_run.project_graph_revision)
                        || !is_digest(&project_run.toolchain_digest)
                        || !is_digest(&project_run.run_digest)
                        || project_run.artifact_digest != observation.bundle_artifact_digest
                        || project_run.graph_revision != observation.graph_revision
                        || project_run.input_digest != observation.input_digest
                        || project_run.vm_receipt_digest
                            != observation.bundle_result_digest.as_deref().unwrap())
                {
                    return Err(BundleComparisonError::new(
                        "native-runtime-bundle-comparison-project-run-authority-invalid",
                    ));
                }
            }
            "verified-only" => {
                if observation.status != "verified-only"
                    || observation.direct_result_digest.is_some()
                    || observation.bundle_result_digest.is_some()
                    || observation.direct_fault_code.is_some()
                    || observation.bundle_fault_code.is_some()
                    || observation.project_run.is_some()
                {
                    return Err(BundleComparisonError::new(
                        "native-runtime-bundle-comparison-verification-mismatch",
                    ));
                }
            }
            _ => {
                return Err(BundleComparisonError::new(
                    "native-runtime-bundle-comparison-execution-mode-invalid",
                ));
            }
        }
    }
    Ok(())
}

fn report_json(report: &BundleComparisonReport, include_digest: bool) -> JsonValue {
    let observations = report
        .observations
        .iter()
        .map(observation_json)
        .collect::<Vec<_>>();
    let mut fields = vec![
        (
            "catalog_digest".to_owned(),
            JsonValue::String(report.catalog_digest.clone()),
        ),
        ("observations".to_owned(), JsonValue::Array(observations)),
        (
            "schema".to_owned(),
            JsonValue::String(report.schema.clone()),
        ),
        (
            "status".to_owned(),
            JsonValue::String(report.status.clone()),
        ),
    ];
    if include_digest {
        fields.push((
            "report_digest".to_owned(),
            JsonValue::String(report.report_digest.clone()),
        ));
    }
    JsonValue::Object(fields)
}

fn observation_json(observation: &BundleComparisonObservation) -> JsonValue {
    JsonValue::Object(vec![
        (
            "bundle_artifact_digest".to_owned(),
            string(&observation.bundle_artifact_digest),
        ),
        (
            "bundle_digest".to_owned(),
            string(&observation.bundle_digest),
        ),
        (
            "bundle_result_digest".to_owned(),
            optional_string(&observation.bundle_result_digest),
        ),
        (
            "bundle_source_digest".to_owned(),
            string(&observation.bundle_source_digest),
        ),
        (
            "direct_fault_code".to_owned(),
            optional_string(&observation.direct_fault_code),
        ),
        (
            "direct_result_digest".to_owned(),
            optional_string(&observation.direct_result_digest),
        ),
        (
            "execution_mode".to_owned(),
            string(&observation.execution_mode),
        ),
        (
            "graph_revision".to_owned(),
            string(&observation.graph_revision),
        ),
        ("input_digest".to_owned(), string(&observation.input_digest)),
        ("kind".to_owned(), string(&observation.kind)),
        ("status".to_owned(), string(&observation.status)),
        ("workload_id".to_owned(), string(&observation.workload_id)),
        (
            "bundle_fault_code".to_owned(),
            optional_string(&observation.bundle_fault_code),
        ),
        (
            "project_run".to_owned(),
            observation
                .project_run
                .as_ref()
                .map(project_run_json)
                .unwrap_or(JsonValue::Null),
        ),
    ])
}

fn project_run_json(authority: &ProjectRunAuthority) -> JsonValue {
    JsonValue::Object(vec![
        (
            "artifact_digest".to_owned(),
            string(&authority.artifact_digest),
        ),
        ("build_key".to_owned(), string(&authority.build_key)),
        (
            "build_manifest_digest".to_owned(),
            string(&authority.build_manifest_digest),
        ),
        (
            "graph_revision".to_owned(),
            string(&authority.graph_revision),
        ),
        ("input_digest".to_owned(), string(&authority.input_digest)),
        ("module".to_owned(), string(&authority.module)),
        (
            "module_artifact_digest".to_owned(),
            string(&authority.module_artifact_digest),
        ),
        (
            "module_cache_key".to_owned(),
            string(&authority.module_cache_key),
        ),
        (
            "outcome_code".to_owned(),
            JsonValue::Number(authority.outcome_code.to_string()),
        ),
        ("outcome_type".to_owned(), string(&authority.outcome_type)),
        ("profile".to_owned(), string(&authority.profile)),
        (
            "profile_digest".to_owned(),
            string(&authority.profile_digest),
        ),
        (
            "project_digest".to_owned(),
            string(&authority.project_digest),
        ),
        (
            "project_graph_revision".to_owned(),
            string(&authority.project_graph_revision),
        ),
        ("run_digest".to_owned(), string(&authority.run_digest)),
        (
            "toolchain_digest".to_owned(),
            string(&authority.toolchain_digest),
        ),
        (
            "translation_digest".to_owned(),
            string(&authority.translation_digest),
        ),
        (
            "vm_receipt_digest".to_owned(),
            string(&authority.vm_receipt_digest),
        ),
    ])
}

fn parse_observation(
    value: &JsonValue,
) -> Result<BundleComparisonObservation, BundleComparisonError> {
    let JsonValue::Object(entries) = value else {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-observation-invalid",
        ));
    };
    let expected = [
        "bundle_artifact_digest",
        "bundle_digest",
        "bundle_fault_code",
        "bundle_result_digest",
        "bundle_source_digest",
        "direct_fault_code",
        "direct_result_digest",
        "execution_mode",
        "graph_revision",
        "input_digest",
        "kind",
        "project_run",
        "status",
        "workload_id",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-observation-fields-invalid",
        ));
    }
    let project_run = entries
        .iter()
        .find(|(key, _)| key == "project_run")
        .and_then(|(_, value)| (!matches!(value, JsonValue::Null)).then_some(value))
        .map(parse_project_run)
        .transpose()?;
    Ok(BundleComparisonObservation {
        bundle_artifact_digest: string_field(entries, "bundle_artifact_digest")?,
        bundle_digest: string_field(entries, "bundle_digest")?,
        bundle_fault_code: optional_string_field(entries, "bundle_fault_code")?,
        bundle_result_digest: optional_string_field(entries, "bundle_result_digest")?,
        bundle_source_digest: string_field(entries, "bundle_source_digest")?,
        direct_fault_code: optional_string_field(entries, "direct_fault_code")?,
        direct_result_digest: optional_string_field(entries, "direct_result_digest")?,
        execution_mode: string_field(entries, "execution_mode")?,
        graph_revision: string_field(entries, "graph_revision")?,
        input_digest: string_field(entries, "input_digest")?,
        kind: string_field(entries, "kind")?,
        project_run,
        status: string_field(entries, "status")?,
        workload_id: string_field(entries, "workload_id")?,
    })
}

fn parse_project_run(value: &JsonValue) -> Result<ProjectRunAuthority, BundleComparisonError> {
    let JsonValue::Object(entries) = value else {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-project-run-authority-invalid",
        ));
    };
    let expected = [
        "artifact_digest",
        "build_key",
        "build_manifest_digest",
        "graph_revision",
        "input_digest",
        "module",
        "module_artifact_digest",
        "module_cache_key",
        "outcome_code",
        "outcome_type",
        "profile",
        "profile_digest",
        "project_digest",
        "project_graph_revision",
        "run_digest",
        "toolchain_digest",
        "translation_digest",
        "vm_receipt_digest",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(BundleComparisonError::new(
            "native-runtime-bundle-comparison-project-run-authority-invalid",
        ));
    }
    let outcome_code = entries
        .iter()
        .find(|(key, _)| key == "outcome_code")
        .and_then(|(_, value)| match value {
            JsonValue::Number(value) => value.parse::<u8>().ok(),
            _ => None,
        })
        .ok_or_else(|| {
            BundleComparisonError::new(
                "native-runtime-bundle-comparison-project-run-authority-invalid",
            )
        })?;
    Ok(ProjectRunAuthority {
        artifact_digest: string_field(entries, "artifact_digest")?,
        project_digest: string_field(entries, "project_digest")?,
        module: string_field(entries, "module")?,
        graph_revision: string_field(entries, "graph_revision")?,
        input_digest: string_field(entries, "input_digest")?,
        build_key: string_field(entries, "build_key")?,
        build_manifest_digest: string_field(entries, "build_manifest_digest")?,
        module_cache_key: string_field(entries, "module_cache_key")?,
        module_artifact_digest: string_field(entries, "module_artifact_digest")?,
        translation_digest: string_field(entries, "translation_digest")?,
        vm_receipt_digest: string_field(entries, "vm_receipt_digest")?,
        outcome_code,
        outcome_type: string_field(entries, "outcome_type")?,
        profile: string_field(entries, "profile")?,
        profile_digest: string_field(entries, "profile_digest")?,
        project_graph_revision: string_field(entries, "project_graph_revision")?,
        toolchain_digest: string_field(entries, "toolchain_digest")?,
        run_digest: string_field(entries, "run_digest")?,
    })
}

fn string_field(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<String, BundleComparisonError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        })
        .ok_or_else(|| BundleComparisonError::new("native-runtime-bundle-comparison-field-invalid"))
}

fn optional_string_field(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<Option<String>, BundleComparisonError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| match value {
            JsonValue::Null => Ok(None),
            JsonValue::String(value) => Ok(Some(value.clone())),
            _ => Err(BundleComparisonError::new(
                "native-runtime-bundle-comparison-field-invalid",
            )),
        })
        .unwrap_or_else(|| {
            Err(BundleComparisonError::new(
                "native-runtime-bundle-comparison-field-invalid",
            ))
        })
}

fn string(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn optional_string(value: &Option<String>) -> JsonValue {
    value
        .as_ref()
        .map(|value| string(value))
        .unwrap_or(JsonValue::Null)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn is_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
