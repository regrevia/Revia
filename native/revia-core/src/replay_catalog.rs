use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    cross_language::{
        CrossLanguageBackendResult, CrossLanguageReplayMatrix, PendingBackend,
        parse_backend_result, parse_cross_language_matrix, serialize_backend_result,
        serialize_cross_language_matrix,
    },
    digest::sha256_hex,
    graph::{load_canonical_graph, serialize_canonical_graph},
    project::parse_json,
    replay::{parse_native_replay_transcript, serialize_native_replay_transcript},
};

pub const REPLAY_WORKLOAD_CATALOG_SCHEMA: &str = "re.native-replay-workload-catalog@0.1.0";
pub const REPLAY_WORKLOAD_REPORT_SCHEMA: &str = "re.native-replay-workload-report@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayCatalogError {
    pub code: String,
}

impl ReplayCatalogError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

impl From<crate::cross_language::CrossLanguageError> for ReplayCatalogError {
    fn from(error: crate::cross_language::CrossLanguageError) -> Self {
        Self { code: error.code }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayWorkload {
    pub workload_id: String,
    pub source: String,
    pub input_digest: String,
    pub transcript: String,
    pub node_result: Option<CrossLanguageBackendResult>,
}

impl ReplayWorkload {
    pub fn new(
        workload_id: impl Into<String>,
        source: impl Into<String>,
        input_digest: impl Into<String>,
        transcript: impl Into<String>,
        node_result: Option<CrossLanguageBackendResult>,
    ) -> Self {
        Self {
            workload_id: workload_id.into(),
            source: source.into(),
            input_digest: input_digest.into(),
            transcript: transcript.into(),
            node_result,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayWorkloadCatalog {
    pub schema: String,
    pub workloads: Vec<ReplayWorkload>,
}

impl ReplayWorkloadCatalog {
    pub fn new(workloads: Vec<ReplayWorkload>) -> Self {
        Self {
            schema: REPLAY_WORKLOAD_CATALOG_SCHEMA.to_owned(),
            workloads,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayWorkloadObservation {
    pub workload_id: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub native_result: CrossLanguageBackendResult,
    pub matrix: Option<CrossLanguageReplayMatrix>,
    pub pending: Vec<PendingBackend>,
    pub status: String,
}

impl ReplayWorkloadObservation {
    pub fn new(
        workload_id: impl Into<String>,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
        transcript_digest: impl Into<String>,
        native_result: CrossLanguageBackendResult,
        matrix: Option<CrossLanguageReplayMatrix>,
        pending: Vec<PendingBackend>,
    ) -> Self {
        let mut pending = pending;
        if matrix.is_none() && !pending.iter().any(|item| item.backend == "node") {
            pending.insert(0, PendingBackend::new("node", "not-supplied"));
        }
        Self {
            workload_id: workload_id.into(),
            graph_revision: graph_revision.into(),
            input_digest: input_digest.into(),
            transcript_digest: transcript_digest.into(),
            native_result,
            status: if matrix.is_some() {
                "semantic-equivalent".to_owned()
            } else {
                "native-measured".to_owned()
            },
            matrix,
            pending,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayWorkloadReport {
    pub schema: String,
    pub catalog_digest: String,
    pub workloads: Vec<ReplayWorkloadObservation>,
    pub status: String,
    pub report_digest: String,
}

pub fn build_replay_workload_report(
    catalog: &ReplayWorkloadCatalog,
    workloads: Vec<ReplayWorkloadObservation>,
) -> Result<ReplayWorkloadReport, ReplayCatalogError> {
    validate_catalog(catalog)?;
    let report = ReplayWorkloadReport {
        schema: REPLAY_WORKLOAD_REPORT_SCHEMA.to_owned(),
        catalog_digest: catalog_digest(catalog)?,
        workloads,
        status: "measured".to_owned(),
        report_digest: String::new(),
    };
    validate_report_content(catalog, &report)?;
    let mut report = report;
    report.report_digest = report_digest(&report)?;
    validate_replay_workload_report(catalog, &report)?;
    Ok(report)
}

pub fn validate_replay_workload_catalog(
    catalog: &ReplayWorkloadCatalog,
) -> Result<(), ReplayCatalogError> {
    validate_catalog(catalog)
}

pub fn validate_replay_workload_report(
    catalog: &ReplayWorkloadCatalog,
    report: &ReplayWorkloadReport,
) -> Result<(), ReplayCatalogError> {
    validate_report_content(catalog, report)?;
    if report.catalog_digest != catalog_digest(catalog)? {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-catalog-digest-mismatch",
        ));
    }
    if report.report_digest != report_digest(report)? {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_replay_workload_catalog(
    catalog: &ReplayWorkloadCatalog,
) -> Result<String, ReplayCatalogError> {
    validate_catalog(catalog)?;
    Ok(format!("{}\n", canonicalize(&catalog_json(catalog)?)))
}

pub fn parse_replay_workload_catalog(
    source: &str,
) -> Result<ReplayWorkloadCatalog, ReplayCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ReplayCatalogError::new("replay-workload-catalog-json-invalid"))?;
    let entries = exact_object(&value, &["schema", "workloads"])?;
    let workloads = match entries.get("workloads") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_workload)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-workloads-invalid",
            ));
        }
    };
    let catalog = ReplayWorkloadCatalog {
        schema: required_string(&entries, "schema")?.to_owned(),
        workloads,
    };
    validate_catalog(&catalog)?;
    if serialize_replay_workload_catalog(&catalog)?.as_str() != source {
        return Err(ReplayCatalogError::new(
            "replay-workload-catalog-non-canonical-source",
        ));
    }
    Ok(catalog)
}

pub fn serialize_replay_workload_report(
    report: &ReplayWorkloadReport,
) -> Result<String, ReplayCatalogError> {
    // Report validation is performed by the caller with its catalog because the report
    // deliberately carries only the catalog digest, not a second copy of source authority.
    if report.schema != REPLAY_WORKLOAD_REPORT_SCHEMA
        || report.status != "measured"
        || report.report_digest != report_digest(report)?
    {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-authority-invalid",
        ));
    }
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

pub fn parse_replay_workload_report(
    source: &str,
) -> Result<ReplayWorkloadReport, ReplayCatalogError> {
    let value = parse_json(source)
        .map_err(|_| ReplayCatalogError::new("replay-workload-report-json-invalid"))?;
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
            return Err(ReplayCatalogError::new(
                "replay-workload-report-workloads-invalid",
            ));
        }
    };
    let report = ReplayWorkloadReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        workloads,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    if report.schema != REPLAY_WORKLOAD_REPORT_SCHEMA
        || report.status != "measured"
        || !is_digest(&report.catalog_digest)
    {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-authority-invalid",
        ));
    }
    if report.report_digest != report_digest(&report)? {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-digest-mismatch",
        ));
    }
    if serialize_replay_workload_report(&report)?.as_str() != source {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-non-canonical-source",
        ));
    }
    Ok(report)
}

