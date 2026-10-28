use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
    project_runtime::ProjectRuntimeError,
};

pub const NATIVE_PROJECT_SERVER_GATE_SCHEMA: &str = "re.native-project-server-gate@0.2.0";
pub const NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA: &str = "re.native-project-server-response@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeProjectServerGateReport {
    pub build_manifest_digest: String,
    pub database_result_digest: String,
    pub graph_revision: String,
    pub http_request_digest: String,
    pub http_response_digest: String,
    pub http_status: u16,
    pub input_digest: String,
    pub json_response_digest: String,
    pub json_schema: String,
    pub module_count: usize,
    pub module_evidence_digest: String,
    pub multi_module_gate_digest: String,
    pub plan_digest: String,
    pub profile_digest: String,
    pub project_digest: String,
    pub report_digest: String,
    pub route_id: String,
    pub schema: String,
    pub sqlite_executable_digest: String,
    pub sql_parameter_digest: String,
    pub sql_statement_digest: String,
    pub toolchain_digest: String,
    pub transaction_affected_rows: usize,
}

pub fn serialize_native_project_server_gate_report(
    report: &NativeProjectServerGateReport,
) -> Result<String, ProjectRuntimeError> {
    validate_report(report)?;
    Ok(format!("{}\n", canonicalize(&report_json(report, true)?)))
}

pub fn server_gate_report_digest(
    report: &NativeProjectServerGateReport,
) -> Result<String, ProjectRuntimeError> {
    let json = report_json(report, false)?;
    Ok(format!(
        "sha256:{}",
        sha256_hex(canonicalize(&json).as_bytes())
    ))
}

fn validate_report(report: &NativeProjectServerGateReport) -> Result<(), ProjectRuntimeError> {
    if report.schema != NATIVE_PROJECT_SERVER_GATE_SCHEMA
        || report.json_schema != NATIVE_PROJECT_SERVER_RESPONSE_SCHEMA
        || report.route_id != "project-run"
        || report.http_status != 200
        || report.module_count == 0
        || report.transaction_affected_rows == 0
        || report.report_digest != server_gate_report_digest(report)?
    {
        return Err(ProjectRuntimeError::new(
            "native-project-server-gate-authority-mismatch",
        ));
    }
    for digest in [
        &report.build_manifest_digest,
        &report.database_result_digest,
        &report.graph_revision,
        &report.http_request_digest,
        &report.http_response_digest,
        &report.input_digest,
        &report.json_response_digest,
        &report.module_evidence_digest,
        &report.multi_module_gate_digest,
        &report.plan_digest,
        &report.profile_digest,
        &report.project_digest,
        &report.report_digest,
        &report.sqlite_executable_digest,
        &report.sql_parameter_digest,
        &report.sql_statement_digest,
        &report.toolchain_digest,
    ] {
        if !valid_digest(digest) {
            return Err(ProjectRuntimeError::new(
                "native-project-server-gate-digest-invalid",
            ));
        }
    }
    if report.route_id.is_empty()
        || report.json_schema.is_empty()
        || report.schema.is_empty()
        || report.http_request_digest.is_empty()
        || report.http_response_digest.is_empty()
    {
        return Err(ProjectRuntimeError::new(
            "native-project-server-gate-field-invalid",
        ));
    }
    Ok(())
}

fn report_json(
    report: &NativeProjectServerGateReport,
    include_digest: bool,
) -> Result<JsonValue, ProjectRuntimeError> {
    let mut fields = vec![
        (
            "build_manifest_digest".to_owned(),
            JsonValue::String(report.build_manifest_digest.clone()),
        ),
        (
            "database_result_digest".to_owned(),
            JsonValue::String(report.database_result_digest.clone()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(report.graph_revision.clone()),
        ),
        (
            "http_request_digest".to_owned(),
            JsonValue::String(report.http_request_digest.clone()),
        ),
        (
            "http_response_digest".to_owned(),
            JsonValue::String(report.http_response_digest.clone()),
        ),
        (
            "http_status".to_owned(),
            JsonValue::Number(report.http_status.to_string()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(report.input_digest.clone()),
        ),
        (
            "json_response_digest".to_owned(),
            JsonValue::String(report.json_response_digest.clone()),
        ),
        (
            "json_schema".to_owned(),
            JsonValue::String(report.json_schema.clone()),
        ),
        (
            "module_count".to_owned(),
            JsonValue::Number(report.module_count.to_string()),
        ),
        (
            "module_evidence_digest".to_owned(),
            JsonValue::String(report.module_evidence_digest.clone()),
        ),
        (
            "multi_module_gate_digest".to_owned(),
            JsonValue::String(report.multi_module_gate_digest.clone()),
        ),
        (
            "plan_digest".to_owned(),
            JsonValue::String(report.plan_digest.clone()),
        ),
        (
            "profile_digest".to_owned(),
            JsonValue::String(report.profile_digest.clone()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(report.project_digest.clone()),
        ),
        (
            "route_id".to_owned(),
            JsonValue::String(report.route_id.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(report.schema.clone()),
        ),
        (
            "sqlite_executable_digest".to_owned(),
            JsonValue::String(report.sqlite_executable_digest.clone()),
        ),
        (
            "sql_parameter_digest".to_owned(),
            JsonValue::String(report.sql_parameter_digest.clone()),
        ),
        (
            "sql_statement_digest".to_owned(),
            JsonValue::String(report.sql_statement_digest.clone()),
        ),
        (
            "toolchain_digest".to_owned(),
            JsonValue::String(report.toolchain_digest.clone()),
        ),
        (
            "transaction_affected_rows".to_owned(),
            JsonValue::Number(report.transaction_affected_rows.to_string()),
        ),
    ];
    if include_digest {
        fields.push((
            "report_digest".to_owned(),
            JsonValue::String(report.report_digest.clone()),
        ));
    }
    let value = JsonValue::Object(fields);
    parse_json(&canonicalize(&value)).map_err(|error| ProjectRuntimeError::new(&error.code))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}
