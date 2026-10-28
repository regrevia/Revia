use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
    replay::{parse_native_replay_transcript, serialize_native_replay_transcript},
};

pub const REPLAY_FAULT_CATALOG_SCHEMA: &str = "re.native-replay-fault-catalog@0.1.0";
pub const REPLAY_FAULT_REPORT_SCHEMA: &str = "re.native-replay-fault-report@0.1.0";
pub const REPLAY_FAULT_RESULT_SCHEMA: &str = "re.native-replay-fault-result@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultCatalogError {
    pub code: String,
}

impl ReplayFaultCatalogError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayFaultKind {
    ReplayMismatch,
    CheckFailure,
    HostFault,
}

impl ReplayFaultKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReplayMismatch => "replay-mismatch",
            Self::CheckFailure => "check-failure",
            Self::HostFault => "host-fault",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, ReplayFaultCatalogError> {
        match value {
            "replay-mismatch" => Ok(Self::ReplayMismatch),
            "check-failure" => Ok(Self::CheckFailure),
            "host-fault" => Ok(Self::HostFault),
            _ => Err(ReplayFaultCatalogError::new("replay-fault-kind-invalid")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultWorkload {
    pub workload_id: String,
    pub source: String,
    pub input_digest: String,
    pub transcript: String,
    pub expected_kind: ReplayFaultKind,
    pub code: String,
    pub node_fault: Option<ReplayFaultResult>,
}

impl ReplayFaultWorkload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workload_id: impl Into<String>,
        source: impl Into<String>,
        input_digest: impl Into<String>,
        transcript: impl Into<String>,
        expected_kind: ReplayFaultKind,
        code: impl Into<String>,
        node_fault: Option<ReplayFaultResult>,
    ) -> Self {
        Self {
            workload_id: workload_id.into(),
            source: source.into(),
            input_digest: input_digest.into(),
            transcript: transcript.into(),
            expected_kind,
            code: code.into(),
            node_fault,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultCatalog {
    pub schema: String,
    pub workloads: Vec<ReplayFaultWorkload>,
}

impl ReplayFaultCatalog {
    pub fn new(workloads: Vec<ReplayFaultWorkload>) -> Self {
        Self {
            schema: REPLAY_FAULT_CATALOG_SCHEMA.to_owned(),
            workloads,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultResult {
    pub schema: String,
    pub backend: String,
    pub kind: ReplayFaultKind,
    pub code: String,
    pub graph_revision: Option<String>,
    pub input_digest: String,
    pub transcript_digest: String,
    pub toolchain_digest: String,
    pub receipt_digest: Option<String>,
    pub semantic_digest: String,
    pub result_digest: String,
    pub status: String,
}

impl ReplayFaultResult {
    pub fn measured(
        backend: impl Into<String>,
        graph_revision: Option<&str>,
        input_digest: impl Into<String>,
        transcript_digest: impl Into<String>,
        kind: ReplayFaultKind,
        code: impl Into<String>,
        toolchain_digest: impl Into<String>,
    ) -> Self {
        let mut result = Self {
            schema: REPLAY_FAULT_RESULT_SCHEMA.to_owned(),
            backend: backend.into(),
            kind,
            code: code.into(),
            graph_revision: graph_revision.map(str::to_owned),
            input_digest: input_digest.into(),
            transcript_digest: transcript_digest.into(),
            toolchain_digest: toolchain_digest.into(),
            receipt_digest: None,
            semantic_digest: String::new(),
            result_digest: String::new(),
            status: "measured".to_owned(),
        };
        result.semantic_digest = fault_semantic_digest(result.kind, &result.code);
        result.result_digest = fault_result_digest(&result);
        result
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultWorkloadObservation {
    pub workload_id: String,
    pub graph_revision: Option<String>,
    pub input_digest: String,
    pub transcript_digest: String,
    pub native: ReplayFaultResult,
    pub node: Option<ReplayFaultResult>,
    pub pending: Vec<PendingFaultBackend>,
    pub status: String,
}

impl ReplayFaultWorkloadObservation {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workload_id: impl Into<String>,
        graph_revision: Option<&str>,
        input_digest: impl Into<String>,
        transcript_digest: impl Into<String>,
        native: ReplayFaultResult,
        node: Option<ReplayFaultResult>,
        pending: Vec<(&str, &str)>,
    ) -> Self {
        let mut pending = pending
            .into_iter()
            .map(|(backend, reason)| PendingFaultBackend::new(backend, reason))
            .collect::<Vec<_>>();
        if node.is_none() && !pending.iter().any(|item| item.backend == "node") {
            pending.insert(0, PendingFaultBackend::new("node", "not-supplied"));
        }
        Self {
            workload_id: workload_id.into(),
            graph_revision: graph_revision.map(str::to_owned),
            input_digest: input_digest.into(),
            transcript_digest: transcript_digest.into(),
            status: if node.is_some() {
                "failure-equivalent".to_owned()
            } else {
                "native-fault-measured".to_owned()
            },
            native,
            node,
            pending,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingFaultBackend {
    pub backend: String,
    pub reason: String,
}

impl PendingFaultBackend {
    pub fn new(backend: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            backend: backend.into(),
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayFaultReport {
    pub schema: String,
    pub catalog_digest: String,
    pub workloads: Vec<ReplayFaultWorkloadObservation>,
    pub status: String,
    pub report_digest: String,
}

pub fn build_replay_fault_report(
    catalog: &ReplayFaultCatalog,
    workloads: Vec<ReplayFaultWorkloadObservation>,
) -> Result<ReplayFaultReport, ReplayFaultCatalogError> {
    validate_catalog(catalog)?;
    let mut report = ReplayFaultReport {
        schema: REPLAY_FAULT_REPORT_SCHEMA.to_owned(),
        catalog_digest: catalog_digest(catalog)?,
        workloads,
        status: "measured".to_owned(),
        report_digest: String::new(),
    };
    validate_report_content(catalog, &report)?;
    report.report_digest = report_digest(&report)?;
    validate_replay_fault_report(catalog, &report)?;
    Ok(report)
}

pub fn validate_replay_fault_report(
    catalog: &ReplayFaultCatalog,
    report: &ReplayFaultReport,
) -> Result<(), ReplayFaultCatalogError> {
    validate_report_content(catalog, report)?;
    if report.catalog_digest != catalog_digest(catalog)? {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-catalog-digest-mismatch",
        ));
    }
    if report.report_digest != report_digest(report)? {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_replay_fault_catalog(
    catalog: &ReplayFaultCatalog,
) -> Result<String, ReplayFaultCatalogError> {
    validate_catalog(catalog)?;
    Ok(format!("{}\n", canonicalize(&catalog_json(catalog)?)))
}

pub fn parse_replay_fault_catalog(
    source: &str,
) -> Result<ReplayFaultCatalog, ReplayFaultCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ReplayFaultCatalogError::new("replay-fault-catalog-json-invalid"))?;
    let entries = exact_object(&value, &["schema", "workloads"])?;
    let workloads = match entries.get("workloads") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_workload)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-catalog-workloads-invalid",
            ));
        }
    };
    let catalog = ReplayFaultCatalog {
        schema: required_string(&entries, "schema")?.to_owned(),
        workloads,
    };
    validate_catalog(&catalog)?;
    if serialize_replay_fault_catalog(&catalog)?.as_str() != source {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-catalog-non-canonical-source",
        ));
    }
    Ok(catalog)
}

pub fn serialize_replay_fault_report(
    report: &ReplayFaultReport,
) -> Result<String, ReplayFaultCatalogError> {
    if report.schema != REPLAY_FAULT_REPORT_SCHEMA
        || report.status != "measured"
        || report.report_digest != report_digest(report)?
    {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-authority-invalid",
        ));
    }
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

pub fn parse_replay_fault_report(
    source: &str,
) -> Result<ReplayFaultReport, ReplayFaultCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ReplayFaultCatalogError::new("replay-fault-report-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "catalog_digest",
            "report_digest",
            "schema",
            "status",
            "workloads",
        ],
    )?;
    let workloads = match entries.get("workloads") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_observation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-workloads-invalid",
            ));
        }
    };
    let report = ReplayFaultReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        workloads,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    if report.schema != REPLAY_FAULT_REPORT_SCHEMA || report.status != "measured" {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-authority-invalid",
        ));
    }
    if report.report_digest != report_digest(&report)? {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-digest-mismatch",
        ));
    }
    if serialize_replay_fault_report(&report)?.as_str() != source {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-non-canonical-source",
        ));
    }
    Ok(report)
}

