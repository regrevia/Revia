use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    cross_language::{CrossLanguageBackendResult, parse_backend_result, serialize_backend_result},
    digest::sha256_hex,
    graph::{graph_revision, load_canonical_graph},
    project::parse_json,
    replay::{parse_native_replay_transcript, serialize_native_replay_transcript},
    vm::CapabilityResponse,
};

pub const COMPARISON_CATALOG_SCHEMA: &str = "re.native-comparison-catalog@0.1.0";
pub const COMPARISON_REPORT_SCHEMA: &str = "re.native-comparison-catalog-report@0.1.0";
const WORKLOAD_KINDS: [&str; 4] = [
    "success",
    "closed-error",
    "host-boundary",
    "project-workflow",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonCatalogError {
    pub code: String,
}

impl ComparisonCatalogError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonApplicability {
    pub semantic: bool,
    pub result: bool,
    pub receipt: bool,
}

impl ComparisonApplicability {
    pub fn all() -> Self {
        Self {
            semantic: true,
            result: true,
            receipt: true,
        }
    }

    pub fn native_result_and_receipt() -> Self {
        Self {
            semantic: false,
            result: true,
            receipt: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonWorkload {
    pub workload_id: String,
    pub kind: String,
    pub source: String,
    pub input_digest: String,
    pub transcript: String,
    pub project_digest: Option<String>,
    pub project_module: Option<String>,
    pub applicability: ComparisonApplicability,
    pub node_result: Option<CrossLanguageBackendResult>,
}

impl ComparisonWorkload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workload_id: impl Into<String>,
        kind: impl Into<String>,
        source: impl Into<String>,
        input_digest: impl Into<String>,
        transcript: impl Into<String>,
        project_digest: Option<String>,
        project_module: Option<String>,
        applicability: ComparisonApplicability,
        node_result: Option<CrossLanguageBackendResult>,
    ) -> Self {
        Self {
            workload_id: workload_id.into(),
            kind: kind.into(),
            source: source.into(),
            input_digest: input_digest.into(),
            transcript: transcript.into(),
            project_digest,
            project_module,
            applicability,
            node_result,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonCatalog {
    pub schema: String,
    pub workloads: Vec<ComparisonWorkload>,
}

impl ComparisonCatalog {
    pub fn new(workloads: Vec<ComparisonWorkload>) -> Self {
        Self {
            schema: COMPARISON_CATALOG_SCHEMA.to_owned(),
            workloads,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonObservation {
    pub workload_id: String,
    pub kind: String,
    pub graph_revision: String,
    pub project_digest: Option<String>,
    pub input_digest: String,
    pub transcript_digest: String,
    pub applicability: ComparisonApplicability,
    pub native_result: Option<CrossLanguageBackendResult>,
    pub native_fault_code: Option<String>,
    pub node_result: Option<CrossLanguageBackendResult>,
    pub status: String,
}

impl ComparisonObservation {
    pub fn new(
        workload: &ComparisonWorkload,
        graph_revision: impl Into<String>,
        transcript_digest: impl Into<String>,
        native_result: CrossLanguageBackendResult,
        node_result: Option<CrossLanguageBackendResult>,
    ) -> Self {
        Self {
            workload_id: workload.workload_id.clone(),
            kind: workload.kind.clone(),
            graph_revision: graph_revision.into(),
            project_digest: workload.project_digest.clone(),
            input_digest: workload.input_digest.clone(),
            transcript_digest: transcript_digest.into(),
            applicability: workload.applicability.clone(),
            native_result: Some(native_result),
            native_fault_code: None,
            node_result,
            status: "measured".to_owned(),
        }
    }

    pub fn fault(
        workload: &ComparisonWorkload,
        graph_revision: impl Into<String>,
        transcript_digest: impl Into<String>,
        code: impl Into<String>,
    ) -> Self {
        Self {
            workload_id: workload.workload_id.clone(),
            kind: workload.kind.clone(),
            graph_revision: graph_revision.into(),
            project_digest: workload.project_digest.clone(),
            input_digest: workload.input_digest.clone(),
            transcript_digest: transcript_digest.into(),
            applicability: workload.applicability.clone(),
            native_result: None,
            native_fault_code: Some(code.into()),
            node_result: None,
            status: "fault-observed".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComparisonReport {
    pub schema: String,
    pub catalog_digest: String,
    pub observations: Vec<ComparisonObservation>,
    pub status: String,
    pub report_digest: String,
}

pub fn build_comparison_report(
    catalog: &ComparisonCatalog,
    observations: Vec<ComparisonObservation>,
) -> Result<ComparisonReport, ComparisonCatalogError> {
    validate_comparison_catalog(catalog)?;
    let report = ComparisonReport {
        schema: COMPARISON_REPORT_SCHEMA.to_owned(),
        catalog_digest: catalog_digest(catalog)?,
        observations,
        status: "measured".to_owned(),
        report_digest: String::new(),
    };
    validate_report_content(catalog, &report)?;
    let mut report = report;
    report.report_digest = report_digest(&report)?;
    validate_comparison_report(catalog, &report)?;
    Ok(report)
}

pub fn validate_comparison_catalog(
    catalog: &ComparisonCatalog,
) -> Result<(), ComparisonCatalogError> {
    if catalog.schema != COMPARISON_CATALOG_SCHEMA {
        return Err(ComparisonCatalogError::new(
            "comparison-catalog-schema-mismatch",
        ));
    }
    if catalog.workloads.len() != WORKLOAD_KINDS.len() {
        return Err(ComparisonCatalogError::new(
            "comparison-catalog-workload-set-invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for workload in &catalog.workloads {
        if !valid_id(&workload.workload_id) || !ids.insert(workload.workload_id.clone()) {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-workload-id-invalid",
            ));
        }
        if !WORKLOAD_KINDS.contains(&workload.kind.as_str()) || !kinds.insert(workload.kind.clone())
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-workload-kind-invalid",
            ));
        }
        if !is_digest(&workload.input_digest) || workload.source.contains('\0') {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-authority-invalid",
            ));
        }
        let graph = load_canonical_graph(&workload.source)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-source-invalid"))?;
        let canonical_source = crate::graph::serialize_canonical_graph(&graph)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-source-invalid"))?;
        if canonical_source != workload.source || graph_revision(&graph).is_err() {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-source-non-canonical",
            ));
        }
        let transcript = parse_native_replay_transcript(&workload.transcript)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-transcript-invalid"))?;
        if serialize_native_replay_transcript(&transcript)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-transcript-invalid"))?
            != workload.transcript
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-transcript-non-canonical",
            ));
        }
        if transcript
            .invocations
            .iter()
            .any(|invocation| invocation.instance.contains('/') || invocation.member.contains('/'))
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-transcript-path-invalid",
            ));
        }
        let host_fault_count = transcript
            .invocations
            .iter()
            .filter(|invocation| {
                matches!(&invocation.response, CapabilityResponse::HostFault { .. })
            })
            .count();
        let error_value_count = transcript
            .invocations
            .iter()
            .filter(|invocation| {
                matches!(
                    &invocation.response,
                    CapabilityResponse::Value { variant, .. } if variant == "err"
                )
            })
            .count();
        if (workload.kind == "host-boundary" && host_fault_count != 1)
            || (workload.kind != "host-boundary" && host_fault_count != 0)
            || (workload.kind == "closed-error" && error_value_count == 0)
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-transcript-kind-mismatch",
            ));
        }
        let project_required = workload.kind == "project-workflow";
        if project_required != workload.project_digest.is_some()
            || project_required != workload.project_module.is_some()
            || workload
                .project_digest
                .as_deref()
                .is_some_and(|value| !is_digest(value))
            || workload
                .project_module
                .as_deref()
                .is_some_and(|value| !valid_id(value))
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-project-authority-invalid",
            ));
        }
        if !workload.applicability.result
            && !workload.applicability.receipt
            && !workload.applicability.semantic
            && workload.kind != "host-boundary"
        {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-applicability-empty",
            ));
        }
        if workload.applicability.semantic != workload.node_result.is_some() {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-semantic-authority-invalid",
            ));
        }
        if let Some(node) = &workload.node_result {
            if node.backend != "node" {
                return Err(ComparisonCatalogError::new(
                    "comparison-catalog-unknown-backend",
                ));
            }
            serialize_backend_result(node).map_err(|_| {
                ComparisonCatalogError::new("comparison-catalog-node-result-invalid")
            })?;
            let expected_graph = graph_revision(&graph)
                .map_err(|_| ComparisonCatalogError::new("comparison-catalog-source-invalid"))?;
            let transcript_source =
                serialize_native_replay_transcript(&transcript).map_err(|_| {
                    ComparisonCatalogError::new("comparison-catalog-transcript-invalid")
                })?;
            if node.graph_revision != expected_graph
                || node.input_digest != workload.input_digest
                || node.transcript_digest != digest_bytes(transcript_source.as_bytes())
            {
                return Err(ComparisonCatalogError::new(
                    "comparison-catalog-node-authority-mismatch",
                ));
            }
        }
    }
    for kind in WORKLOAD_KINDS {
        if !kinds.contains(kind) {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-workload-kind-missing",
            ));
        }
    }
    Ok(())
}

