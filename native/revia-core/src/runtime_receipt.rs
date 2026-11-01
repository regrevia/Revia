use std::collections::BTreeSet;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
    runtime_authority::{RuntimeAuthorityError, RuntimeLoadAuthorityPin},
};

pub const RUNTIME_LOAD_RECEIPT_SCHEMA: &str = "re.native-runtime-load-receipt@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLoadReceipt {
    pub schema: String,
    pub authority_pin_digest: String,
    pub loaded_bytes_digest: String,
    pub runtime: String,
    pub command: String,
    pub environment_input_digest: String,
    pub result_digest: String,
    pub vm_artifact_digest: String,
    pub vm_receipt_digest: String,
    pub stdout_digest: String,
    pub receipt_digest: String,
}

pub fn build_runtime_load_receipt(
    pin: &RuntimeLoadAuthorityPin,
    result_bytes: &[u8],
    stdout_bytes: &[u8],
) -> Result<RuntimeLoadReceipt, RuntimeAuthorityError> {
    let (result_graph_revision, vm_artifact_digest, result_input_digest, vm_receipt_digest) =
        extract_vm_result_facts(result_bytes)?;
    if result_graph_revision != pin.graph_revision
        || result_input_digest != pin.environment_input_digest
    {
        return Err(RuntimeAuthorityError::new("DRIFTED"));
    }
    let mut receipt = RuntimeLoadReceipt {
        schema: RUNTIME_LOAD_RECEIPT_SCHEMA.to_owned(),
        authority_pin_digest: pin.pin_digest.clone(),
        loaded_bytes_digest: pin.loaded_bytes_digest.clone(),
        runtime: pin.runtime.clone(),
        command: pin.command.clone(),
        environment_input_digest: pin.environment_input_digest.clone(),
        result_digest: digest(result_bytes),
        vm_artifact_digest,
        vm_receipt_digest,
        stdout_digest: digest(stdout_bytes),
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = receipt_digest(&receipt);
    Ok(receipt)
}

pub fn serialize_runtime_load_receipt(
    receipt: &RuntimeLoadReceipt,
) -> Result<String, RuntimeAuthorityError> {
    validate_receipt(receipt)?;
    Ok(format!("{}\n", canonicalize(&receipt_json(receipt, true))))
}

pub fn parse_runtime_load_receipt(
    source: &str,
) -> Result<RuntimeLoadReceipt, RuntimeAuthorityError> {
    if !source.ends_with('\n') {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-trailing-newline-missing",
        ));
    }
    let value = parse_json(source)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-receipt-json-invalid"))?;
    let receipt = parse_receipt(&value)?;
    if serialize_runtime_load_receipt(&receipt)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-receipt-invalid"))?
        != source
    {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-noncanonical",
        ));
    }
    Ok(receipt)
}

pub fn verify_runtime_load_receipt(
    source: &str,
    pin: &RuntimeLoadAuthorityPin,
    result_bytes: &[u8],
    stdout_bytes: &[u8],
) -> Result<RuntimeLoadReceipt, RuntimeAuthorityError> {
    let receipt = parse_runtime_load_receipt(source)?;
    let expected = build_runtime_load_receipt(pin, result_bytes, stdout_bytes)?;
    if receipt != expected {
        return Err(RuntimeAuthorityError::new("DRIFTED"));
    }
    Ok(receipt)
}

fn extract_vm_result_facts(
    result_bytes: &[u8],
) -> Result<(String, String, String, String), RuntimeAuthorityError> {
    let source = std::str::from_utf8(result_bytes)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-receipt-result-invalid"))?;
    let value = parse_json(source)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-receipt-result-invalid"))?;
    let JsonValue::Object(entries) = value else {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-result-invalid",
        ));
    };
    let digest = entries
        .iter()
        .find(|(key, _)| key == "receipt_digest")
        .and_then(|(_, value)| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        })
        .ok_or_else(|| RuntimeAuthorityError::new("native-runtime-load-receipt-result-invalid"))?;
    let graph_revision = required_string(&entries, "graph_revision")?;
    let artifact_digest = required_string(&entries, "artifact_digest")?;
    let input_digest = required_string(&entries, "input_digest")?;
    if !is_digest(&digest)
        || !is_digest(&graph_revision)
        || !is_digest(&artifact_digest)
        || !is_digest(&input_digest)
    {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-result-invalid",
        ));
    }
    Ok((graph_revision, artifact_digest, input_digest, digest))
}