fn validate_catalog(catalog: &ReplayFaultCatalog) -> Result<(), ReplayFaultCatalogError> {
    if catalog.schema != REPLAY_FAULT_CATALOG_SCHEMA {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-catalog-schema-mismatch",
        ));
    }
    if catalog.workloads.len() < 3 {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-catalog-too-few-workloads",
        ));
    }
    let mut ids = BTreeSet::new();
    for workload in &catalog.workloads {
        if !valid_workload_id(&workload.workload_id)
            || !ids.insert(workload.workload_id.clone())
            || workload.code.is_empty()
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-catalog-workload-invalid",
            ));
        }
        if !(workload.source.starts_with("re 0.1 ") || workload.source.starts_with("re 1.0 "))
            || workload.source.contains('\0')
            || !is_digest(&workload.input_digest)
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-catalog-authority-invalid",
            ));
        }
        let transcript = parse_native_replay_transcript(&workload.transcript)
            .map_err(|_| ReplayFaultCatalogError::new("replay-fault-catalog-transcript-invalid"))?;
        if serialize_native_replay_transcript(&transcript)
            .map_err(|_| ReplayFaultCatalogError::new("replay-fault-catalog-transcript-invalid"))?
            != workload.transcript
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-catalog-transcript-non-canonical",
            ));
        }
        if let Some(node) = &workload.node_fault {
            validate_fault_result(node, "node")?;
        }
    }
    Ok(())
}