pub fn catalog_digest(catalog: &ReplayWorkloadCatalog) -> Result<String, ReplayCatalogError> {
    validate_catalog(catalog)?;
    Ok(digest_json(&catalog_json(catalog)?))
}

fn validate_catalog(catalog: &ReplayWorkloadCatalog) -> Result<(), ReplayCatalogError> {
    if catalog.schema != REPLAY_WORKLOAD_CATALOG_SCHEMA {
        return Err(ReplayCatalogError::new(
            "replay-workload-catalog-schema-mismatch",
        ));
    }
    if catalog.workloads.len() < 3 {
        return Err(ReplayCatalogError::new(
            "replay-workload-catalog-too-few-workloads",
        ));
    }
    let mut ids = BTreeSet::new();
    for workload in &catalog.workloads {
        if !valid_workload_id(&workload.workload_id) || !ids.insert(workload.workload_id.clone()) {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-workload-id-invalid",
            ));
        }
        if !workload.source.starts_with("re 0.1 canonical\n")
            || workload.source.contains('\0')
            || !is_digest(&workload.input_digest)
        {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-authority-invalid",
            ));
        }
        let graph = load_canonical_graph(&workload.source)
            .map_err(|_| ReplayCatalogError::new("replay-workload-catalog-source-invalid"))?;
        let canonical_source = serialize_canonical_graph(&graph)
            .map_err(|_| ReplayCatalogError::new("replay-workload-catalog-source-invalid"))?;
        if canonical_source != workload.source {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-source-non-canonical",
            ));
        }
        let transcript = parse_native_replay_transcript(&workload.transcript)
            .map_err(|_| ReplayCatalogError::new("replay-workload-catalog-transcript-invalid"))?;
        if serialize_native_replay_transcript(&transcript)
            .map_err(|_| ReplayCatalogError::new("replay-workload-catalog-transcript-invalid"))?
            != workload.transcript
        {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-transcript-non-canonical",
            ));
        }
        if let Some(node) = &workload.node_result {
            if node.backend != "node" {
                return Err(ReplayCatalogError::new(
                    "replay-workload-catalog-node-result-invalid",
                ));
            }
            serialize_backend_result(node).map_err(|_| {
                ReplayCatalogError::new("replay-workload-catalog-node-result-invalid")
            })?;
        }
    }
    Ok(())
}