pub fn validate_comparison_report(
    catalog: &ComparisonCatalog,
    report: &ComparisonReport,
) -> Result<(), ComparisonCatalogError> {
    validate_report_content(catalog, report)?;
    if report.catalog_digest != catalog_digest(catalog)? {
        return Err(ComparisonCatalogError::new(
            "comparison-report-catalog-digest-mismatch",
        ));
    }
    if report.report_digest != report_digest(report)? {
        return Err(ComparisonCatalogError::new(
            "comparison-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_comparison_catalog(
    catalog: &ComparisonCatalog,
) -> Result<String, ComparisonCatalogError> {
    validate_comparison_catalog(catalog)?;
    Ok(format!("{}\n", canonicalize(&catalog_json(catalog)?)))
}

pub fn parse_comparison_catalog(source: &str) -> Result<ComparisonCatalog, ComparisonCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ComparisonCatalogError::new("comparison-catalog-json-invalid"))?;
    let entries = exact_object(&value, &["schema", "workloads"])?;
    let values = match entries.get("workloads") {
        Some(JsonValue::Array(values)) => values,
        _ => {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-workloads-invalid",
            ));
        }
    };
    let workloads = values
        .iter()
        .map(parse_workload)
        .collect::<Result<Vec<_>, _>>()?;
    let catalog = ComparisonCatalog {
        schema: required_string(&entries, "schema")?.to_owned(),
        workloads,
    };
    validate_comparison_catalog(&catalog)?;
    if serialize_comparison_catalog(&catalog)?.as_str() != source {
        return Err(ComparisonCatalogError::new(
            "comparison-catalog-non-canonical-source",
        ));
    }
    Ok(catalog)
}