fn validate_report_content(
    catalog: &ReplayFaultCatalog,
    report: &ReplayFaultReport,
) -> Result<(), ReplayFaultCatalogError> {
    if report.schema != REPLAY_FAULT_REPORT_SCHEMA || report.status != "measured" {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-schema-mismatch",
        ));
    }
    if report.workloads.len() != catalog.workloads.len() {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-report-workload-count-mismatch",
        ));
    }
    for (catalog_workload, observation) in catalog.workloads.iter().zip(&report.workloads) {
        if observation.workload_id != catalog_workload.workload_id
            || observation.input_digest != catalog_workload.input_digest
            || !is_digest(&observation.transcript_digest)
            || observation
                .graph_revision
                .as_ref()
                .is_some_and(|value| !is_digest(value))
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-authority-mismatch",
            ));
        }
        validate_fault_result(&observation.native, "native")?;
        if observation.native.graph_revision != observation.graph_revision
            || observation.native.input_digest != observation.input_digest
            || observation.native.transcript_digest != observation.transcript_digest
            || observation.native.kind != catalog_workload.expected_kind
            || observation.native.code != catalog_workload.code
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-native-mismatch",
            ));
        }
        match (&catalog_workload.node_fault, &observation.node) {
            (Some(expected), Some(actual)) => {
                validate_fault_result(actual, "node")?;
                if actual != expected
                    || actual.kind != observation.native.kind
                    || actual.code != observation.native.code
                    || actual.graph_revision != observation.graph_revision
                    || actual.input_digest != observation.input_digest
                    || actual.transcript_digest != observation.transcript_digest
                {
                    return Err(ReplayFaultCatalogError::new(
                        "replay-fault-report-node-mismatch",
                    ));
                }
            }
            (None, None) => {}
            (Some(_), None) => {
                return Err(ReplayFaultCatalogError::new(
                    "replay-fault-report-node-missing",
                ));
            }
            (None, Some(_)) => {
                return Err(ReplayFaultCatalogError::new(
                    "replay-fault-report-node-unexpected",
                ));
            }
        }
        let expected_status = if catalog_workload.node_fault.is_some() {
            "failure-equivalent"
        } else {
            "native-fault-measured"
        };
        if observation.status != expected_status {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-status-mismatch",
            ));
        }
        let expected_pending = if catalog_workload.node_fault.is_some() {
            vec!["go", "jvm"]
        } else {
            vec!["node", "go", "jvm"]
        };
        if observation
            .pending
            .iter()
            .map(|item| item.backend.as_str())
            .collect::<Vec<_>>()
            != expected_pending
            || observation
                .pending
                .iter()
                .any(|item| item.reason.is_empty())
        {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-pending-partition-invalid",
            ));
        }
    }
    Ok(())
}

fn validate_fault_result(
    result: &ReplayFaultResult,
    expected_backend: &str,
) -> Result<(), ReplayFaultCatalogError> {
    if result.schema != REPLAY_FAULT_RESULT_SCHEMA
        || result.backend != expected_backend
        || result.code.is_empty()
        || !is_digest(&result.input_digest)
        || !is_digest(&result.transcript_digest)
        || !is_digest(&result.toolchain_digest)
        || result
            .graph_revision
            .as_ref()
            .is_some_and(|value| !is_digest(value))
        || result.receipt_digest.is_some()
        || result.status != "measured"
        || result.semantic_digest != fault_semantic_digest(result.kind, &result.code)
        || result.result_digest != fault_result_digest(result)
    {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-result-authority-invalid",
        ));
    }
    Ok(())
}