fn validate_report_content(
    catalog: &ReplayWorkloadCatalog,
    report: &ReplayWorkloadReport,
) -> Result<(), ReplayCatalogError> {
    if report.schema != REPLAY_WORKLOAD_REPORT_SCHEMA || report.status != "measured" {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-schema-mismatch",
        ));
    }
    if report.workloads.len() != catalog.workloads.len() {
        return Err(ReplayCatalogError::new(
            "replay-workload-report-workload-count-mismatch",
        ));
    }
    for (catalog_workload, observation) in catalog.workloads.iter().zip(&report.workloads) {
        if observation.workload_id != catalog_workload.workload_id
            || !is_digest(&observation.graph_revision)
            || observation.input_digest != catalog_workload.input_digest
            || !is_digest(&observation.transcript_digest)
        {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-authority-mismatch",
            ));
        }
        if observation.native_result.backend != "native"
            || observation.native_result.graph_revision != observation.graph_revision
            || observation.native_result.input_digest != observation.input_digest
            || observation.native_result.transcript_digest != observation.transcript_digest
        {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-native-result-mismatch",
            ));
        }
        serialize_backend_result(&observation.native_result)
            .map_err(|_| ReplayCatalogError::new("replay-workload-report-native-result-invalid"))?;
        let expected_status = if catalog_workload.node_result.is_some() {
            "semantic-equivalent"
        } else {
            "native-measured"
        };
        if observation.status != expected_status {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-status-mismatch",
            ));
        }
        if let Some(matrix) = &observation.matrix {
            if catalog_workload.node_result.is_none()
                || matrix.workload_id != observation.workload_id
                || matrix.graph_revision != observation.graph_revision
                || matrix.input_digest != observation.input_digest
                || matrix.transcript_digest != observation.transcript_digest
                || matrix.measured.first() != Some(&observation.native_result)
            {
                return Err(ReplayCatalogError::new(
                    "replay-workload-report-matrix-mismatch",
                ));
            }
            serialize_cross_language_matrix(matrix)
                .map_err(|_| ReplayCatalogError::new("replay-workload-report-matrix-invalid"))?;
        } else if catalog_workload.node_result.is_some() {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-matrix-missing",
            ));
        }
        let expected_pending = if catalog_workload.node_result.is_some() {
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
        {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-pending-partition-invalid",
            ));
        }
        for pending in &observation.pending {
            if pending.reason.is_empty()
                || !["node", "go", "jvm"].contains(&pending.backend.as_str())
            {
                return Err(ReplayCatalogError::new(
                    "replay-workload-report-pending-invalid",
                ));
            }
        }
    }
    Ok(())
}

fn parse_workload(value: &JsonValue) -> Result<ReplayWorkload, ReplayCatalogError> {
    let entries = exact_object(
        value,
        &[
            "input_digest",
            "node_result",
            "source",
            "transcript",
            "workload_id",
        ],
    )?;
    let node_result = match entries.get("node_result") {
        Some(JsonValue::Null) => None,
        Some(value) => {
            let source = format!("{}\n", canonicalize(value));
            Some(parse_backend_result(&source).map_err(|_| {
                ReplayCatalogError::new("replay-workload-catalog-node-result-invalid")
            })?)
        }
        None => {
            return Err(ReplayCatalogError::new(
                "replay-workload-catalog-required-field-missing",
            ));
        }
    };
    Ok(ReplayWorkload::new(
        required_string(&entries, "workload_id")?,
        required_string(&entries, "source")?,
        required_string(&entries, "input_digest")?,
        required_string(&entries, "transcript")?,
        node_result,
    ))
}

