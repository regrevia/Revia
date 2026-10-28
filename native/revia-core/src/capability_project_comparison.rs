use std::collections::BTreeSet;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    capability_comparison::{
        CapabilityComparisonWorkload, CapabilitySandboxFile, validate_capability_comparison_catalog,
    },
    digest::sha256_hex,
    graph::{graph_revision, load_canonical_graph},
    project::parse_json,
};

pub const CAPABILITY_PROJECT_COMPARISON_CATALOG_SCHEMA: &str =
    "re.native-capability-project-comparison-catalog@0.1.0";
pub const CAPABILITY_PROJECT_COMPARISON_REPORT_SCHEMA: &str =
    "re.native-capability-project-comparison-report@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjectComparisonError {
    pub code: String,
}

impl CapabilityProjectComparisonError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjectComparisonWorkload {
    pub workload_id: String,
    pub module: String,
    pub module_path: String,
    pub source_sha256: String,
    pub operation: String,
    pub source: String,
    pub input_digest: String,
    pub sandbox_before: Vec<CapabilitySandboxFile>,
    pub sandbox_after: Vec<CapabilitySandboxFile>,
    pub expected_outcome_code: u8,
}

impl CapabilityProjectComparisonWorkload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workload_id: impl Into<String>,
        module: impl Into<String>,
        module_path: impl Into<String>,
        source: impl Into<String>,
        operation: impl Into<String>,
        input_digest: impl Into<String>,
        sandbox_before: Vec<CapabilitySandboxFile>,
        sandbox_after: Vec<CapabilitySandboxFile>,
        expected_outcome_code: u8,
    ) -> Self {
        let source = source.into();
        Self {
            workload_id: workload_id.into(),
            module: module.into(),
            module_path: module_path.into(),
            source_sha256: digest_bytes(source.as_bytes()),
            operation: operation.into(),
            source,
            input_digest: input_digest.into(),
            sandbox_before: sorted_files(sandbox_before),
            sandbox_after: sorted_files(sandbox_after),
            expected_outcome_code,
        }
    }

    pub fn capability_workload(&self) -> CapabilityComparisonWorkload {
        CapabilityComparisonWorkload::new(
            self.workload_id.clone(),
            self.operation.clone(),
            self.source.clone(),
            self.input_digest.clone(),
            self.sandbox_before.clone(),
            self.sandbox_after.clone(),
            self.expected_outcome_code,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjectComparisonCatalog {
    pub schema: String,
    pub workloads: Vec<CapabilityProjectComparisonWorkload>,
}

impl CapabilityProjectComparisonCatalog {
    pub fn new(workloads: Vec<CapabilityProjectComparisonWorkload>) -> Self {
        Self {
            schema: CAPABILITY_PROJECT_COMPARISON_CATALOG_SCHEMA.to_owned(),
            workloads,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjectComparisonObservation {
    pub workload_id: String,
    pub module: String,
    pub module_path: String,
    pub source_sha256: String,
    pub project_digest: String,
    pub project_graph_revision: String,
    pub graph_revision: String,
    pub project_build_digest: String,
    pub project_translation_digest: String,
    pub project_run_digest: String,
    pub project_artifact_digest: String,
    pub project_receipt_digest: String,
    pub project_stdout_digest: String,
    pub project_sandbox_digest: String,
    pub direct_artifact_digest: String,
    pub bundle_artifact_digest: String,
    pub direct_result_digest: String,
    pub bundle_result_digest: String,
    pub direct_receipt_digest: String,
    pub bundle_receipt_digest: String,
    pub direct_stdout_digest: String,
    pub bundle_stdout_digest: String,
    pub direct_sandbox_digest: String,
    pub bundle_sandbox_digest: String,
    pub input_digest: String,
    pub project_outcome_code: u8,
    pub direct_outcome_code: u8,
    pub bundle_outcome_code: u8,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProjectComparisonReport {
    pub schema: String,
    pub catalog_digest: String,
    pub observations: Vec<CapabilityProjectComparisonObservation>,
    pub status: String,
    pub report_digest: String,
}

pub fn build_capability_project_comparison_report(
    catalog: &CapabilityProjectComparisonCatalog,
    observations: Vec<CapabilityProjectComparisonObservation>,
) -> Result<CapabilityProjectComparisonReport, CapabilityProjectComparisonError> {
    validate_capability_project_comparison_catalog(catalog)?;
    let mut report = CapabilityProjectComparisonReport {
        schema: CAPABILITY_PROJECT_COMPARISON_REPORT_SCHEMA.to_owned(),
        catalog_digest: catalog_digest(catalog)?,
        observations,
        status: "passed".to_owned(),
        report_digest: String::new(),
    };
    report.report_digest = report_digest(&report);
    validate_capability_project_comparison_report(catalog, &report)?;
    Ok(report)
}

pub fn validate_capability_project_comparison_catalog(
    catalog: &CapabilityProjectComparisonCatalog,
) -> Result<(), CapabilityProjectComparisonError> {
    if catalog.schema != CAPABILITY_PROJECT_COMPARISON_CATALOG_SCHEMA
        || catalog.workloads.is_empty()
    {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-catalog-invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut modules = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for workload in &catalog.workloads {
        if workload.workload_id.is_empty()
            || !ids.insert(workload.workload_id.clone())
            || workload.module.is_empty()
            || !modules.insert(workload.module.clone())
            || workload.module_path.is_empty()
            || !paths.insert(workload.module_path.clone())
            || workload.module_path.starts_with('/')
            || workload.module_path.contains('\\')
            || workload.module_path.contains('\0')
            || workload
                .module_path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-module-authority-invalid",
            ));
        }
        if workload.source_sha256 != digest_bytes(workload.source.as_bytes()) {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-source-digest-mismatch",
            ));
        }
        if workload
            .sandbox_before
            .iter()
            .chain(&workload.sandbox_after)
            .any(|file| file.path == "project.json" || file.path == workload.module_path)
        {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-sandbox-authority-mismatch",
            ));
        }
        let base = CapabilityComparisonCatalogForOne::new(workload.capability_workload());
        validate_capability_comparison_catalog(&base.0).map_err(|error| {
            CapabilityProjectComparisonError::new(&format!(
                "native-capability-project-comparison-{}",
                error.code
            ))
        })?;
        if load_canonical_graph(&workload.source)
            .and_then(|graph| graph_revision(&graph).map(|_| graph))
            .is_err()
        {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-source-invalid",
            ));
        }
    }
    Ok(())
}

