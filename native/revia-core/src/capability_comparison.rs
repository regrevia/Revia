use std::collections::BTreeSet;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    graph::{Statement, Target, graph_revision, load_canonical_graph},
    project::parse_json,
};

pub const CAPABILITY_COMPARISON_CATALOG_SCHEMA: &str =
    "re.native-capability-comparison-catalog@0.1.0";
pub const CAPABILITY_COMPARISON_REPORT_SCHEMA: &str =
    "re.native-capability-comparison-report@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityComparisonError {
    pub code: String,
}

impl CapabilityComparisonError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilitySandboxFile {
    pub path: String,
    pub bytes_hex: String,
}

impl CapabilitySandboxFile {
    pub fn new(path: impl Into<String>, bytes: &[u8]) -> Self {
        Self {
            path: path.into(),
            bytes_hex: format!(
                "hex:{}",
                bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityComparisonWorkload {
    pub workload_id: String,
    pub operation: String,
    pub source: String,
    pub input_digest: String,
    pub sandbox_before: Vec<CapabilitySandboxFile>,
    pub sandbox_after: Vec<CapabilitySandboxFile>,
    pub expected_outcome_code: u8,
}

impl CapabilityComparisonWorkload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workload_id: impl Into<String>,
        operation: impl Into<String>,
        source: impl Into<String>,
        input_digest: impl Into<String>,
        sandbox_before: Vec<CapabilitySandboxFile>,
        sandbox_after: Vec<CapabilitySandboxFile>,
        expected_outcome_code: u8,
    ) -> Self {
        Self {
            workload_id: workload_id.into(),
            operation: operation.into(),
            source: source.into(),
            input_digest: input_digest.into(),
            sandbox_before: sorted_files(sandbox_before),
            sandbox_after: sorted_files(sandbox_after),
            expected_outcome_code,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityComparisonCatalog {
    pub schema: String,
    pub workloads: Vec<CapabilityComparisonWorkload>,
}

impl CapabilityComparisonCatalog {
    pub fn new(workloads: Vec<CapabilityComparisonWorkload>) -> Self {
        Self {
            schema: CAPABILITY_COMPARISON_CATALOG_SCHEMA.to_owned(),
            workloads,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityComparisonObservation {
    pub workload_id: String,
    pub operation: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub direct_stdout_digest: String,
    pub bundle_stdout_digest: String,
    pub direct_result_digest: String,
    pub bundle_result_digest: String,
    pub direct_receipt_digest: String,
    pub bundle_receipt_digest: String,
    pub before_sandbox_digest: String,
    pub direct_sandbox_digest: String,
    pub bundle_sandbox_digest: String,
    pub direct_outcome_code: u8,
    pub bundle_outcome_code: u8,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityComparisonReport {
    pub schema: String,
    pub catalog_digest: String,
    pub observations: Vec<CapabilityComparisonObservation>,
    pub status: String,
    pub report_digest: String,
}

impl CapabilityComparisonReport {
    pub fn new(
        catalog_digest: impl Into<String>,
        observations: Vec<CapabilityComparisonObservation>,
    ) -> Self {
        Self {
            schema: CAPABILITY_COMPARISON_REPORT_SCHEMA.to_owned(),
            catalog_digest: catalog_digest.into(),
            observations,
            status: "passed".to_owned(),
            report_digest: String::new(),
        }
    }
}

pub fn build_capability_comparison_report(
    catalog: &CapabilityComparisonCatalog,
    observations: Vec<CapabilityComparisonObservation>,
) -> Result<CapabilityComparisonReport, CapabilityComparisonError> {
    let mut report = CapabilityComparisonReport::new(catalog_digest(catalog)?, observations);
    report.report_digest = report_digest(&report)?;
    validate_capability_comparison_report(catalog, &report)?;
    Ok(report)
}

pub fn validate_capability_comparison_catalog(
    catalog: &CapabilityComparisonCatalog,
) -> Result<(), CapabilityComparisonError> {
    if catalog.schema != CAPABILITY_COMPARISON_CATALOG_SCHEMA || catalog.workloads.is_empty() {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-catalog-invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    for workload in &catalog.workloads {
        if workload.workload_id.is_empty() || !ids.insert(workload.workload_id.clone()) {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-workload-id-invalid",
            ));
        }
        if !valid_digest(&workload.input_digest)
            || !matches!(
                workload.operation.as_str(),
                "process.args@0.1.0.read" | "fs.read@0.1.0.read_file" | "fs.write@0.1.0.write_file"
            )
        {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-authority-invalid",
            ));
        }
        let graph = load_canonical_graph(&workload.source).map_err(|_| {
            CapabilityComparisonError::new("native-capability-comparison-source-invalid")
        })?;
        let canonical = crate::graph::serialize_canonical_graph(&graph).map_err(|_| {
            CapabilityComparisonError::new("native-capability-comparison-source-invalid")
        })?;
        if canonical != workload.source {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-source-noncanonical",
            ));
        }
        graph_revision(&graph).map_err(|_| {
            CapabilityComparisonError::new("native-capability-comparison-source-invalid")
        })?;
        if capability_operation(&graph).as_deref() != Some(workload.operation.as_str()) {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-operation-authority-mismatch",
            ));
        }
        validate_files(&workload.sandbox_before)?;
        validate_files(&workload.sandbox_after)?;
        if workload.operation != "fs.write@0.1.0.write_file"
            && workload.sandbox_before != workload.sandbox_after
        {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-sandbox-authority-mismatch",
            ));
        }
        if workload.operation == "process.args@0.1.0.read"
            && (!workload.sandbox_before.is_empty() || !workload.sandbox_after.is_empty())
        {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-sandbox-authority-mismatch",
            ));
        }
    }
    Ok(())
}