fn parse_workload(value: &JsonValue) -> Result<ReplayFaultWorkload, ReplayFaultCatalogError> {
    let entries = exact_object(
        value,
        &[
            "code",
            "expected_kind",
            "input_digest",
            "node_fault",
            "source",
            "transcript",
            "workload_id",
        ],
    )?;
    let node_fault = match entries.get("node_fault") {
        Some(JsonValue::Null) => None,
        Some(value) => Some(parse_fault_result(value, "node")?),
        None => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-catalog-required-field-missing",
            ));
        }
    };
    Ok(ReplayFaultWorkload::new(
        required_string(&entries, "workload_id")?,
        required_string(&entries, "source")?,
        required_string(&entries, "input_digest")?,
        required_string(&entries, "transcript")?,
        ReplayFaultKind::parse(required_string(&entries, "expected_kind")?)?,
        required_string(&entries, "code")?,
        node_fault,
    ))
}

fn parse_observation(
    value: &JsonValue,
) -> Result<ReplayFaultWorkloadObservation, ReplayFaultCatalogError> {
    let entries = exact_object(
        value,
        &[
            "graph_revision",
            "input_digest",
            "native",
            "node",
            "pending",
            "status",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    let graph_revision = match entries.get("graph_revision") {
        Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-authority-mismatch",
            ));
        }
    };
    let native = parse_fault_result(
        entries
            .get("native")
            .ok_or_else(|| ReplayFaultCatalogError::new("replay-fault-report-native-mismatch"))?,
        "native",
    )?;
    let node = match entries.get("node") {
        Some(JsonValue::Null) => None,
        Some(value) => Some(parse_fault_result(value, "node")?),
        None => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-required-field-missing",
            ));
        }
    };
    let pending = match entries.get("pending") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_pending)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-report-pending-invalid",
            ));
        }
    };
    Ok(ReplayFaultWorkloadObservation {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        graph_revision,
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        native,
        node,
        pending,
        status: required_string(&entries, "status")?.to_owned(),
    })
}

fn parse_fault_result(
    value: &JsonValue,
    expected_backend: &str,
) -> Result<ReplayFaultResult, ReplayFaultCatalogError> {
    let entries = exact_object(
        value,
        &[
            "backend",
            "code",
            "graph_revision",
            "input_digest",
            "kind",
            "result_digest",
            "schema",
            "semantic_digest",
            "status",
            "toolchain_digest",
            "transcript_digest",
        ],
    )?;
    let graph_revision = match entries.get("graph_revision") {
        Some(JsonValue::Null) => None,
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-result-authority-invalid",
            ));
        }
    };
    let result = ReplayFaultResult {
        schema: required_string(&entries, "schema")?.to_owned(),
        backend: required_string(&entries, "backend")?.to_owned(),
        kind: ReplayFaultKind::parse(required_string(&entries, "kind")?)?,
        code: required_string(&entries, "code")?.to_owned(),
        graph_revision,
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        toolchain_digest: required_string(&entries, "toolchain_digest")?.to_owned(),
        receipt_digest: None,
        semantic_digest: required_string(&entries, "semantic_digest")?.to_owned(),
        result_digest: required_string(&entries, "result_digest")?.to_owned(),
        status: required_string(&entries, "status")?.to_owned(),
    };
    validate_fault_result(&result, expected_backend)?;
    Ok(result)
}

fn parse_pending(value: &JsonValue) -> Result<PendingFaultBackend, ReplayFaultCatalogError> {
    let entries = exact_object(value, &["backend", "reason"])?;
    Ok(PendingFaultBackend::new(
        required_string(&entries, "backend")?,
        required_string(&entries, "reason")?,
    ))
}

fn catalog_digest(catalog: &ReplayFaultCatalog) -> Result<String, ReplayFaultCatalogError> {
    Ok(digest_json(&catalog_json(catalog)?))
}

fn report_digest(report: &ReplayFaultReport) -> Result<String, ReplayFaultCatalogError> {
    Ok(digest_json(&report_json(report, false)?))
}