struct CapabilityComparisonCatalogForOne(crate::capability_comparison::CapabilityComparisonCatalog);

impl CapabilityComparisonCatalogForOne {
    fn new(workload: CapabilityComparisonWorkload) -> Self {
        Self(crate::capability_comparison::CapabilityComparisonCatalog::new(vec![workload]))
    }
}

pub fn serialize_capability_project_comparison_catalog(
    catalog: &CapabilityProjectComparisonCatalog,
) -> Result<String, CapabilityProjectComparisonError> {
    validate_capability_project_comparison_catalog(catalog)?;
    Ok(format!("{}\n", canonicalize(&catalog_json(catalog))))
}

pub fn parse_capability_project_comparison_catalog(
    source: &str,
) -> Result<CapabilityProjectComparisonCatalog, CapabilityProjectComparisonError> {
    let value = parse_json(source).map_err(|_| {
        CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-catalog-json-invalid",
        )
    })?;
    let entries = exact_object(&value, &["schema", "workloads"])?;
    let workloads = match required_value(&entries, "workloads")? {
        JsonValue::Array(values) => values
            .iter()
            .map(parse_workload)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-workloads-invalid",
            ));
        }
    };
    let catalog = CapabilityProjectComparisonCatalog {
        schema: required_string(&entries, "schema")?.to_owned(),
        workloads,
    };
    validate_capability_project_comparison_catalog(&catalog)?;
    if serialize_capability_project_comparison_catalog(&catalog)? != source {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-catalog-noncanonical",
        ));
    }
    Ok(catalog)
}

pub fn catalog_digest(
    catalog: &CapabilityProjectComparisonCatalog,
) -> Result<String, CapabilityProjectComparisonError> {
    validate_capability_project_comparison_catalog(catalog)?;
    Ok(digest_bytes(
        canonicalize(&catalog_json(catalog)).as_bytes(),
    ))
}