pub fn serialize_capability_comparison_catalog(
    catalog: &CapabilityComparisonCatalog,
) -> Result<String, CapabilityComparisonError> {
    validate_capability_comparison_catalog(catalog)?;
    Ok(format!("{}\n", canonicalize(&catalog_json(catalog))))
}

pub fn parse_capability_comparison_catalog(
    source: &str,
) -> Result<CapabilityComparisonCatalog, CapabilityComparisonError> {
    let value = parse_json(source).map_err(|_| {
        CapabilityComparisonError::new("native-capability-comparison-catalog-json-invalid")
    })?;
    let entries = exact_object(&value, &["schema", "workloads"])?;
    let workloads = match required_value(&entries, "workloads")? {
        JsonValue::Array(values) => values
            .iter()
            .map(parse_workload)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-workloads-invalid",
            ));
        }
    };
    let catalog = CapabilityComparisonCatalog {
        schema: required_string(&entries, "schema")?.to_owned(),
        workloads,
    };
    validate_capability_comparison_catalog(&catalog)?;
    if serialize_capability_comparison_catalog(&catalog)? != source {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-catalog-noncanonical",
        ));
    }
    Ok(catalog)
}

pub fn catalog_digest(
    catalog: &CapabilityComparisonCatalog,
) -> Result<String, CapabilityComparisonError> {
    validate_capability_comparison_catalog(catalog)?;
    Ok(digest_bytes(
        canonicalize(&catalog_json(catalog)).as_bytes(),
    ))
}

