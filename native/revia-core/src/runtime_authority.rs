use std::collections::BTreeSet;

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    project::parse_json,
    runtime_bundle::verify_runtime_bundle,
};

pub const RUNTIME_LOAD_AUTHORITY_SCHEMA: &str = "re.native-runtime-load-authority@0.1.0";
const HASH_ALGORITHM: &str = "sha-256";
const CANONICALIZATION: &str = "re.native-runtime-bundle@0.1.0+canonical-json@1";
const LOAD_PROCESS: &str = "runtime-run.read-bytes-before-verify@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAuthorityError {
    pub code: String,
}

impl RuntimeAuthorityError {
    pub(crate) fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLoadAuthorityPin {
    pub schema: String,
    pub reviewed_source_digest: String,
    pub graph_revision: String,
    pub build_artifact_digest: String,
    pub reviewed_bundle_digest: String,
    pub loaded_bytes_digest: String,
    pub runtime: String,
    pub command: String,
    pub environment_input_digest: String,
    pub hash_algorithm: String,
    pub canonicalization: String,
    pub load_process: String,
    pub pin_digest: String,
}

pub fn build_runtime_load_authority_pin(
    bundle_source: &str,
    runtime: &str,
    command: &str,
    input_digest: &str,
) -> Result<RuntimeLoadAuthorityPin, RuntimeAuthorityError> {
    let bundle = verify_runtime_bundle(bundle_source)
        .map_err(|error| RuntimeAuthorityError::new(&error.code))?;
    let mut pin = RuntimeLoadAuthorityPin {
        schema: RUNTIME_LOAD_AUTHORITY_SCHEMA.to_owned(),
        reviewed_source_digest: digest(bundle.canonical_source.as_bytes()),
        graph_revision: bundle.graph_revision,
        build_artifact_digest: bundle.artifact_digest,
        reviewed_bundle_digest: bundle.bundle_digest,
        loaded_bytes_digest: digest(bundle_source.as_bytes()),
        runtime: runtime.to_owned(),
        command: command.to_owned(),
        environment_input_digest: input_digest.to_owned(),
        hash_algorithm: HASH_ALGORITHM.to_owned(),
        canonicalization: CANONICALIZATION.to_owned(),
        load_process: LOAD_PROCESS.to_owned(),
        pin_digest: String::new(),
    };
    validate_pin_fields(&pin)?;
    pin.pin_digest = pin_digest(&pin);
    Ok(pin)
}

pub fn serialize_runtime_load_authority_pin(
    pin: &RuntimeLoadAuthorityPin,
) -> Result<String, RuntimeAuthorityError> {
    validate_pin(pin)?;
    Ok(format!("{}\n", canonicalize(&pin_json(pin, true))))
}

pub fn parse_runtime_load_authority_pin(
    source: &str,
) -> Result<RuntimeLoadAuthorityPin, RuntimeAuthorityError> {
    if !source.ends_with('\n') {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-trailing-newline-missing",
        ));
    }
    let value = parse_json(source)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-authority-json-invalid"))?;
    let pin = parse_pin(&value)?;
    if serialize_runtime_load_authority_pin(&pin)
        .map_err(|_| RuntimeAuthorityError::new("native-runtime-load-authority-invalid"))?
        != source
    {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-noncanonical",
        ));
    }
    Ok(pin)
}

pub fn verify_runtime_load_authority(
    pin_source: &str,
    loaded_bundle_bytes: &[u8],
    runtime: &str,
    command: &str,
    input_digest: &str,
) -> Result<RuntimeLoadAuthorityPin, RuntimeAuthorityError> {
    let pin = parse_runtime_load_authority_pin(pin_source)?;
    let loaded_bundle_source = std::str::from_utf8(loaded_bundle_bytes).map_err(|_| {
        RuntimeAuthorityError::new("native-runtime-load-authority-loaded-bytes-invalid")
    })?;
    let bundle = verify_runtime_bundle(loaded_bundle_source)
        .map_err(|_| RuntimeAuthorityError::new("DRIFTED"))?;
    let loaded_bytes_digest = digest(loaded_bundle_bytes);
    let reviewed_source_digest = digest(bundle.canonical_source.as_bytes());
    if pin.reviewed_source_digest != reviewed_source_digest
        || pin.graph_revision != bundle.graph_revision
        || pin.build_artifact_digest != bundle.artifact_digest
        || pin.reviewed_bundle_digest != bundle.bundle_digest
        || pin.loaded_bytes_digest != loaded_bytes_digest
        || pin.runtime != runtime
        || pin.command != command
        || pin.environment_input_digest != input_digest
    {
        return Err(RuntimeAuthorityError::new("DRIFTED"));
    }
    Ok(pin)
}

