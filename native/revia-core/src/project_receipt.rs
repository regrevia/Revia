use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
};

pub const PROJECT_RUN_RECEIPT_SCHEMA: &str = "re.native-project-run-receipt@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRunReceipt {
    pub schema: String,
    pub project_digest: String,
    pub graph_revision: String,
    pub module: String,
    pub input_digest: String,
    pub translation_digest: String,
    pub vm_receipt_digest: String,
    pub run_digest: String,
    pub receipt_digest: String,
}

pub fn build_project_run_receipt(
    project_digest: &str,
    graph_revision: &str,
    module: &str,
    input_digest: &str,
    translation_digest: &str,
    vm_receipt_digest: &str,
    run_digest: &str,
) -> ProjectRunReceipt {
    let mut receipt = ProjectRunReceipt {
        schema: PROJECT_RUN_RECEIPT_SCHEMA.to_owned(),
        project_digest: project_digest.to_owned(),
        graph_revision: graph_revision.to_owned(),
        module: module.to_owned(),
        input_digest: input_digest.to_owned(),
        translation_digest: translation_digest.to_owned(),
        vm_receipt_digest: vm_receipt_digest.to_owned(),
        run_digest: run_digest.to_owned(),
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = digest(&receipt_json(&receipt, false));
    receipt
}

pub fn serialize_project_run_receipt(receipt: &ProjectRunReceipt) -> Result<String, String> {
    if receipt.receipt_digest != digest(&receipt_json(receipt, false)) {
        return Err("native-project-run-receipt-digest-mismatch".to_owned());
    }
    Ok(format!("{}\n", canonicalize(&receipt_json(receipt, true))))
}

fn receipt_json(receipt: &ProjectRunReceipt, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "graph_revision".to_owned(),
            JsonValue::String(receipt.graph_revision.clone()),
        ),
        (
            "input_digest".to_owned(),
            JsonValue::String(receipt.input_digest.clone()),
        ),
        (
            "module".to_owned(),
            JsonValue::String(receipt.module.clone()),
        ),
        (
            "project_digest".to_owned(),
            JsonValue::String(receipt.project_digest.clone()),
        ),
        (
            "run_digest".to_owned(),
            JsonValue::String(receipt.run_digest.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(receipt.schema.clone()),
        ),
        (
            "translation_digest".to_owned(),
            JsonValue::String(receipt.translation_digest.clone()),
        ),
        (
            "vm_receipt_digest".to_owned(),
            JsonValue::String(receipt.vm_receipt_digest.clone()),
        ),
    ];
    if include_digest {
        fields.push((
            "receipt_digest".to_owned(),
            JsonValue::String(receipt.receipt_digest.clone()),
        ));
    }
    JsonValue::Object(fields)
}

fn digest(value: &JsonValue) -> String {
    format!("sha256:{}", sha256_hex(canonicalize(value).as_bytes()))
}

pub fn parse_project_run_receipt(source: &str) -> Result<ProjectRunReceipt, String> {
    if source.starts_with('\u{feff}') {
        return Err("byte-order-mark-not-allowed".to_owned());
    }
    let value = parse_json(source).map_err(|error| error.code)?;
    let JsonValue::Object(entries) = value else {
        return Err("native-project-run-receipt-json-invalid".to_owned());
    };
    let get = |name: &str| {
        entries
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| match value {
                JsonValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .ok_or_else(|| "native-project-run-receipt-fields-invalid".to_owned())
    };
    let receipt = ProjectRunReceipt {
        schema: get("schema")?,
        project_digest: get("project_digest")?,
        graph_revision: get("graph_revision")?,
        module: get("module")?,
        input_digest: get("input_digest")?,
        translation_digest: get("translation_digest")?,
        vm_receipt_digest: get("vm_receipt_digest")?,
        run_digest: get("run_digest")?,
        receipt_digest: get("receipt_digest")?,
    };
    if receipt.schema != PROJECT_RUN_RECEIPT_SCHEMA
        || receipt.receipt_digest != digest(&receipt_json(&receipt, false))
    {
        return Err("native-project-run-receipt-digest-mismatch".to_owned());
    }
    if serialize_project_run_receipt(&receipt)? != source {
        return Err("native-project-run-receipt-non-canonical".to_owned());
    }
    Ok(receipt)
}