pub fn validate_capability_project_comparison_report(
    catalog: &CapabilityProjectComparisonCatalog,
    report: &CapabilityProjectComparisonReport,
) -> Result<(), CapabilityProjectComparisonError> {
    validate_capability_project_comparison_catalog(catalog)?;
    if report.schema != CAPABILITY_PROJECT_COMPARISON_REPORT_SCHEMA
        || report.status != "passed"
        || report.catalog_digest != catalog_digest(catalog)?
        || report.observations.len() != catalog.workloads.len()
        || !valid_digest(&report.report_digest)
    {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-report-authority-invalid",
        ));
    }
    for (workload, observation) in catalog.workloads.iter().zip(&report.observations) {
        let graph = load_canonical_graph(&workload.source).map_err(|_| {
            CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-source-invalid",
            )
        })?;
        let revision = graph_revision(&graph).map_err(|_| {
            CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-source-invalid",
            )
        })?;
        let digest_fields = [
            &observation.project_digest,
            &observation.project_graph_revision,
            &observation.project_build_digest,
            &observation.project_translation_digest,
            &observation.project_run_digest,
            &observation.project_artifact_digest,
            &observation.project_receipt_digest,
            &observation.project_stdout_digest,
            &observation.project_sandbox_digest,
            &observation.direct_artifact_digest,
            &observation.bundle_artifact_digest,
            &observation.direct_result_digest,
            &observation.bundle_result_digest,
            &observation.direct_receipt_digest,
            &observation.bundle_receipt_digest,
            &observation.direct_stdout_digest,
            &observation.bundle_stdout_digest,
            &observation.direct_sandbox_digest,
            &observation.bundle_sandbox_digest,
        ];
        if digest_fields.iter().any(|value| !valid_digest(value))
            || observation.workload_id != workload.workload_id
            || observation.module != workload.module
            || observation.module_path != workload.module_path
            || observation.source_sha256 != workload.source_sha256
            || observation.graph_revision != revision
            || observation.input_digest != workload.input_digest
            || observation.status != "matched"
            || observation.project_outcome_code != workload.expected_outcome_code
            || observation.direct_outcome_code != workload.expected_outcome_code
            || observation.bundle_outcome_code != workload.expected_outcome_code
            || observation.direct_artifact_digest != observation.bundle_artifact_digest
            || observation.direct_artifact_digest != observation.project_artifact_digest
            || observation.direct_receipt_digest != observation.bundle_receipt_digest
            || observation.direct_receipt_digest != observation.project_receipt_digest
            || observation.direct_stdout_digest != observation.bundle_stdout_digest
            || observation.direct_stdout_digest != observation.project_stdout_digest
            || observation.direct_sandbox_digest != observation.bundle_sandbox_digest
            || observation.direct_sandbox_digest != observation.project_sandbox_digest
        {
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-observation-authority-invalid",
            ));
        }
    }
    if report.report_digest != report_digest(report) {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-report-digest-mismatch",
        ));
    }
    Ok(())
}

pub fn serialize_capability_project_comparison_report(
    catalog: &CapabilityProjectComparisonCatalog,
    report: &CapabilityProjectComparisonReport,
) -> Result<String, CapabilityProjectComparisonError> {
    validate_capability_project_comparison_report(catalog, report)?;
    Ok(format!("{}\n", canonicalize(&report_json(report))))
}

pub fn parse_capability_project_comparison_report(
    catalog: &CapabilityProjectComparisonCatalog,
    source: &str,
) -> Result<CapabilityProjectComparisonReport, CapabilityProjectComparisonError> {
    let value = parse_json(source).map_err(|_| {
        CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-report-json-invalid",
        )
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
            return Err(CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-observations-invalid",
            ));
        }
    };
    let report = CapabilityProjectComparisonReport {
        schema: required_string(&entries, "schema")?.to_owned(),
        catalog_digest: required_string(&entries, "catalog_digest")?.to_owned(),
        observations,
        status: required_string(&entries, "status")?.to_owned(),
        report_digest: required_string(&entries, "report_digest")?.to_owned(),
    };
    validate_capability_project_comparison_report(catalog, &report)?;
    if serialize_capability_project_comparison_report(catalog, &report)? != source {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-report-noncanonical",
        ));
    }
    Ok(report)
}