fn fault_semantic_digest(kind: ReplayFaultKind, code: &str) -> String {
    digest_json(&object(vec![
        ("code", JsonValue::String(code.to_owned())),
        ("kind", JsonValue::String(kind.as_str().to_owned())),
    ]))
}

fn fault_result_digest(result: &ReplayFaultResult) -> String {
    digest_json(&fault_result_json(result, false))
}

fn catalog_json(catalog: &ReplayFaultCatalog) -> Result<JsonValue, ReplayFaultCatalogError> {
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

fn workload_json(workload: &ReplayFaultWorkload) -> Result<JsonValue, ReplayFaultCatalogError> {
    Ok(object(vec![
        ("code", JsonValue::String(workload.code.clone())),
        (
            "expected_kind",
            JsonValue::String(workload.expected_kind.as_str().to_owned()),
        ),
        (
            "input_digest",
            JsonValue::String(workload.input_digest.clone()),
        ),
        (
            "node_fault",
            workload
                .node_fault
                .as_ref()
                .map(|value| fault_result_json(value, true))
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
    report: &ReplayFaultReport,
    include_digest: bool,
) -> Result<JsonValue, ReplayFaultCatalogError> {
    let mut fields = vec![
        (
            "catalog_digest",
            JsonValue::String(report.catalog_digest.clone()),
        ),
        (
            "report_digest",
            if include_digest {
                JsonValue::String(report.report_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        ("schema", JsonValue::String(report.schema.clone())),
        ("status", JsonValue::String(report.status.clone())),
        (
            "workloads",
            JsonValue::Array(
                report
                    .workloads
                    .iter()
                    .map(observation_json)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "report_digest");
    }
    Ok(object(fields))
}

fn observation_json(
    observation: &ReplayFaultWorkloadObservation,
) -> Result<JsonValue, ReplayFaultCatalogError> {
    Ok(object(vec![
        (
            "graph_revision",
            observation
                .graph_revision
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "input_digest",
            JsonValue::String(observation.input_digest.clone()),
        ),
        ("native", fault_result_json(&observation.native, true)),
        (
            "node",
            observation
                .node
                .as_ref()
                .map(|value| fault_result_json(value, true))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "pending",
            JsonValue::Array(
                observation
                    .pending
                    .iter()
                    .map(|item| {
                        object(vec![
                            ("backend", JsonValue::String(item.backend.clone())),
                            ("reason", JsonValue::String(item.reason.clone())),
                        ])
                    })
                    .collect(),
            ),
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

fn fault_result_json(result: &ReplayFaultResult, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        ("backend", JsonValue::String(result.backend.clone())),
        ("code", JsonValue::String(result.code.clone())),
        (
            "graph_revision",
            result
                .graph_revision
                .as_ref()
                .map(|value| JsonValue::String(value.clone()))
                .unwrap_or(JsonValue::Null),
        ),
        (
            "input_digest",
            JsonValue::String(result.input_digest.clone()),
        ),
        ("kind", JsonValue::String(result.kind.as_str().to_owned())),
        (
            "result_digest",
            if include_digest {
                JsonValue::String(result.result_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        (
            "schema",
            JsonValue::String(REPLAY_FAULT_RESULT_SCHEMA.to_owned()),
        ),
        (
            "semantic_digest",
            JsonValue::String(result.semantic_digest.clone()),
        ),
        ("status", JsonValue::String(result.status.clone())),
        (
            "toolchain_digest",
            JsonValue::String(result.toolchain_digest.clone()),
        ),
        (
            "transcript_digest",
            JsonValue::String(result.transcript_digest.clone()),
        ),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "result_digest");
    }
    object(fields)
}

fn digest_json(value: &JsonValue) -> String {
    format!("sha256:{}", sha256_hex(canonicalize(value).as_bytes()))
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

fn valid_workload_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
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
) -> Result<BTreeMap<String, &'a JsonValue>, ReplayFaultCatalogError> {
    let JsonValue::Object(entries) = value else {
        return Err(ReplayFaultCatalogError::new("replay-fault-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(ReplayFaultCatalogError::new(
                "replay-fault-unexpected-field",
            ));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(ReplayFaultCatalogError::new("replay-fault-duplicate-field"));
        }
    }
    if result.len() != expected.len() {
        return Err(ReplayFaultCatalogError::new(
            "replay-fault-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, ReplayFaultCatalogError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ReplayFaultCatalogError::new("replay-fault-field-invalid")),
    }
}
