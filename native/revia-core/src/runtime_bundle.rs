use std::collections::BTreeSet;

use crate::{
    bytecode::{
        NATIVE_BYTECODE_PROFILE, NATIVE_BYTECODE_RELEASE, NATIVE_BYTECODE_TRANSLATOR,
        load_bytecode_artifact, verify_bytecode_artifact,
    },
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    graph::{Graph, check_graph, graph_revision, load_canonical_graph, serialize_canonical_graph},
    project::parse_json,
};

pub const RUNTIME_BUNDLE_SCHEMA: &str = "re.native-runtime-bundle@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleError {
    pub code: String,
}

impl RuntimeBundleError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeRuntimeBundle {
    pub schema: String,
    pub canonical_source: String,
    pub source_digest: String,
    pub graph_revision: String,
    pub artifact: String,
    pub artifact_digest: String,
    pub profile: String,
    pub release: String,
    pub translator: String,
    pub bundle_digest: String,
}

pub fn build_runtime_bundle(
    graph: &Graph,
    artifact_source: &str,
) -> Result<NativeRuntimeBundle, RuntimeBundleError> {
    let checked = check_graph(graph.clone()).map_err(graph_error)?;
    let canonical_source = serialize_canonical_graph(&checked).map_err(graph_error)?;
    let revision = graph_revision(&checked).map_err(graph_error)?;
    let artifact = verify_bytecode_artifact(&checked, artifact_source).map_err(graph_error)?;
    let mut bundle = NativeRuntimeBundle {
        schema: RUNTIME_BUNDLE_SCHEMA.to_owned(),
        canonical_source,
        source_digest: String::new(),
        graph_revision: revision,
        artifact: artifact_source.to_owned(),
        artifact_digest: digest(artifact_source.as_bytes()),
        profile: artifact.profile,
        release: artifact.release,
        translator: artifact.translator,
        bundle_digest: String::new(),
    };
    bundle.source_digest = digest(bundle.canonical_source.as_bytes());
    bundle.bundle_digest = bundle_digest(&bundle)?;
    Ok(bundle)
}

pub fn serialize_runtime_bundle(
    bundle: &NativeRuntimeBundle,
) -> Result<String, RuntimeBundleError> {
    validate_bundle(bundle)?;
    Ok(format!("{}\n", canonicalize(&bundle_json(bundle, true))))
}

pub fn parse_runtime_bundle(source: &str) -> Result<NativeRuntimeBundle, RuntimeBundleError> {
    if !source.ends_with('\n') {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-trailing-newline-missing",
        ));
    }
    let value = parse_json(source)
        .map_err(|_| RuntimeBundleError::new("native-runtime-bundle-json-invalid"))?;
    let bundle = parse_bundle(&value)?;
    if serialize_runtime_bundle(&bundle)
        .map_err(|_| RuntimeBundleError::new("native-runtime-bundle-noncanonical"))?
        != source
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-noncanonical",
        ));
    }
    Ok(bundle)
}

pub fn verify_runtime_bundle(source: &str) -> Result<NativeRuntimeBundle, RuntimeBundleError> {
    let bundle = parse_runtime_bundle(source)?;
    let graph = load_canonical_graph(&bundle.canonical_source).map_err(graph_error)?;
    let checked = check_graph(graph).map_err(graph_error)?;
    let canonical_source = serialize_canonical_graph(&checked).map_err(graph_error)?;
    if canonical_source != bundle.canonical_source {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-graph-canonical-mismatch",
        ));
    }
    let revision = graph_revision(&checked).map_err(graph_error)?;
    if revision != bundle.graph_revision
        || bundle.source_digest != digest(bundle.canonical_source.as_bytes())
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-graph-authority-mismatch",
        ));
    }
    let artifact = load_bytecode_artifact(&bundle.artifact).map_err(graph_error)?;
    let verified = verify_bytecode_artifact(&checked, &bundle.artifact).map_err(graph_error)?;
    if artifact != verified
        || bundle.artifact_digest != digest(bundle.artifact.as_bytes())
        || bundle.profile != artifact.profile
        || bundle.release != artifact.release
        || bundle.translator != artifact.translator
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-artifact-authority-mismatch",
        ));
    }
    if bundle.profile != NATIVE_BYTECODE_PROFILE
        || bundle.release != NATIVE_BYTECODE_RELEASE
        || bundle.translator != NATIVE_BYTECODE_TRANSLATOR
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-toolchain-mismatch",
        ));
    }
    if bundle.bundle_digest != bundle_digest(&bundle)? {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-digest-mismatch",
        ));
    }
    Ok(bundle)
}