fn catalog_json(catalog: &CapabilityProjectComparisonCatalog) -> JsonValue {
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

fn workload_json(workload: &CapabilityProjectComparisonWorkload) -> JsonValue {
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
            "module".to_owned(),
            JsonValue::String(workload.module.clone()),
        ),
        (
            "module_path".to_owned(),
            JsonValue::String(workload.module_path.clone()),
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
            "source_sha256".to_owned(),
            JsonValue::String(workload.source_sha256.clone()),
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

fn report_json(report: &CapabilityProjectComparisonReport) -> JsonValue {
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

fn observation_json(observation: &CapabilityProjectComparisonObservation) -> JsonValue {
    let pairs = [
        (
            "bundle_artifact_digest",
            &observation.bundle_artifact_digest,
        ),
        ("bundle_receipt_digest", &observation.bundle_receipt_digest),
        ("bundle_result_digest", &observation.bundle_result_digest),
        ("bundle_sandbox_digest", &observation.bundle_sandbox_digest),
        ("bundle_stdout_digest", &observation.bundle_stdout_digest),
        (
            "direct_artifact_digest",
            &observation.direct_artifact_digest,
        ),
        ("direct_receipt_digest", &observation.direct_receipt_digest),
        ("direct_result_digest", &observation.direct_result_digest),
        ("direct_sandbox_digest", &observation.direct_sandbox_digest),
        ("direct_stdout_digest", &observation.direct_stdout_digest),
        ("graph_revision", &observation.graph_revision),
        ("input_digest", &observation.input_digest),
        ("module", &observation.module),
        ("module_path", &observation.module_path),
        (
            "project_artifact_digest",
            &observation.project_artifact_digest,
        ),
        ("project_build_digest", &observation.project_build_digest),
        ("project_digest", &observation.project_digest),
        (
            "project_graph_revision",
            &observation.project_graph_revision,
        ),
        (
            "project_receipt_digest",
            &observation.project_receipt_digest,
        ),
        ("project_run_digest", &observation.project_run_digest),
        (
            "project_sandbox_digest",
            &observation.project_sandbox_digest,
        ),
        ("project_stdout_digest", &observation.project_stdout_digest),
        (
            "project_translation_digest",
            &observation.project_translation_digest,
        ),
        ("source_sha256", &observation.source_sha256),
        ("status", &observation.status),
        ("workload_id", &observation.workload_id),
    ];
    let mut fields = pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), JsonValue::String(value.clone())))
        .collect::<Vec<_>>();
    fields.extend([
        (
            "bundle_outcome_code".to_owned(),
            JsonValue::Number(observation.bundle_outcome_code.to_string()),
        ),
        (
            "direct_outcome_code".to_owned(),
            JsonValue::Number(observation.direct_outcome_code.to_string()),
        ),
        (
            "project_outcome_code".to_owned(),
            JsonValue::Number(observation.project_outcome_code.to_string()),
        ),
    ]);
    JsonValue::Object(fields)
}

fn parse_workload(
    value: &JsonValue,
) -> Result<CapabilityProjectComparisonWorkload, CapabilityProjectComparisonError> {
    let entries = exact_object(
        value,
        &[
            "expected_outcome_code",
            "input_digest",
            "module",
            "module_path",
            "operation",
            "sandbox_after",
            "sandbox_before",
            "source",
            "source_sha256",
            "workload_id",
        ],
    )?;
    let source = required_string(&entries, "source")?.to_owned();
    let workload = CapabilityProjectComparisonWorkload {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        module: required_string(&entries, "module")?.to_owned(),
        module_path: required_string(&entries, "module_path")?.to_owned(),
        source_sha256: required_string(&entries, "source_sha256")?.to_owned(),
        operation: required_string(&entries, "operation")?.to_owned(),
        source,
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        sandbox_before: parse_files(&entries, "sandbox_before")?,
        sandbox_after: parse_files(&entries, "sandbox_after")?,
        expected_outcome_code: required_number(&entries, "expected_outcome_code")?
            .parse()
            .map_err(|_| {
                CapabilityProjectComparisonError::new(
                    "native-capability-project-comparison-outcome-code-invalid",
                )
            })?,
    };
    Ok(workload)
}