pub fn validate_capability_comparison_report(
    catalog: &CapabilityComparisonCatalog,
    report: &CapabilityComparisonReport,
) -> Result<(), CapabilityComparisonError> {
    validate_capability_comparison_catalog(catalog)?;
    if report.schema != CAPABILITY_COMPARISON_REPORT_SCHEMA
        || report.status != "passed"
        || report.observations.len() != catalog.workloads.len()
        || report.catalog_digest != catalog_digest(catalog)?
        || !valid_digest(&report.report_digest)
    {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-report-authority-invalid",
        ));
    }
    for (workload, observation) in catalog.workloads.iter().zip(&report.observations) {
        let graph = load_canonical_graph(&workload.source).map_err(|_| {
            CapabilityComparisonError::new("native-capability-comparison-source-invalid")
        })?;
        let revision = graph_revision(&graph).map_err(|_| {
            CapabilityComparisonError::new("native-capability-comparison-source-invalid")
        })?;
        if observation.workload_id != workload.workload_id
            || observation.operation != workload.operation
            || observation.graph_revision != revision
            || observation.input_digest != workload.input_digest
            || observation.status != "matched"
            || observation.direct_outcome_code != workload.expected_outcome_code
            || observation.bundle_outcome_code != workload.expected_outcome_code
            || !valid_digest(&observation.direct_stdout_digest)
            || !valid_digest(&observation.bundle_stdout_digest)
            || !valid_digest(&observation.direct_result_digest)
            || !valid_digest(&observation.bundle_result_digest)
            || !valid_digest(&observation.direct_receipt_digest)
            || !valid_digest(&observation.bundle_receipt_digest)
            || !valid_digest(&observation.before_sandbox_digest)
            || !valid_digest(&observation.direct_sandbox_digest)
            || !valid_digest(&observation.bundle_sandbox_digest)
            || observation.direct_stdout_digest != observation.bundle_stdout_digest
            || observation.direct_result_digest != observation.bundle_result_digest
            || observation.direct_receipt_digest != observation.bundle_receipt_digest
            || observation.direct_sandbox_digest != observation.bundle_sandbox_digest
        {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-observation-authority-invalid",
            ));
        }
    }
    if report.report_digest != report_digest(report)? {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_capability_comparison_report(
    catalog: &CapabilityComparisonCatalog,
    report: &CapabilityComparisonReport,
) -> Result<String, CapabilityComparisonError> {
    validate_capability_comparison_report(catalog, report)?;
    Ok(format!("{}\n", canonicalize(&report_json(report))))
}

pub fn parse_capability_comparison_report(
    catalog: &CapabilityComparisonCatalog,
    source: &str,
) -> Result<CapabilityComparisonReport, CapabilityComparisonError> {
    let value = parse_json(source).map_err(|_| {
        CapabilityComparisonError::new("native-capability-comparison-report-json-invalid")
    })?;
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
    let observations = match required_value(&entries, "observations")? {
        JsonValue::Array(values) => values
            .iter()
            .map(parse_observation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-observations-invalid",
            ));
        }
    };
    let report = CapabilityComparisonReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        observations,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    validate_capability_comparison_report(catalog, &report)?;
    if serialize_capability_comparison_report(catalog, &report)? != source {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-report-noncanonical",
        ));
    }
    Ok(report)
}

pub fn capability_operation(graph: &crate::graph::Graph) -> Option<String> {
    let Statement::Let { value, .. } = graph.functions.first()?.statements.first()? else {
        return None;
    };
    let Target::CapabilityMember {
        member,
        schema_reference,
        ..
    } = &value.target
    else {
        return None;
    };
    Some(format!("{schema_reference}.{member}"))
}

pub fn sandbox_digest(
    files: &[CapabilitySandboxFile],
) -> Result<String, CapabilityComparisonError> {
    validate_files(files)?;
    Ok(digest_bytes(canonicalize(&files_json(files)).as_bytes()))
}

fn catalog_json(catalog: &CapabilityComparisonCatalog) -> JsonValue {
    JsonValue::Object(vec![
        (
            "schema".to_owned(),
            JsonValue::String(catalog.schema.clone()),
        ),
        (
            "workloads".to_owned(),
            JsonValue::Array(catalog.workloads.iter().map(workload_json).collect()),
        ),
    ])
}