pub fn parse_comparison_report(
    catalog: &ComparisonCatalog,
    source: &str,
) -> Result<ComparisonReport, ComparisonCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ComparisonCatalogError::new("comparison-report-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "catalog_digest",
            "observations",
            "report_digest",
            "schema",
            "status",
        ],
    )?;
    let observations = match entries.get("observations") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_observation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ComparisonCatalogError::new(
                "comparison-report-observations-invalid",
            ));
        }
    };
    let report = ComparisonReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        observations,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    validate_comparison_report(catalog, &report)?;
    if serialize_comparison_report(&report)?.as_str() != source {
        return Err(ComparisonCatalogError::new(
            "comparison-report-non-canonical-source",
        ));
    }
    Ok(report)
}

pub fn serialize_comparison_report(
    report: &ComparisonReport,
) -> Result<String, ComparisonCatalogError> {
    if report.schema != COMPARISON_REPORT_SCHEMA
        || report.status != "measured"
        || report.report_digest != report_digest(report)?
    {
        return Err(ComparisonCatalogError::new(
            "comparison-report-authority-invalid",
        ));
    }
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

pub fn catalog_digest(catalog: &ComparisonCatalog) -> Result<String, ComparisonCatalogError> {
    validate_comparison_catalog(catalog)?;
    Ok(digest_json(&catalog_json(catalog)?))
}

pub fn comparison_semantic_digest(
    catalog: &ComparisonCatalog,
    report: &ComparisonReport,
) -> Result<String, ComparisonCatalogError> {
    validate_comparison_report(catalog, report)?;
    let semantic_observations = report
        .observations
        .iter()
        .map(|observation| {
            object(vec![
                ("kind", JsonValue::String(observation.kind.clone())),
                (
                    "native_fault_code",
                    observation
                        .native_fault_code
                        .as_ref()
                        .map(|code| JsonValue::String(code.clone()))
                        .unwrap_or(JsonValue::Null),
                ),
                (
                    "semantic_applicable",
                    JsonValue::Bool(observation.applicability.semantic),
                ),
                (
                    "semantic_digest",
                    observation
                        .native_result
                        .as_ref()
                        .map(|result| JsonValue::String(result.semantic_digest.clone()))
                        .unwrap_or(JsonValue::Null),
                ),
                ("status", JsonValue::String(observation.status.clone())),
                (
                    "workload_id",
                    JsonValue::String(observation.workload_id.clone()),
                ),
            ])
        })
        .collect();
    Ok(digest_json(&JsonValue::Array(semantic_observations)))
}

fn validate_report_content(
    catalog: &ComparisonCatalog,
    report: &ComparisonReport,
) -> Result<(), ComparisonCatalogError> {
    if report.schema != COMPARISON_REPORT_SCHEMA
        || report.status != "measured"
        || report.observations.len() != catalog.workloads.len()
    {
        return Err(ComparisonCatalogError::new(
            "comparison-report-workload-set-invalid",
        ));
    }
    for (workload, observation) in catalog.workloads.iter().zip(&report.observations) {
        let graph = load_canonical_graph(&workload.source)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-source-invalid"))?;
        let expected_graph = graph_revision(&graph)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-source-invalid"))?;
        let transcript = parse_native_replay_transcript(&workload.transcript)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-transcript-invalid"))?;
        let transcript_source = serialize_native_replay_transcript(&transcript)
            .map_err(|_| ComparisonCatalogError::new("comparison-catalog-transcript-invalid"))?;
        let expected_transcript = digest_bytes(transcript_source.as_bytes());
        if observation.workload_id != workload.workload_id
            || observation.kind != workload.kind
            || observation.graph_revision != expected_graph
            || observation.project_digest != workload.project_digest
            || observation.input_digest != workload.input_digest
            || observation.transcript_digest != expected_transcript
            || observation.applicability != workload.applicability
            || (observation.status != "measured" && observation.status != "fault-observed")
        {
            return Err(ComparisonCatalogError::new(
                "comparison-report-authority-mismatch",
            ));
        }
        if let Some(native) = &observation.native_result {
            if observation.status != "measured" || observation.native_fault_code.is_some() {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-native-observation-status-invalid",
                ));
            }
            validate_backend(
                native,
                "native",
                &expected_graph,
                &workload.input_digest,
                &expected_transcript,
            )?;
        } else if workload.kind != "host-boundary"
            || observation
                .native_fault_code
                .as_deref()
                .is_none_or(str::is_empty)
            || observation.status != "fault-observed"
            || observation.applicability.semantic
            || observation.applicability.result
            || observation.applicability.receipt
        {
            return Err(ComparisonCatalogError::new(
                "comparison-report-native-observation-invalid",
            ));
        }
        if observation.applicability.semantic {
            let native = observation.native_result.as_ref().ok_or_else(|| {
                ComparisonCatalogError::new("comparison-report-semantic-result-missing")
            })?;
            let node = observation.node_result.as_ref().ok_or_else(|| {
                ComparisonCatalogError::new("comparison-report-semantic-result-missing")
            })?;
            if Some(node) != workload.node_result.as_ref() {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-node-authority-mismatch",
                ));
            }
            validate_backend(
                node,
                "node",
                &expected_graph,
                &workload.input_digest,
                &expected_transcript,
            )?;
            if node.semantic_digest != native.semantic_digest {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-semantic-mismatch",
                ));
            }
        } else if observation.node_result.is_some() {
            return Err(ComparisonCatalogError::new(
                "comparison-report-unapplicable-node-result",
            ));
        }
        if workload.kind == "host-boundary" {
            let expected_fault = transcript.invocations.iter().find_map(|invocation| {
                if let CapabilityResponse::HostFault { code } = &invocation.response {
                    Some(code.as_str())
                } else {
                    None
                }
            });
            if observation.native_fault_code.as_deref() != expected_fault {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-host-fault-authority-mismatch",
                ));
            }
        }
        if let Some(native) = &observation.native_result {
            if observation.applicability.result && native.result_digest.is_empty() {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-result-authority-invalid",
                ));
            }
            if observation.applicability.receipt && native.receipt_digest.is_empty() {
                return Err(ComparisonCatalogError::new(
                    "comparison-report-receipt-authority-invalid",
                ));
            }
        }
    }
    Ok(())
}