fn parse_observation(
    value: &JsonValue,
) -> Result<CapabilityProjectComparisonObservation, CapabilityProjectComparisonError> {
    let names = [
        "bundle_artifact_digest",
        "bundle_receipt_digest",
        "bundle_result_digest",
        "bundle_sandbox_digest",
        "bundle_stdout_digest",
        "direct_artifact_digest",
        "direct_receipt_digest",
        "direct_result_digest",
        "direct_sandbox_digest",
        "direct_stdout_digest",
        "graph_revision",
        "input_digest",
        "module",
        "module_path",
        "project_artifact_digest",
        "project_build_digest",
        "project_digest",
        "project_graph_revision",
        "project_receipt_digest",
        "project_run_digest",
        "project_sandbox_digest",
        "project_stdout_digest",
        "project_translation_digest",
        "source_sha256",
        "status",
        "workload_id",
        "bundle_outcome_code",
        "direct_outcome_code",
        "project_outcome_code",
    ];
    let entries = exact_object(value, &names)?;
    Ok(CapabilityProjectComparisonObservation {
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        module: required_string(&entries, "module")?.to_owned(),
        module_path: required_string(&entries, "module_path")?.to_owned(),
        source_sha256: required_string(&entries, "source_sha256")?.to_owned(),
        project_digest: required_string(&entries, "project_digest")?.to_owned(),
        project_graph_revision: required_string(&entries, "project_graph_revision")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        project_build_digest: required_string(&entries, "project_build_digest")?.to_owned(),
        project_translation_digest: required_string(&entries, "project_translation_digest")?
            .to_owned(),
        project_run_digest: required_string(&entries, "project_run_digest")?.to_owned(),
        project_artifact_digest: required_string(&entries, "project_artifact_digest")?.to_owned(),
        project_receipt_digest: required_string(&entries, "project_receipt_digest")?.to_owned(),
        project_stdout_digest: required_string(&entries, "project_stdout_digest")?.to_owned(),
        project_sandbox_digest: required_string(&entries, "project_sandbox_digest")?.to_owned(),
        direct_artifact_digest: required_string(&entries, "direct_artifact_digest")?.to_owned(),
        bundle_artifact_digest: required_string(&entries, "bundle_artifact_digest")?.to_owned(),
        direct_result_digest: required_string(&entries, "direct_result_digest")?.to_owned(),
        bundle_result_digest: required_string(&entries, "bundle_result_digest")?.to_owned(),
        direct_receipt_digest: required_string(&entries, "direct_receipt_digest")?.to_owned(),
        bundle_receipt_digest: required_string(&entries, "bundle_receipt_digest")?.to_owned(),
        direct_stdout_digest: required_string(&entries, "direct_stdout_digest")?.to_owned(),
        bundle_stdout_digest: required_string(&entries, "bundle_stdout_digest")?.to_owned(),
        direct_sandbox_digest: required_string(&entries, "direct_sandbox_digest")?.to_owned(),
        bundle_sandbox_digest: required_string(&entries, "bundle_sandbox_digest")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        project_outcome_code: parse_u8(&entries, "project_outcome_code")?,
        direct_outcome_code: parse_u8(&entries, "direct_outcome_code")?,
        bundle_outcome_code: parse_u8(&entries, "bundle_outcome_code")?,
        status: required_string(&entries, "status")?.to_owned(),
    })
}

fn parse_files(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<Vec<CapabilitySandboxFile>, CapabilityProjectComparisonError> {
    let JsonValue::Array(values) = required_value(entries, name)? else {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-sandbox-invalid",
        ));
    };
    values
        .iter()
        .map(|value| {
            let fields = exact_object(value, &["bytes_hex", "path"])?;
            Ok(CapabilitySandboxFile {
                path: required_string(&fields, "path")?.to_owned(),
                bytes_hex: required_string(&fields, "bytes_hex")?.to_owned(),
            })
        })
        .collect()
}

fn report_digest(report: &CapabilityProjectComparisonReport) -> String {
    let mut without = report.clone();
    without.report_digest.clear();
    digest_bytes(canonicalize(&report_json(&without)).as_bytes())
}

fn exact_object(
    value: &JsonValue,
    expected: &[&str],
) -> Result<Vec<(String, JsonValue)>, CapabilityProjectComparisonError> {
    let JsonValue::Object(entries) = value else {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-json-object-invalid",
        ));
    };
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-fields-invalid",
        ));
    }
    Ok(entries.clone())
}

fn required_value<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a JsonValue, CapabilityProjectComparisonError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .ok_or_else(|| {
            CapabilityProjectComparisonError::new(
                "native-capability-project-comparison-field-missing",
            )
        })
}

fn required_string<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a str, CapabilityProjectComparisonError> {
    match required_value(entries, name)? {
        JsonValue::String(value) => Ok(value),
        _ => Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-field-type-invalid",
        )),
    }
}

fn required_number<'a>(
    entries: &'a [(String, JsonValue)],
    name: &str,
) -> Result<&'a str, CapabilityProjectComparisonError> {
    match required_value(entries, name)? {
        JsonValue::Number(value) => Ok(value),
        _ => Err(CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-field-type-invalid",
        )),
    }
}

fn parse_u8(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<u8, CapabilityProjectComparisonError> {
    required_number(entries, name)?.parse().map_err(|_| {
        CapabilityProjectComparisonError::new(
            "native-capability-project-comparison-outcome-code-invalid",
        )
    })
}

fn sorted_files(mut files: Vec<CapabilitySandboxFile>) -> Vec<CapabilitySandboxFile> {
    files.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
    files
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