fn workload_json(workload: &CapabilityComparisonWorkload) -> JsonValue {
    JsonValue::Object(vec![
        (
            "expected_outcome_code".to_owned(),
            JsonValue::Number(workload.expected_outcome_code.to_string()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(workload.input_digest.clone()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(workload.operation.clone()),
        ),
        (
            "sandbox_after".to_owned(),
            JsonValue::Array(workload.sandbox_after.iter().map(file_json).collect()),
        ),
        (
            "sandbox_before".to_owned(),
            JsonValue::Array(workload.sandbox_before.iter().map(file_json).collect()),
        ),
        (
            "source".to_owned(),
            JsonValue::String(workload.source.clone()),
        ),
        (
            "workload_id".to_owned(),
            JsonValue::String(workload.workload_id.clone()),
        ),
    ])
}

fn file_json(file: &CapabilitySandboxFile) -> JsonValue {
    JsonValue::Object(vec![
        (
            "bytes_hex".to_owned(),
            JsonValue::String(file.bytes_hex.clone()),
        ),
        ("path".to_owned(), JsonValue::String(file.path.clone())),
    ])
}

fn files_json(files: &[CapabilitySandboxFile]) -> JsonValue {
    JsonValue::Array(files.iter().map(file_json).collect())
}

fn report_json(report: &CapabilityComparisonReport) -> JsonValue {
    JsonValue::Object(vec![
        (
            "catalog_digest".to_owned(),
            JsonValue::String(report.catalog_digest.clone()),
        ),
        (
            "observations".to_owned(),
            JsonValue::Array(report.observations.iter().map(observation_json).collect()),
        ),
        (
            "report_digest".to_owned(),
            JsonValue::String(report.report_digest.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(report.schema.clone()),
        ),
        (
            "status".to_owned(),
            JsonValue::String(report.status.clone()),
        ),
    ])
}

fn observation_json(observation: &CapabilityComparisonObservation) -> JsonValue {
    JsonValue::Object(vec![
        (
            "before_sandbox_digest".to_owned(),
            JsonValue::String(observation.before_sandbox_digest.clone()),
        ),
        (
            "bundle_receipt_digest".to_owned(),
            JsonValue::String(observation.bundle_receipt_digest.clone()),
        ),
        (
            "bundle_result_digest".to_owned(),
            JsonValue::String(observation.bundle_result_digest.clone()),
        ),
        (
            "bundle_sandbox_digest".to_owned(),
            JsonValue::String(observation.bundle_sandbox_digest.clone()),
        ),
        (
            "bundle_stdout_digest".to_owned(),
            JsonValue::String(observation.bundle_stdout_digest.clone()),
        ),
        (
            "bundle_outcome_code".to_owned(),
            JsonValue::Number(observation.bundle_outcome_code.to_string()),
        ),
        (
            "direct_receipt_digest".to_owned(),
            JsonValue::String(observation.direct_receipt_digest.clone()),
        ),
        (
            "direct_result_digest".to_owned(),
            JsonValue::String(observation.direct_result_digest.clone()),
        ),
        (
            "direct_sandbox_digest".to_owned(),
            JsonValue::String(observation.direct_sandbox_digest.clone()),
        ),
        (
            "direct_stdout_digest".to_owned(),
            JsonValue::String(observation.direct_stdout_digest.clone()),
        ),
        (
            "direct_outcome_code".to_owned(),
            JsonValue::Number(observation.direct_outcome_code.to_string()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(observation.graph_revision.clone()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(observation.input_digest.clone()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(observation.operation.clone()),
        ),
        (
            "status".to_owned(),
            JsonValue::String(observation.status.clone()),
        ),
        (
            "workload_id".to_owned(),
            JsonValue::String(observation.workload_id.clone()),
        ),
    ])
}

fn parse_workload(
    value: &JsonValue,
) -> Result<CapabilityComparisonWorkload, CapabilityComparisonError> {
    let entries = exact_object(
        value,
        &[
            "expected_outcome_code",
            "input_digest",
            "operation",
            "sandbox_after",
            "sandbox_before",
            "source",
            "workload_id",
        ],
    )?;
    Ok(CapabilityComparisonWorkload::new(
        required_string(&entries, "workload_id")?,
        required_string(&entries, "operation")?,
        required_string(&entries, "source")?,
        required_string(&entries, "input_digest")?,
        parse_files(&entries, "sandbox_before")?,
        parse_files(&entries, "sandbox_after")?,
        required_number(&entries, "expected_outcome_code")?
            .parse()
            .map_err(|_| {
                CapabilityComparisonError::new("native-capability-comparison-outcome-code-invalid")
            })?,
    ))
}

fn parse_files(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<Vec<CapabilitySandboxFile>, CapabilityComparisonError> {
    let JsonValue::Array(values) = required_value(entries, name)? else {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-sandbox-invalid",
        ));
    };
    values.iter().map(parse_file).collect()
}

fn parse_file(value: &JsonValue) -> Result<CapabilitySandboxFile, CapabilityComparisonError> {
    let entries = exact_object(value, &["bytes_hex", "path"])?;
    Ok(CapabilitySandboxFile {
        path: required_string(&entries, "path")?.to_owned(),
        bytes_hex: required_string(&entries, "bytes_hex")?.to_owned(),
    })
}

fn parse_observation(
    value: &JsonValue,
) -> Result<CapabilityComparisonObservation, CapabilityComparisonError> {
    let entries = exact_object(
        value,
        &[
            "before_sandbox_digest",
            "bundle_receipt_digest",
            "bundle_result_digest",
            "bundle_sandbox_digest",
            "bundle_stdout_digest",
            "bundle_outcome_code",
            "direct_receipt_digest",
            "direct_result_digest",
            "direct_sandbox_digest",
            "direct_stdout_digest",
            "direct_outcome_code",
            "graph_revision",
            "input_digest",
            "operation",
            "status",
            "workload_id",
        ],
    )?;
    Ok(CapabilityComparisonObservation {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        operation: required_string(&entries, "operation")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        direct_stdout_digest: required_string(&entries, "direct_stdout_digest")?.to_owned(),
        bundle_stdout_digest: required_string(&entries, "bundle_stdout_digest")?.to_owned(),
        direct_result_digest: required_string(&entries, "direct_result_digest")?.to_owned(),
        bundle_result_digest: required_string(&entries, "bundle_result_digest")?.to_owned(),
        direct_receipt_digest: required_string(&entries, "direct_receipt_digest")?.to_owned(),
        bundle_receipt_digest: required_string(&entries, "bundle_receipt_digest")?.to_owned(),
        before_sandbox_digest: required_string(&entries, "before_sandbox_digest")?.to_owned(),
        direct_sandbox_digest: required_string(&entries, "direct_sandbox_digest")?.to_owned(),
        bundle_sandbox_digest: required_string(&entries, "bundle_sandbox_digest")?.to_owned(),
        direct_outcome_code: required_number(&entries, "direct_outcome_code")?
            .parse()
            .map_err(|_| {
                CapabilityComparisonError::new("native-capability-comparison-outcome-code-invalid")
            })?,
        bundle_outcome_code: required_number(&entries, "bundle_outcome_code")?
            .parse()
            .map_err(|_| {
                CapabilityComparisonError::new("native-capability-comparison-outcome-code-invalid")
            })?,
        status: required_string(&entries, "status")?.to_owned(),
    })
}

fn report_digest(report: &CapabilityComparisonReport) -> Result<String, CapabilityComparisonError> {
    let mut without = report.clone();
    without.report_digest.clear();
    Ok(digest_bytes(
        canonicalize(&report_json(&without)).as_bytes(),
    ))
}

fn validate_files(files: &[CapabilitySandboxFile]) -> Result<(), CapabilityComparisonError> {
    let mut paths = BTreeSet::new();
    for file in files {
        if file.path.is_empty()
            || file.path.starts_with('/')
            || file.path.contains('\\')
            || file.path.contains('\0')
            || file
                .path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
            || !paths.insert(file.path.clone())
            || !is_canonical_hex(&file.bytes_hex)
        {
            return Err(CapabilityComparisonError::new(
                "native-capability-comparison-sandbox-invalid",
            ));
        }
    }
    let sorted = sorted_files(files.to_vec());
    if sorted != files {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-sandbox-order-invalid",
        ));
    }
    Ok(())
}

fn sorted_files(mut files: Vec<CapabilitySandboxFile>) -> Vec<CapabilitySandboxFile> {
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    files
}

fn exact_object(
    value: &JsonValue,
    expected: &[&str],
) -> Result<Vec<(String, JsonValue)>, CapabilityComparisonError> {
    let JsonValue::Object(entries) = value else {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-json-object-invalid",
        ));
    };
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(CapabilityComparisonError::new(
            "native-capability-comparison-fields-invalid",
        ));
    }
    Ok(entries.clone())
}

fn required_value<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a JsonValue, CapabilityComparisonError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .ok_or_else(|| CapabilityComparisonError::new("native-capability-comparison-field-missing"))
}

fn required_string<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a str, CapabilityComparisonError> {
    match required_value(entries, name)? {
        JsonValue::String(value) => Ok(value),
        _ => Err(CapabilityComparisonError::new(
            "native-capability-comparison-field-type-invalid",
        )),
    }
}

fn required_number<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a str, CapabilityComparisonError> {
    match required_value(entries, name)? {
        JsonValue::Number(value) => Ok(value),
        _ => Err(CapabilityComparisonError::new(
            "native-capability-comparison-field-type-invalid",
        )),
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_canonical_hex(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("hex:") else {
        return false;
    };
    hex.len().is_multiple_of(2)
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