fn validate_pin(pin: &RuntimeLoadAuthorityPin) -> Result<(), RuntimeAuthorityError> {
    validate_pin_fields(pin)?;
    if pin.pin_digest != pin_digest(pin) {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-digest-mismatch",
        ));
    }
    Ok(())
}

fn validate_pin_fields(pin: &RuntimeLoadAuthorityPin) -> Result<(), RuntimeAuthorityError> {
    if pin.schema != RUNTIME_LOAD_AUTHORITY_SCHEMA {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-schema-mismatch",
        ));
    }
    for digest_value in [
        &pin.reviewed_source_digest,
        &pin.graph_revision,
        &pin.build_artifact_digest,
        &pin.reviewed_bundle_digest,
        &pin.loaded_bytes_digest,
        &pin.environment_input_digest,
    ] {
        if !is_digest(digest_value) {
            return Err(RuntimeAuthorityError::new(
                "native-runtime-load-authority-digest-invalid",
            ));
        }
    }
    if pin.runtime.is_empty()
        || pin.command.is_empty()
        || pin.hash_algorithm != HASH_ALGORITHM
        || pin.canonicalization != CANONICALIZATION
        || pin.load_process != LOAD_PROCESS
    {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-field-invalid",
        ));
    }
    Ok(())
}

fn parse_pin(value: &JsonValue) -> Result<RuntimeLoadAuthorityPin, RuntimeAuthorityError> {
    let JsonValue::Object(entries) = value else {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-json-invalid",
        ));
    };
    let expected = [
        "build_artifact_digest",
        "canonicalization",
        "command",
        "environment_input_digest",
        "graph_revision",
        "hash_algorithm",
        "load_process",
        "loaded_bytes_digest",
        "pin_digest",
        "reviewed_bundle_digest",
        "reviewed_source_digest",
        "runtime",
        "schema",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(RuntimeAuthorityError::new(
            "native-runtime-load-authority-fields-invalid",
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
                RuntimeAuthorityError::new("native-runtime-load-authority-field-type-invalid")
            })
    };
    let pin = RuntimeLoadAuthorityPin {
        schema: string("schema")?,
        reviewed_source_digest: string("reviewed_source_digest")?,
        graph_revision: string("graph_revision")?,
        build_artifact_digest: string("build_artifact_digest")?,
        reviewed_bundle_digest: string("reviewed_bundle_digest")?,
        loaded_bytes_digest: string("loaded_bytes_digest")?,
        runtime: string("runtime")?,
        command: string("command")?,
        environment_input_digest: string("environment_input_digest")?,
        hash_algorithm: string("hash_algorithm")?,
        canonicalization: string("canonicalization")?,
        load_process: string("load_process")?,
        pin_digest: string("pin_digest")?,
    };
    validate_pin(&pin)?;
    Ok(pin)
}

fn pin_json(pin: &RuntimeLoadAuthorityPin, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "build_artifact_digest".to_owned(),
            JsonValue::String(pin.build_artifact_digest.clone()),
        ),
        (
            "canonicalization".to_owned(),
            JsonValue::String(pin.canonicalization.clone()),
        ),
        ("command".to_owned(), JsonValue::String(pin.command.clone())),
        (
            "environment_input_digest".to_owned(),
            JsonValue::String(pin.environment_input_digest.clone()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(pin.graph_revision.clone()),
        ),
        (
            "hash_algorithm".to_owned(),
            JsonValue::String(pin.hash_algorithm.clone()),
        ),
        (
            "load_process".to_owned(),
            JsonValue::String(pin.load_process.clone()),
        ),
        (
            "loaded_bytes_digest".to_owned(),
            JsonValue::String(pin.loaded_bytes_digest.clone()),
        ),
        (
            "reviewed_bundle_digest".to_owned(),
            JsonValue::String(pin.reviewed_bundle_digest.clone()),
        ),
        (
            "reviewed_source_digest".to_owned(),
            JsonValue::String(pin.reviewed_source_digest.clone()),
        ),
        ("runtime".to_owned(), JsonValue::String(pin.runtime.clone())),
        ("schema".to_owned(), JsonValue::String(pin.schema.clone())),
    ];
    if include_digest {
        fields.push((
            "pin_digest".to_owned(),
            JsonValue::String(pin.pin_digest.clone()),
        ));
    }
    JsonValue::Object(fields)
}

fn pin_digest(pin: &RuntimeLoadAuthorityPin) -> String {
    digest(canonicalize(&pin_json(pin, false)).as_bytes())
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