fn required_string(
    entries: &[(String, JsonValue)],
    name: &str,
) -> Result<String, RuntimeAuthorityError> {
    entries
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| match value {
            JsonValue::String(value) => Some(value.clone()),
            _ => None,
        })
        .ok_or_else(|| RuntimeAuthorityError::new("native-runtime-load-receipt-result-invalid"))
}

fn validate_receipt(receipt: &RuntimeLoadReceipt) -> Result<(), RuntimeAuthorityError> {
    if receipt.schema != RUNTIME_LOAD_RECEIPT_SCHEMA {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-schema-mismatch",
        ));
    }
    for value in [
        &receipt.authority_pin_digest,
        &receipt.loaded_bytes_digest,
        &receipt.environment_input_digest,
        &receipt.result_digest,
        &receipt.vm_artifact_digest,
        &receipt.vm_receipt_digest,
        &receipt.stdout_digest,
        &receipt.receipt_digest,
    ] {
        if !is_digest(value) {
            return Err(RuntimeAuthorityError::new(
                "native-runtime-load-receipt-digest-invalid",
            ));
        }
    }
    if receipt.runtime.is_empty() || receipt.command.is_empty() {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-field-invalid",
        ));
    }
    if receipt.receipt_digest != receipt_digest(receipt) {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-digest-mismatch",
        ));
    }
    Ok(())
}

fn parse_receipt(value: &JsonValue) -> Result<RuntimeLoadReceipt, RuntimeAuthorityError> {
    let JsonValue::Object(entries) = value else {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-json-invalid",
        ));
    };
    let expected = [
        "authority_pin_digest",
        "command",
        "environment_input_digest",
        "loaded_bytes_digest",
        "receipt_digest",
        "result_digest",
        "runtime",
        "schema",
        "stdout_digest",
        "vm_artifact_digest",
        "vm_receipt_digest",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-receipt-fields-invalid",
        ));
    }
    let string = |name: &str| {
        entries
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| match value {
                JsonValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .ok_or_else(|| {
                RuntimeAuthorityError::new("native-runtime-load-receipt-field-type-invalid")
            })
    };
    let receipt = RuntimeLoadReceipt {
        schema: string("schema")?,
        authority_pin_digest: string("authority_pin_digest")?,
        loaded_bytes_digest: string("loaded_bytes_digest")?,
        runtime: string("runtime")?,
        command: string("command")?,
        environment_input_digest: string("environment_input_digest")?,
        result_digest: string("result_digest")?,
        vm_artifact_digest: string("vm_artifact_digest")?,
        vm_receipt_digest: string("vm_receipt_digest")?,
        stdout_digest: string("stdout_digest")?,
        receipt_digest: string("receipt_digest")?,
    };
    validate_receipt(&receipt)?;
    Ok(receipt)
}

fn receipt_json(receipt: &RuntimeLoadReceipt, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "authority_pin_digest".to_owned(),
            JsonValue::String(receipt.authority_pin_digest.clone()),
        ),
        (
            "command".to_owned(),
            JsonValue::String(receipt.command.clone()),
        ),
        (
            "environment_input_digest".to_owned(),
            JsonValue::String(receipt.environment_input_digest.clone()),
        ),
        (
            "loaded_bytes_digest".to_owned(),
            JsonValue::String(receipt.loaded_bytes_digest.clone()),
        ),
        (
            "result_digest".to_owned(),
            JsonValue::String(receipt.result_digest.clone()),
        ),
        (
            "runtime".to_owned(),
            JsonValue::String(receipt.runtime.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(receipt.schema.clone()),
        ),
        (
            "stdout_digest".to_owned(),
            JsonValue::String(receipt.stdout_digest.clone()),
        ),
        (
            "vm_artifact_digest".to_owned(),
            JsonValue::String(receipt.vm_artifact_digest.clone()),
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

fn receipt_digest(receipt: &RuntimeLoadReceipt) -> String {
    digest(canonicalize(&receipt_json(receipt, false)).as_bytes())
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