fn validate_backend(
    result: &CrossLanguageBackendResult,
    backend: &str,
    graph_revision: &str,
    input_digest: &str,
    transcript_digest: &str,
) -> Result<(), ComparisonCatalogError> {
    if result.backend != backend
        || result.graph_revision != graph_revision
        || result.input_digest != input_digest
        || result.transcript_digest != transcript_digest
    {
        return Err(ComparisonCatalogError::new(
            "comparison-report-backend-authority-mismatch",
        ));
    }
    serialize_backend_result(result)
        .map_err(|_| ComparisonCatalogError::new("comparison-report-backend-invalid"))?;
    Ok(())
}

fn parse_workload(value: &JsonValue) -> Result<ComparisonWorkload, ComparisonCatalogError> {
    let entries = exact_object(
        value,
        &[
            "applicability",
            "kind",
            "node_result",
            "project_digest",
            "project_module",
            "source",
            "transcript",
            "input_digest",
            "workload_id",
        ],
    )?;
    let applicability_value = entries
        .get("applicability")
        .ok_or_else(|| ComparisonCatalogError::new("comparison-catalog-applicability-invalid"))?;
    let applicability_entries =
        exact_object(applicability_value, &["receipt", "result", "semantic"])?;
    let applicability = ComparisonApplicability {
        semantic: required_bool(&applicability_entries, "semantic")?,
        result: required_bool(&applicability_entries, "result")?,
        receipt: required_bool(&applicability_entries, "receipt")?,
    };
    let node_result = match entries.get("node_result") {
        Some(JsonValue::Null) => None,
        Some(value) => Some(
            crate::cross_language::parse_backend_result(&format!("{}\n", canonicalize(value)))
                .map_err(|_| {
                    ComparisonCatalogError::new("comparison-catalog-node-result-invalid")
                })?,
        ),
        None => {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-required-field-missing",
            ));
        }
    };
    let project_digest = optional_string(&entries, "project_digest")?;
    let project_module = optional_string(&entries, "project_module")?;
    Ok(ComparisonWorkload::new(
        required_string(&entries, "workload_id")?,
        required_string(&entries, "kind")?,
        required_string(&entries, "source")?,
        required_string(&entries, "input_digest")?,
        required_string(&entries, "transcript")?,
        project_digest,
        project_module,
        applicability,
        node_result,
    ))
}