fn validate_bundle(bundle: &NativeRuntimeBundle) -> Result<(), RuntimeBundleError> {
    if bundle.schema != RUNTIME_BUNDLE_SCHEMA {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-schema-mismatch",
        ));
    }
    if bundle.canonical_source.is_empty()
        || !bundle.canonical_source.starts_with("re 0.1 canonical\n")
        || !bundle.canonical_source.ends_with('\n')
        || bundle.canonical_source.contains('\r')
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-source-invalid",
        ));
    }
    if bundle.artifact.is_empty() || !bundle.artifact.ends_with('\n') {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-artifact-invalid",
        ));
    }
    if !is_digest(&bundle.source_digest)
        || !is_digest(&bundle.artifact_digest)
        || !is_digest(&bundle.graph_revision)
        || !is_digest(&bundle.bundle_digest)
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-digest-invalid",
        ));
    }
    if bundle.profile != NATIVE_BYTECODE_PROFILE
        || bundle.release != NATIVE_BYTECODE_RELEASE
        || bundle.translator != NATIVE_BYTECODE_TRANSLATOR
    {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-toolchain-mismatch",
        ));
    }
    Ok(())
}

fn parse_bundle(value: &JsonValue) -> Result<NativeRuntimeBundle, RuntimeBundleError> {
    let JsonValue::Object(entries) = value else {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-json-invalid",
        ));
    };
    let expected = [
        "artifact",
        "artifact_digest",
        "bundle_digest",
        "canonical_source",
        "graph_revision",
        "profile",
        "release",
        "schema",
        "source_digest",
        "translator",
    ];
    let keys = entries
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<BTreeSet<_>>();
    if entries.len() != expected.len() || expected.iter().any(|key| !keys.contains(key)) {
        return Err(RuntimeBundleError::new(
            "native-runtime-bundle-fields-invalid",
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
            .ok_or_else(|| RuntimeBundleError::new("native-runtime-bundle-field-type-invalid"))
    };
    let bundle = NativeRuntimeBundle {
        schema: string("schema")?,
        canonical_source: string("canonical_source")?,
        source_digest: string("source_digest")?,
        graph_revision: string("graph_revision")?,
        artifact: string("artifact")?,
        artifact_digest: string("artifact_digest")?,
        profile: string("profile")?,
        release: string("release")?,
        translator: string("translator")?,
        bundle_digest: string("bundle_digest")?,
    };
    validate_bundle(&bundle)?;
    Ok(bundle)
}

fn bundle_json(bundle: &NativeRuntimeBundle, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "artifact".to_owned(),
            JsonValue::String(bundle.artifact.clone()),
        ),
        (
            "artifact_digest".to_owned(),
            JsonValue::String(bundle.artifact_digest.clone()),
        ),
        (
            "canonical_source".to_owned(),
            JsonValue::String(bundle.canonical_source.clone()),
        ),
        (
            "graph_revision".to_owned(),
            JsonValue::String(bundle.graph_revision.clone()),
        ),
        (
            "profile".to_owned(),
            JsonValue::String(bundle.profile.clone()),
        ),
        (
            "release".to_owned(),
            JsonValue::String(bundle.release.clone()),
        ),
        (
            "schema".to_owned(),
            JsonValue::String(bundle.schema.clone()),
        ),
        (
            "source_digest".to_owned(),
            JsonValue::String(bundle.source_digest.clone()),
        ),
        (
            "translator".to_owned(),
            JsonValue::String(bundle.translator.clone()),
        ),
    ];
    if include_digest {
        fields.push((
            "bundle_digest".to_owned(),
            JsonValue::String(bundle.bundle_digest.clone()),
        ));
    }
    JsonValue::Object(fields)
}

fn bundle_digest(bundle: &NativeRuntimeBundle) -> Result<String, RuntimeBundleError> {
    Ok(digest(canonicalize(&bundle_json(bundle, false)).as_bytes()))
}

fn graph_error(error: crate::graph::GraphError) -> RuntimeBundleError {
    RuntimeBundleError::new(&error.code)
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
