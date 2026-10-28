use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    comparison_catalog::{
        ComparisonCatalog, ComparisonReport, catalog_digest, validate_comparison_report,
    },
    cross_language::CrossLanguageBackendResult,
    digest::sha256_hex,
    project::parse_json,
};

pub const EXPERIMENT_KIT_SCHEMA: &str = "re.cross-language-experiment-kit@0.1.0";
pub const EXPERIMENT_BACKEND_SCHEMA: &str = "re.cross-language-experiment-backend-result@0.1.0";
pub const EXPERIMENT_KIT_STATUS_NATIVE_BASELINE: &str = "native-baseline";
pub const EXPERIMENT_KIT_STATUS_SEMANTIC_EQUIVALENT: &str = "semantic-equivalent";

const WORKLOAD_KINDS: [&str; 4] = [
    "success",
    "closed-error",
    "host-boundary",
    "project-workflow",
];
const BACKENDS: [&str; 4] = ["native", "node", "go", "jvm"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExperimentKitError {
    pub code: String,
}

impl ExperimentKitError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExperimentBackendResult {
    pub schema: String,
    pub workload_id: String,
    pub backend: String,
    pub status: String,
    pub target: String,
    pub toolchain_digest: Option<String>,
    pub source_digest: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub semantic_digest: Option<String>,
    pub result_digest: Option<String>,
    pub receipt_digest: Option<String>,
    pub evidence_digest: String,
    pub fault_code: Option<String>,
    pub timing_status: String,
    pub timing_digest: Option<String>,
    pub pending_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExperimentWorkload {
    pub workload_id: String,
    pub kind: String,
    pub source_digest: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub semantic_applicable: bool,
    pub result_applicable: bool,
    pub receipt_applicable: bool,
    pub semantic_status: String,
    pub backends: Vec<ExperimentBackendResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExperimentKit {
    pub schema: String,
    pub catalog_digest: String,
    pub comparison_report_digest: String,
    pub target: String,
    pub toolchain_digest: String,
    pub workloads: Vec<ExperimentWorkload>,
    pub status: String,
    pub kit_digest: String,
}

impl ExperimentKit {
    pub fn new(workloads: Vec<ExperimentWorkload>) -> Self {
        Self {
            schema: EXPERIMENT_KIT_SCHEMA.to_owned(),
            catalog_digest: String::new(),
            comparison_report_digest: String::new(),
            target: String::new(),
            toolchain_digest: String::new(),
            workloads,
            status: String::new(),
            kit_digest: String::new(),
        }
    }
}

pub fn build_experiment_kit(
    catalog: &ComparisonCatalog,
    report: &ComparisonReport,
    target: &str,
    toolchain_digest: &str,
) -> Result<ExperimentKit, ExperimentKitError> {
    validate_comparison_report(catalog, report)
        .map_err(|error| ExperimentKitError::new(&error.code))?;
    let workloads = catalog
        .workloads
        .iter()
        .zip(&report.observations)
        .map(|(workload, observation)| {
            let source_digest = digest_bytes(workload.source.as_bytes());
            let native = match &observation.native_result {
                Some(result) => measured_backend(
                    workload,
                    "native",
                    target,
                    Some(toolchain_digest.to_owned()),
                    Some(result),
                    None,
                ),
                None => fault_backend(
                    workload,
                    target,
                    toolchain_digest,
                    &observation.graph_revision,
                    &observation.transcript_digest,
                    observation.native_fault_code.clone().ok_or_else(|| {
                        ExperimentKitError::new("experiment-kit-native-observation-missing")
                    })?,
                ),
            };
            let node = observation
                .node_result
                .as_ref()
                .map(|result| {
                    measured_backend(
                        workload,
                        "node",
                        "node-reference",
                        Some(result.toolchain_digest.clone()),
                        Some(result),
                        None,
                    )
                })
                .unwrap_or_else(|| {
                    pending_backend(
                        workload,
                        &observation.graph_revision,
                        &observation.transcript_digest,
                        "node",
                        "node-reference",
                        "not-supplied",
                    )
                });
            let semantic_status = if workload.applicability.semantic {
                "equivalent".to_owned()
            } else {
                "not-compared".to_owned()
            };
            Ok(ExperimentWorkload {
                workload_id: workload.workload_id.clone(),
                kind: workload.kind.clone(),
                source_digest,
                graph_revision: observation.graph_revision.clone(),
                input_digest: observation.input_digest.clone(),
                transcript_digest: observation.transcript_digest.clone(),
                semantic_applicable: workload.applicability.semantic,
                result_applicable: workload.applicability.result,
                receipt_applicable: workload.applicability.receipt,
                semantic_status,
                backends: vec![
                    native,
                    node,
                    pending_backend(
                        workload,
                        &observation.graph_revision,
                        &observation.transcript_digest,
                        "go",
                        "pending",
                        "not-measured",
                    ),
                    pending_backend(
                        workload,
                        &observation.graph_revision,
                        &observation.transcript_digest,
                        "jvm",
                        "pending",
                        "not-measured",
                    ),
                ],
            })
        })
        .collect::<Result<Vec<_>, ExperimentKitError>>()?;
    let status = if workloads
        .iter()
        .any(|workload| workload.semantic_applicable)
    {
        EXPERIMENT_KIT_STATUS_SEMANTIC_EQUIVALENT
    } else {
        EXPERIMENT_KIT_STATUS_NATIVE_BASELINE
    };
    let kit = ExperimentKit {
        schema: EXPERIMENT_KIT_SCHEMA.to_owned(),
        catalog_digest: catalog_digest(catalog)
            .map_err(|error| ExperimentKitError::new(&error.code))?,
        comparison_report_digest: report.report_digest.clone(),
        target: target.to_owned(),
        toolchain_digest: toolchain_digest.to_owned(),
        workloads,
        status: status.to_owned(),
        kit_digest: String::new(),
    };
    validate_experiment_kit_content(&kit)?;
    let mut kit = kit;
    kit.kit_digest = kit_digest(&kit)?;
    validate_experiment_kit(&kit)?;
    Ok(kit)
}

pub fn validate_experiment_kit(kit: &ExperimentKit) -> Result<(), ExperimentKitError> {
    validate_experiment_kit_content(kit)?;
    if kit.kit_digest != kit_digest(kit)? {
        return Err(ExperimentKitError::new("experiment-kit-digest-mismatch"));
    }
    Ok(())
}

pub fn validate_experiment_kit_against_report(
    catalog: &ComparisonCatalog,
    report: &ComparisonReport,
    kit: &ExperimentKit,
) -> Result<(), ExperimentKitError> {
    validate_comparison_report(catalog, report)
        .map_err(|error| ExperimentKitError::new(&error.code))?;
    validate_experiment_kit(kit)?;
    let expected = build_experiment_kit(catalog, report, &kit.target, &kit.toolchain_digest)?;
    if &expected != kit {
        return Err(ExperimentKitError::new(
            "experiment-kit-report-authority-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_experiment_kit(kit: &ExperimentKit) -> Result<String, ExperimentKitError> {
    validate_experiment_kit(kit)?;
    Ok(format!("{}\n", canonicalize(&kit_json(kit, true))))
}

pub fn parse_experiment_kit(source: &str) -> Result<ExperimentKit, ExperimentKitError> {
    let value =
        parse_json(source).map_err(|_| ExperimentKitError::new("experiment-kit-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "catalog_digest",
            "comparison_report_digest",
            "kit_digest",
            "schema",
            "status",
            "target",
            "toolchain_digest",
            "workloads",
        ],
    )?;
    let workloads = match entries.get("workloads") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_workload)
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(ExperimentKitError::new("experiment-kit-workloads-invalid")),
    };
    let kit = ExperimentKit {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        comparison_report_digest: required_string(&entries, "comparison_report_digest")?.to_owned(),
        target: required_string(&entries, "target")?.to_owned(),
        toolchain_digest: required_string(&entries, "toolchain_digest")?.to_owned(),
        workloads,
        status: required_string(&entries, "status")?.to_owned(),
        kit_digest: required_string(&entries, "kit_digest")?.to_owned(),
    };
    validate_experiment_kit(&kit)?;
    if serialize_experiment_kit(&kit)?.as_str() != source {
        return Err(ExperimentKitError::new(
            "experiment-kit-non-canonical-source",
        ));
    }
    Ok(kit)
}

fn validate_experiment_kit_content(kit: &ExperimentKit) -> Result<(), ExperimentKitError> {
    if kit.schema != EXPERIMENT_KIT_SCHEMA
        || !valid_id(&kit.target)
        || !is_digest(&kit.catalog_digest)
        || !is_digest(&kit.comparison_report_digest)
        || !is_digest(&kit.toolchain_digest)
        || !matches!(
            kit.status.as_str(),
            EXPERIMENT_KIT_STATUS_NATIVE_BASELINE | EXPERIMENT_KIT_STATUS_SEMANTIC_EQUIVALENT
        )
        || kit.workloads.len() != WORKLOAD_KINDS.len()
    {
        return Err(ExperimentKitError::new("experiment-kit-authority-invalid"));
    }
    let mut ids = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    let mut has_semantic_workload = false;
    for workload in &kit.workloads {
        if !valid_id(&workload.workload_id)
            || !ids.insert(workload.workload_id.clone())
            || !WORKLOAD_KINDS.contains(&workload.kind.as_str())
            || !kinds.insert(workload.kind.clone())
            || !is_digest(&workload.source_digest)
            || !is_digest(&workload.graph_revision)
            || !is_digest(&workload.input_digest)
            || !is_digest(&workload.transcript_digest)
            || !matches!(
                workload.semantic_status.as_str(),
                "equivalent" | "not-compared"
            )
        {
            return Err(ExperimentKitError::new(
                "experiment-kit-workload-authority-invalid",
            ));
        }
        if workload.semantic_applicable {
            has_semantic_workload = true;
            if workload.semantic_status != "equivalent" {
                return Err(ExperimentKitError::new(
                    "experiment-kit-semantic-status-invalid",
                ));
            }
        } else if workload.semantic_status != "not-compared" {
            return Err(ExperimentKitError::new(
                "experiment-kit-semantic-status-invalid",
            ));
        }
        if workload.backends.len() != BACKENDS.len()
            || workload
                .backends
                .iter()
                .map(|backend| backend.backend.as_str())
                .collect::<Vec<_>>()
                != BACKENDS
        {
            return Err(ExperimentKitError::new(
                "experiment-kit-backend-population-invalid",
            ));
        }
        for backend in &workload.backends {
            validate_backend(kit, workload, backend)?;
        }
        let node = &workload.backends[1];
        if workload.semantic_applicable {
            if node.status != "measured"
                || node.semantic_digest != workload.backends[0].semantic_digest
            {
                return Err(ExperimentKitError::new("experiment-kit-semantic-mismatch"));
            }
        } else if node.status != "pending" {
            return Err(ExperimentKitError::new(
                "experiment-kit-node-applicability-invalid",
            ));
        }
    }
    if kinds.len() != WORKLOAD_KINDS.len()
        || !WORKLOAD_KINDS.iter().all(|kind| kinds.contains(*kind))
        || (has_semantic_workload && kit.status != EXPERIMENT_KIT_STATUS_SEMANTIC_EQUIVALENT)
        || (!has_semantic_workload && kit.status != EXPERIMENT_KIT_STATUS_NATIVE_BASELINE)
    {
        return Err(ExperimentKitError::new("experiment-kit-status-invalid"));
    }
    Ok(())
}

fn validate_backend(
    kit: &ExperimentKit,
    workload: &ExperimentWorkload,
    backend: &ExperimentBackendResult,
) -> Result<(), ExperimentKitError> {
    if backend.schema != EXPERIMENT_BACKEND_SCHEMA
        || backend.workload_id != workload.workload_id
        || !is_digest(&backend.source_digest)
        || backend.source_digest != workload.source_digest
        || backend.graph_revision != workload.graph_revision
        || backend.input_digest != workload.input_digest
        || backend.transcript_digest != workload.transcript_digest
        || !is_digest(&backend.evidence_digest)
        || backend.evidence_digest != backend_evidence_digest(backend)
        || !matches!(backend.timing_status.as_str(), "not-measured" | "measured")
        || (backend.timing_status == "measured"
            && !backend.timing_digest.as_deref().is_some_and(is_digest))
        || (backend.timing_status == "not-measured" && backend.timing_digest.is_some())
    {
        return Err(ExperimentKitError::new(
            "experiment-kit-backend-authority-invalid",
        ));
    }
    match backend.backend.as_str() {
        "native" => {
            if backend.target != kit.target
                || backend.toolchain_digest.as_deref() != Some(&kit.toolchain_digest)
            {
                return Err(ExperimentKitError::new(
                    "experiment-kit-native-authority-invalid",
                ));
            }
            validate_measured_or_fault(backend, workload)?;
        }
        "node" => {
            if backend.status == "measured" {
                if backend.target != "node-reference"
                    || !backend.toolchain_digest.as_deref().is_some_and(is_digest)
                {
                    return Err(ExperimentKitError::new(
                        "experiment-kit-node-authority-invalid",
                    ));
                }
                validate_measured_or_fault(backend, workload)?;
            } else {
                validate_pending(backend, "node-reference")?;
            }
        }
        "go" | "jvm" => {
            validate_pending(backend, "pending")?;
        }
        _ => return Err(ExperimentKitError::new("experiment-kit-backend-unknown")),
    }
    Ok(())
}

fn validate_measured_or_fault(
    backend: &ExperimentBackendResult,
    workload: &ExperimentWorkload,
) -> Result<(), ExperimentKitError> {
    match backend.status.as_str() {
        "measured" => {
            if backend.fault_code.is_some()
                || backend.pending_reason.is_some()
                || !backend.semantic_digest.as_deref().is_some_and(is_digest)
                || !backend.result_digest.as_deref().is_some_and(is_digest)
                || !backend.receipt_digest.as_deref().is_some_and(is_digest)
            {
                return Err(ExperimentKitError::new(
                    "experiment-kit-measured-result-incomplete",
                ));
            }
        }
        "fault-observed" => {
            if workload.semantic_applicable
                || workload.result_applicable
                || workload.receipt_applicable
                || backend.fault_code.as_deref().is_none_or(str::is_empty)
                || backend.semantic_digest.is_some()
                || backend.result_digest.is_some()
                || backend.receipt_digest.is_some()
                || backend.pending_reason.is_some()
            {
                return Err(ExperimentKitError::new(
                    "experiment-kit-fault-authority-invalid",
                ));
            }
        }
        _ => {
            return Err(ExperimentKitError::new(
                "experiment-kit-measured-status-invalid",
            ));
        }
    }
    Ok(())
}

fn validate_pending(
    backend: &ExperimentBackendResult,
    target: &str,
) -> Result<(), ExperimentKitError> {
    if backend.status != "pending"
        || backend.target != target
        || backend.toolchain_digest.is_some()
        || backend.semantic_digest.is_some()
        || backend.result_digest.is_some()
        || backend.receipt_digest.is_some()
        || backend.fault_code.is_some()
        || backend.pending_reason.as_deref().is_none_or(str::is_empty)
    {
        return Err(ExperimentKitError::new(
            "experiment-kit-pending-authority-invalid",
        ));
    }
    Ok(())
}

fn measured_backend(
    workload: &crate::comparison_catalog::ComparisonWorkload,
    backend: &str,
    target: &str,
    toolchain_digest: Option<String>,
    result: Option<&CrossLanguageBackendResult>,
    fault_code: Option<String>,
) -> ExperimentBackendResult {
    let result = result.expect("measured backend requires a result");
    let mut backend = ExperimentBackendResult {
        schema: EXPERIMENT_BACKEND_SCHEMA.to_owned(),
        workload_id: workload.workload_id.clone(),
        backend: backend.to_owned(),
        status: "measured".to_owned(),
        target: target.to_owned(),
        toolchain_digest,
        source_digest: digest_bytes(workload.source.as_bytes()),
        graph_revision: result.graph_revision.clone(),
        input_digest: result.input_digest.clone(),
        transcript_digest: result.transcript_digest.clone(),
        semantic_digest: Some(result.semantic_digest.clone()),
        result_digest: Some(result.result_digest.clone()),
        receipt_digest: Some(result.receipt_digest.clone()),
        evidence_digest: String::new(),
        fault_code,
        timing_status: "not-measured".to_owned(),
        timing_digest: None,
        pending_reason: None,
    };
    backend.evidence_digest = backend_evidence_digest(&backend);
    backend
}

fn fault_backend(
    workload: &crate::comparison_catalog::ComparisonWorkload,
    target: &str,
    toolchain_digest: &str,
    graph_revision: &str,
    transcript_digest: &str,
    fault_code: String,
) -> ExperimentBackendResult {
    let mut backend = ExperimentBackendResult {
        schema: EXPERIMENT_BACKEND_SCHEMA.to_owned(),
        workload_id: workload.workload_id.clone(),
        backend: "native".to_owned(),
        status: "fault-observed".to_owned(),
        target: target.to_owned(),
        toolchain_digest: Some(toolchain_digest.to_owned()),
        source_digest: digest_bytes(workload.source.as_bytes()),
        graph_revision: graph_revision.to_owned(),
        input_digest: workload.input_digest.clone(),
        transcript_digest: transcript_digest.to_owned(),
        semantic_digest: None,
        result_digest: None,
        receipt_digest: None,
        evidence_digest: String::new(),
        fault_code: Some(fault_code),
        timing_status: "not-measured".to_owned(),
        timing_digest: None,
        pending_reason: None,
    };
    backend.evidence_digest = backend_evidence_digest(&backend);
    backend
}

fn pending_backend(
    workload: &crate::comparison_catalog::ComparisonWorkload,
    graph_revision: &str,
    transcript_digest: &str,
    backend: &str,
    target: &str,
    reason: &str,
) -> ExperimentBackendResult {
    let mut backend = ExperimentBackendResult {
        schema: EXPERIMENT_BACKEND_SCHEMA.to_owned(),
        workload_id: workload.workload_id.clone(),
        backend: backend.to_owned(),
        status: "pending".to_owned(),
        target: target.to_owned(),
        toolchain_digest: None,
        source_digest: digest_bytes(workload.source.as_bytes()),
        graph_revision: graph_revision.to_owned(),
        input_digest: workload.input_digest.clone(),
        transcript_digest: transcript_digest.to_owned(),
        semantic_digest: None,
        result_digest: None,
        receipt_digest: None,
        evidence_digest: String::new(),
        fault_code: None,
        timing_status: "not-measured".to_owned(),
        timing_digest: None,
        pending_reason: Some(reason.to_owned()),
    };
    backend.evidence_digest = backend_evidence_digest(&backend);
    backend
}

fn parse_workload(value: &JsonValue) -> Result<ExperimentWorkload, ExperimentKitError> {
    let entries = exact_object(
        value,
        &[
            "backends",
            "graph_revision",
            "input_digest",
            "kind",
            "receipt_applicable",
            "result_applicable",
            "semantic_applicable",
            "semantic_status",
            "source_digest",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    let backends = match entries.get("backends") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_backend)
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(ExperimentKitError::new("experiment-kit-backends-invalid")),
    };
    Ok(ExperimentWorkload {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        kind: required_string(&entries, "kind")?.to_owned(),
        source_digest: required_string(&entries, "source_digest")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        semantic_applicable: required_bool(&entries, "semantic_applicable")?,
        result_applicable: required_bool(&entries, "result_applicable")?,
        receipt_applicable: required_bool(&entries, "receipt_applicable")?,
        semantic_status: required_string(&entries, "semantic_status")?.to_owned(),
        backends,
    })
}

fn parse_backend(value: &JsonValue) -> Result<ExperimentBackendResult, ExperimentKitError> {
    let entries = exact_object(
        value,
        &[
            "backend",
            "evidence_digest",
            "fault_code",
            "graph_revision",
            "input_digest",
            "pending_reason",
            "receipt_digest",
            "result_digest",
            "schema",
            "semantic_digest",
            "source_digest",
            "status",
            "target",
            "timing_digest",
            "timing_status",
            "toolchain_digest",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    Ok(ExperimentBackendResult {
        schema: required_string(&entries, "schema")?.to_owned(),
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        backend: required_string(&entries, "backend")?.to_owned(),
        evidence_digest: required_string(&entries, "evidence_digest")?.to_owned(),
        status: required_string(&entries, "status")?.to_owned(),
        target: required_string(&entries, "target")?.to_owned(),
        toolchain_digest: optional_string(&entries, "toolchain_digest")?,
        source_digest: required_string(&entries, "source_digest")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        semantic_digest: optional_string(&entries, "semantic_digest")?,
        result_digest: optional_string(&entries, "result_digest")?,
        receipt_digest: optional_string(&entries, "receipt_digest")?,
        fault_code: optional_string(&entries, "fault_code")?,
        timing_status: required_string(&entries, "timing_status")?.to_owned(),
        timing_digest: optional_string(&entries, "timing_digest")?,
        pending_reason: optional_string(&entries, "pending_reason")?,
    })
}

fn kit_json(kit: &ExperimentKit, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "catalog_digest",
            JsonValue::String(kit.catalog_digest.clone()),
        ),
        (
            "comparison_report_digest",
            JsonValue::String(kit.comparison_report_digest.clone()),
        ),
        (
            "kit_digest",
            if include_digest {
                JsonValue::String(kit.kit_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        ("schema", JsonValue::String(kit.schema.clone())),
        ("status", JsonValue::String(kit.status.clone())),
        ("target", JsonValue::String(kit.target.clone())),
        (
            "toolchain_digest",
            JsonValue::String(kit.toolchain_digest.clone()),
        ),
        (
            "workloads",
            JsonValue::Array(kit.workloads.iter().map(workload_json).collect()),
        ),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "kit_digest");
    }
    object(fields)
}

fn workload_json(workload: &ExperimentWorkload) -> JsonValue {
    object(vec![
        (
            "backends",
            JsonValue::Array(
                workload
                    .backends
                    .iter()
                    .map(|backend| backend_json(backend, true))
                    .collect(),
            ),
        ),
        (
            "graph_revision",
            JsonValue::String(workload.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(workload.input_digest.clone()),
        ),
        ("kind", JsonValue::String(workload.kind.clone())),
        (
            "receipt_applicable",
            JsonValue::Bool(workload.receipt_applicable),
        ),
        (
            "result_applicable",
            JsonValue::Bool(workload.result_applicable),
        ),
        (
            "semantic_applicable",
            JsonValue::Bool(workload.semantic_applicable),
        ),
        (
            "semantic_status",
            JsonValue::String(workload.semantic_status.clone()),
        ),
        (
            "source_digest",
            JsonValue::String(workload.source_digest.clone()),
        ),
        (
            "transcript_digest",
            JsonValue::String(workload.transcript_digest.clone()),
        ),
        (
            "workload_id",
            JsonValue::String(workload.workload_id.clone()),
        ),
    ])
}

fn backend_json(backend: &ExperimentBackendResult, include_evidence: bool) -> JsonValue {
    object(vec![
        ("backend", JsonValue::String(backend.backend.clone())),
        (
            "evidence_digest",
            if include_evidence {
                JsonValue::String(backend.evidence_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        ("fault_code", optional_json(backend.fault_code.as_deref())),
        (
            "graph_revision",
            JsonValue::String(backend.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(backend.input_digest.clone()),
        ),
        (
            "pending_reason",
            optional_json(backend.pending_reason.as_deref()),
        ),
        (
            "receipt_digest",
            optional_json(backend.receipt_digest.as_deref()),
        ),
        (
            "result_digest",
            optional_json(backend.result_digest.as_deref()),
        ),
        ("schema", JsonValue::String(backend.schema.clone())),
        (
            "semantic_digest",
            optional_json(backend.semantic_digest.as_deref()),
        ),
        (
            "source_digest",
            JsonValue::String(backend.source_digest.clone()),
        ),
        ("status", JsonValue::String(backend.status.clone())),
        ("target", JsonValue::String(backend.target.clone())),
        (
            "timing_digest",
            optional_json(backend.timing_digest.as_deref()),
        ),
        (
            "timing_status",
            JsonValue::String(backend.timing_status.clone()),
        ),
        (
            "toolchain_digest",
            optional_json(backend.toolchain_digest.as_deref()),
        ),
        (
            "transcript_digest",
            JsonValue::String(backend.transcript_digest.clone()),
        ),
        (
            "workload_id",
            JsonValue::String(backend.workload_id.clone()),
        ),
    ])
}

fn kit_digest(kit: &ExperimentKit) -> Result<String, ExperimentKitError> {
    Ok(digest_bytes(canonicalize(&kit_json(kit, false)).as_bytes()))
}

fn backend_evidence_digest(backend: &ExperimentBackendResult) -> String {
    digest_bytes(canonicalize(&backend_json(backend, false)).as_bytes())
}

fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, ExperimentKitError> {
    let JsonValue::Object(entries) = value else {
        return Err(ExperimentKitError::new("experiment-kit-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) || result.insert(key.clone(), value).is_some() {
            return Err(ExperimentKitError::new(
                "experiment-kit-unexpected-or-duplicate-field",
            ));
        }
    }
    if result.len() != expected.len() {
        return Err(ExperimentKitError::new(
            "experiment-kit-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, ExperimentKitError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ExperimentKitError::new("experiment-kit-field-invalid")),
    }
}

fn required_bool(
    entries: &BTreeMap<String, &JsonValue>,
    name: &str,
) -> Result<bool, ExperimentKitError> {
    match entries.get(name) {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(ExperimentKitError::new("experiment-kit-field-invalid")),
    }
}

fn optional_string(
    entries: &BTreeMap<String, &JsonValue>,
    name: &str,
) -> Result<Option<String>, ExperimentKitError> {
    match entries.get(name) {
        Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(value)) => Ok(Some(value.clone())),
        _ => Err(ExperimentKitError::new("experiment-kit-field-invalid")),
    }
}

fn optional_json(value: Option<&str>) -> JsonValue {
    value
        .map(|value| JsonValue::String(value.to_owned()))
        .unwrap_or(JsonValue::Null)
}

fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    )
}

fn digest_bytes(bytes: &[u8]) -> String {
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

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