fn parse_observation(value: &JsonValue) -> Result<ComparisonObservation, ComparisonCatalogError> {
    let entries = exact_object(
        value,
        &[
            "applicability",
            "graph_revision",
            "input_digest",
            "kind",
            "native_fault_code",
            "native_result",
            "node_result",
            "project_digest",
            "status",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    let applicability_entries = exact_object(
        entries.get("applicability").ok_or_else(|| {
            ComparisonCatalogError::new("comparison-report-applicability-invalid")
        })?,
        &["receipt", "result", "semantic"],
    )?;
    let parse_backend =
        |key: &str| -> Result<Option<CrossLanguageBackendResult>, ComparisonCatalogError> {
            match entries.get(key) {
                Some(JsonValue::Null) => Ok(None),
                Some(value) => Some(
                    parse_backend_result(&format!("{}\n", canonicalize(value))).map_err(|_| {
                        ComparisonCatalogError::new("comparison-report-backend-invalid")
                    }),
                )
                .transpose(),
                None => Err(ComparisonCatalogError::new(
                    "comparison-report-required-field-missing",
                )),
            }
        };
    Ok(ComparisonObservation {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        kind: required_string(&entries, "kind")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        project_digest: optional_string(&entries, "project_digest")?,
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        applicability: ComparisonApplicability {
            receipt: required_bool(&applicability_entries, "receipt")?,
            result: required_bool(&applicability_entries, "result")?,
            semantic: required_bool(&applicability_entries, "semantic")?,
        },
        native_result: parse_backend("native_result")?,
        native_fault_code: optional_string(&entries, "native_fault_code")?,
        node_result: parse_backend("node_result")?,
        status: required_string(&entries, "status")?.to_owned(),
    })
}

fn catalog_json(catalog: &ComparisonCatalog) -> Result<JsonValue, ComparisonCatalogError> {
    Ok(object(vec![
        ("schema", JsonValue::String(catalog.schema.clone())),
        (
            "workloads",
            JsonValue::Array(
                catalog
                    .workloads
                    .iter()
                    .map(workload_json)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
    ]))
}

fn workload_json(workload: &ComparisonWorkload) -> Result<JsonValue, ComparisonCatalogError> {
    Ok(object(vec![
        (
            "applicability",
            object(vec![
                ("receipt", JsonValue::Bool(workload.applicability.receipt)),
                ("result", JsonValue::Bool(workload.applicability.result)),
                ("semantic", JsonValue::Bool(workload.applicability.semantic)),
            ]),
        ),
        (
            "input_digest",
            JsonValue::String(workload.input_digest.clone()),
        ),
        ("kind", JsonValue::String(workload.kind.clone())),
        (
            "node_result",
            workload
                .node_result
                .as_ref()
                .map(|value| {
                    crate::project::parse_json(&serialize_backend_result(value).unwrap()).unwrap()
                })
                .unwrap_or(JsonValue::Null),
        ),
        (
            "project_digest",
            workload
                .project_digest
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "project_module",
            workload
                .project_module
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        ("source", JsonValue::String(workload.source.clone())),
        ("transcript", JsonValue::String(workload.transcript.clone())),
        (
            "workload_id",
            JsonValue::String(workload.workload_id.clone()),
        ),
    ]))
}

fn report_json(
    report: &ComparisonReport,
    include_digest: bool,
) -> Result<JsonValue, ComparisonCatalogError> {
    let mut fields = vec![
        (
            "catalog_digest",
            JsonValue::String(report.catalog_digest.clone()),
        ),
        (
            "observations",
            JsonValue::Array(
                report
                    .observations
                    .iter()
                    .map(observation_json)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        (
            "report_digest",
            JsonValue::String(report.report_digest.clone()),
        ),
        ("schema", JsonValue::String(report.schema.clone())),
        ("status", JsonValue::String(report.status.clone())),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "report_digest");
    }
    Ok(object(fields))
}

fn observation_json(
    observation: &ComparisonObservation,
) -> Result<JsonValue, ComparisonCatalogError> {
    Ok(object(vec![
        (
            "applicability",
            object(vec![
                (
                    "receipt",
                    JsonValue::Bool(observation.applicability.receipt),
                ),
                ("result", JsonValue::Bool(observation.applicability.result)),
                (
                    "semantic",
                    JsonValue::Bool(observation.applicability.semantic),
                ),
            ]),
        ),
        (
            "graph_revision",
            JsonValue::String(observation.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(observation.input_digest.clone()),
        ),
        ("kind", JsonValue::String(observation.kind.clone())),
        (
            "native_fault_code",
            observation
                .native_fault_code
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "native_result",
            observation
                .native_result
                .as_ref()
                .map(parse_backend_json)
                .transpose()?
                .unwrap_or(JsonValue::Null),
        ),
        (
            "node_result",
            observation
                .node_result
                .as_ref()
                .map(parse_backend_json)
                .transpose()?
                .unwrap_or(JsonValue::Null),
        ),
        (
            "project_digest",
            observation
                .project_digest
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        ("status", JsonValue::String(observation.status.clone())),
        (
            "transcript_digest",
            JsonValue::String(observation.transcript_digest.clone()),
        ),
        (
            "workload_id",
            JsonValue::String(observation.workload_id.clone()),
        ),
    ]))
}

fn parse_backend_json(
    result: &CrossLanguageBackendResult,
) -> Result<JsonValue, ComparisonCatalogError> {
    parse_json(
        &serialize_backend_result(result)
            .map_err(|_| ComparisonCatalogError::new("comparison-report-backend-invalid"))?,
    )
    .map_err(|_| ComparisonCatalogError::new("comparison-report-backend-invalid"))
}

fn report_digest(report: &ComparisonReport) -> Result<String, ComparisonCatalogError> {
    Ok(digest_json(&report_json(report, false)?))
}

fn digest_json(value: &JsonValue) -> String {
    digest_bytes(canonicalize(value).as_bytes())
}
fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}
fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'.'
        })
}
fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, ComparisonCatalogError> {
    let JsonValue::Object(entries) = value else {
        return Err(ComparisonCatalogError::new(
            "comparison-catalog-object-invalid",
        ));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) || result.insert(key.clone(), value).is_some() {
            return Err(ComparisonCatalogError::new(
                "comparison-catalog-field-invalid",
            ));
        }
    }
    if result.len() != expected.len() {
        return Err(ComparisonCatalogError::new(
            "comparison-catalog-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    key: &str,
) -> Result<&'a str, ComparisonCatalogError> {
    match entries.get(key) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ComparisonCatalogError::new(
            "comparison-catalog-field-invalid",
        )),
    }
}
fn required_bool(
    entries: &BTreeMap<String, &JsonValue>,
    key: &str,
) -> Result<bool, ComparisonCatalogError> {
    match entries.get(key) {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(ComparisonCatalogError::new(
            "comparison-catalog-field-invalid",
        )),
    }
}
fn optional_string(
    entries: &BTreeMap<String, &JsonValue>,
    key: &str,
) -> Result<Option<String>, ComparisonCatalogError> {
    match entries.get(key) {
        Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => Ok(Some(value.clone())),
        _ => Err(ComparisonCatalogError::new(
            "comparison-catalog-field-invalid",
        )),
    }
}