fn parse_observation(value: &JsonValue) -> Result<ReplayWorkloadObservation, ReplayCatalogError> {
    let entries = exact_object(
        value,
        &[
            "graph_revision",
            "input_digest",
            "matrix",
            "native_result",
            "pending",
            "status",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    let native_value = entries
        .get("native_result")
        .ok_or_else(|| ReplayCatalogError::new("replay-workload-report-native-result-invalid"))?;
    let native_result = parse_backend_result(&format!("{}\n", canonicalize(native_value)))
        .map_err(|_| ReplayCatalogError::new("replay-workload-report-native-result-invalid"))?;
    let matrix = match entries.get("matrix") {
        Some(JsonValue::Null) => None,
        Some(value) => Some(
            parse_cross_language_matrix(&format!("{}\n", canonicalize(value)))
                .map_err(|_| ReplayCatalogError::new("replay-workload-report-matrix-invalid"))?,
        ),
        None => {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-required-field-missing",
            ));
        }
    };
    let pending = match entries.get("pending") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_pending)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayCatalogError::new(
                "replay-workload-report-pending-invalid",
            ));
        }
    };
    Ok(ReplayWorkloadObservation {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        native_result,
        matrix,
        pending,
        status: required_string(&entries, "status")?.to_owned(),
    })
}

fn parse_pending(value: &JsonValue) -> Result<PendingBackend, ReplayCatalogError> {
    let entries = exact_object(value, &["backend", "reason"])?;
    Ok(PendingBackend::new(
        required_string(&entries, "backend")?,
        required_string(&entries, "reason")?,
    ))
}

fn catalog_json(catalog: &ReplayWorkloadCatalog) -> Result<JsonValue, ReplayCatalogError> {
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

fn workload_json(workload: &ReplayWorkload) -> Result<JsonValue, ReplayCatalogError> {
    Ok(object(vec![
        (
            "input_digest",
            JsonValue::String(workload.input_digest.clone()),
        ),
        (
            "node_result",
            workload
                .node_result
                .as_ref()
                .map(backend_json)
                .transpose()?
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
    report: &ReplayWorkloadReport,
    include_digest: bool,
) -> Result<JsonValue, ReplayCatalogError> {
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
    observation: &ReplayWorkloadObservation,
) -> Result<JsonValue, ReplayCatalogError> {
    Ok(object(vec![
        (
            "graph_revision",
            JsonValue::String(observation.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(observation.input_digest.clone()),
        ),
        (
            "matrix",
            observation
                .matrix
                .as_ref()
                .map(matrix_json)
                .transpose()?
                .unwrap_or(JsonValue::Null),
        ),
        ("native_result", backend_json(&observation.native_result)?),
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

fn backend_json(result: &CrossLanguageBackendResult) -> Result<JsonValue, ReplayCatalogError> {
    parse_json(&serialize_backend_result(result)?)
        .map_err(|_| ReplayCatalogError::new("replay-workload-backend-json-invalid"))
}

fn matrix_json(matrix: &CrossLanguageReplayMatrix) -> Result<JsonValue, ReplayCatalogError> {
    parse_json(&serialize_cross_language_matrix(matrix)?)
        .map_err(|_| ReplayCatalogError::new("replay-workload-matrix-json-invalid"))
}

fn report_digest(report: &ReplayWorkloadReport) -> Result<String, ReplayCatalogError> {
    Ok(digest_json(&report_json(report, false)?))
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
) -> Result<BTreeMap<String, &'a JsonValue>, ReplayCatalogError> {
    let JsonValue::Object(entries) = value else {
        return Err(ReplayCatalogError::new("replay-workload-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(ReplayCatalogError::new("replay-workload-unexpected-field"));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(ReplayCatalogError::new("replay-workload-duplicate-field"));
        }
    }
    if result.len() != expected.len() {
        return Err(ReplayCatalogError::new(
            "replay-workload-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, ReplayCatalogError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ReplayCatalogError::new("replay-workload-field-invalid")),
    }
}
