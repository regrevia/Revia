use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    digest::sha256_hex,
    graph::Graph,
    project::parse_json,
    replay::{NativeReplayTranscript, observed_invocation_json},
    vm::{CapabilityResponse, VmValue},
};

pub const CROSS_LANGUAGE_BACKEND_RESULT_SCHEMA: &str = "re.cross-language-backend-result@0.2.0";
pub const CROSS_LANGUAGE_MATRIX_SCHEMA: &str = "re.cross-language-replay-matrix@0.2.0";
pub const CROSS_LANGUAGE_OBSERVATION_SCHEMA: &str = "re.cross-language-observation@0.1.0";

const MEASURED_BACKENDS: [&str; 2] = ["native", "node"];
const PENDING_BACKENDS: [&str; 2] = ["go", "jvm"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossLanguageError {
    pub code: String,
}

impl CrossLanguageError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossLanguageInvocation {
    pub instance: String,
    pub member: String,
    pub invocation_id: String,
    pub outcome: String,
}

impl CrossLanguageInvocation {
    pub fn new(
        instance: impl Into<String>,
        member: impl Into<String>,
        invocation_id: impl Into<String>,
        outcome: impl Into<String>,
    ) -> Self {
        Self {
            instance: instance.into(),
            member: member.into(),
            invocation_id: invocation_id.into(),
            outcome: outcome.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossLanguageBackendResult {
    pub schema: String,
    pub backend: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub toolchain_digest: String,
    pub observed_result_digest: String,
    pub result_digest: String,
    pub receipt_digest: String,
    pub semantic_digest: String,
    pub outcome_code: u16,
    pub outcome_type: String,
    pub invocations: Vec<CrossLanguageInvocation>,
    pub status: String,
}

impl CrossLanguageBackendResult {
    #[allow(clippy::too_many_arguments)]
    pub fn measured(
        backend: impl Into<String>,
        graph_revision: impl Into<String>,
        input_digest: impl Into<String>,
        transcript_digest: impl Into<String>,
        toolchain_digest: impl Into<String>,
        observed_result_digest: impl Into<String>,
        receipt_digest: impl Into<String>,
        outcome_code: u16,
        outcome_type: impl Into<String>,
        invocations: Vec<CrossLanguageInvocation>,
    ) -> Self {
        let outcome_type = outcome_type.into();
        let mut result = Self {
            schema: CROSS_LANGUAGE_BACKEND_RESULT_SCHEMA.to_owned(),
            backend: backend.into(),
            graph_revision: graph_revision.into(),
            input_digest: input_digest.into(),
            transcript_digest: transcript_digest.into(),
            toolchain_digest: toolchain_digest.into(),
            observed_result_digest: observed_result_digest.into(),
            result_digest: String::new(),
            receipt_digest: receipt_digest.into(),
            semantic_digest: String::new(),
            outcome_code,
            outcome_type,
            invocations,
            status: "measured".to_owned(),
        };
        result.semantic_digest = backend_semantic_digest(
            result.outcome_code,
            &result.outcome_type,
            &result.invocations,
            &result.observed_result_digest,
        );
        result.result_digest = backend_result_digest(&result);
        result
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingBackend {
    pub backend: String,
    pub reason: String,
}

impl PendingBackend {
    pub fn new(backend: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            backend: backend.into(),
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossLanguageReplayMatrix {
    pub schema: String,
    pub workload_id: String,
    pub graph_revision: String,
    pub input_digest: String,
    pub transcript_digest: String,
    pub measured: Vec<CrossLanguageBackendResult>,
    pub pending: Vec<PendingBackend>,
    pub status: String,
    pub equivalence_digest: String,
    pub matrix_digest: String,
}

pub fn backend_semantic_digest(
    outcome_code: u16,
    outcome_type: &str,
    invocations: &[CrossLanguageInvocation],
    observed_result_digest: &str,
) -> String {
    digest_json(&object(vec![
        (
            "invocations",
            JsonValue::Array(invocations.iter().map(invocation_json).collect()),
        ),
        ("outcome_code", JsonValue::Number(outcome_code.to_string())),
        ("outcome_type", JsonValue::String(outcome_type.to_owned())),
        (
            "observed_result_digest",
            JsonValue::String(observed_result_digest.to_owned()),
        ),
        (
            "schema",
            JsonValue::String(CROSS_LANGUAGE_OBSERVATION_SCHEMA.to_owned()),
        ),
    ]))
}

pub fn observed_execution_digest(
    outcome_code: u16,
    outcome_type: &str,
    program_stdout: &[u8],
    effect_projection_digest: &str,
) -> String {
    digest_json(&object(vec![
        (
            "effects",
            JsonValue::String(effect_projection_digest.to_owned()),
        ),
        (
            "outcome",
            object(vec![
                ("code", JsonValue::Number(outcome_code.to_string())),
                ("type", JsonValue::String(outcome_type.to_owned())),
            ]),
        ),
        (
            "program_stdout_sha256",
            JsonValue::String(format!("sha256:{}", sha256_hex(program_stdout))),
        ),
        (
            "schema",
            JsonValue::String(CROSS_LANGUAGE_OBSERVATION_SCHEMA.to_owned()),
        ),
    ]))
}

pub fn observed_replay_result_digest(
    graph: &Graph,
    transcript: &NativeReplayTranscript,
    outcome_code: u16,
    outcome_type: &str,
) -> Result<String, CrossLanguageError> {
    let stdout_instances = graph
        .capabilities
        .iter()
        .filter(|capability| capability.reference == "process.stdout@0.1.0")
        .map(|capability| capability.instance.as_str())
        .collect::<BTreeSet<_>>();
    let mut stdout = Vec::new();
    for invocation in &transcript.invocations {
        if !stdout_instances.contains(invocation.instance.as_str()) {
            continue;
        }
        if !matches!(
            invocation.response,
            CapabilityResponse::Value { ref variant, .. } if variant == "ok"
        ) {
            continue;
        }
        if let Some(VmValue::Text(value)) = invocation.arguments.get("data") {
            stdout.extend_from_slice(value.as_bytes());
        }
    }
    Ok(observed_execution_digest(
        outcome_code,
        outcome_type,
        &stdout,
        &observed_effect_projection_digest(graph, transcript)?,
    ))
}

pub fn observed_node_run_result_digest(
    source: &str,
    graph: &Graph,
    expected_graph_revision: &str,
    transcript: &NativeReplayTranscript,
) -> Result<String, CrossLanguageError> {
    let value = parse_json(source)
        .map_err(|_| CrossLanguageError::new("cross-language-observed-run-result-invalid"))?;
    let fields = exact_object(
        &value,
        &[
            "outcome",
            "program_stdout",
            "runtime_effect_receipt",
            "schema",
        ],
    )?;
    if required_string(&fields, "schema")? != "re.run-result@0.2.0" {
        return Err(CrossLanguageError::new(
            "cross-language-observed-run-result-invalid",
        ));
    }
    let receipt = fields
        .get("runtime_effect_receipt")
        .copied()
        .ok_or_else(|| CrossLanguageError::new("cross-language-node-effect-receipt-missing"))?;
    // A null receipt is only meaningful when nothing could be observed: the
    // transcript records no capability invocation. With a non-empty transcript
    // the receipt must exist and is validated below.
    if transcript.invocations.is_empty() && matches!(receipt, JsonValue::Null) {
        let (code, stdout) = observed_process_status(&fields)?;
        return Ok(observed_execution_digest(
            code,
            "process.status",
            stdout.as_bytes(),
            &observed_effect_projection_digest(graph, transcript)?,
        ));
    }
    if matches!(receipt, JsonValue::Null) {
        return Err(CrossLanguageError::new(
            "cross-language-node-effect-receipt-invalid",
        ));
    }
    let receipt_fields = exact_object(
        receipt,
        &["graph_revision", "observations", "receipt_digest", "schema"],
    )?;
    let schema = required_string(&receipt_fields, "schema")?;
    let graph_revision = required_string(&receipt_fields, "graph_revision")?;
    let receipt_digest = required_string(&receipt_fields, "receipt_digest")?;
    let observations = match receipt_fields.get("observations") {
        Some(JsonValue::Array(values)) => values,
        _ => {
            return Err(CrossLanguageError::new(
                "cross-language-node-effect-receipt-invalid",
            ));
        }
    };
    if schema != "re.runtime-effect-receipt@0.1.0"
        || graph_revision != expected_graph_revision
        || observations.len() != transcript.invocations.len()
    {
        return Err(CrossLanguageError::new(
            "cross-language-node-effect-receipt-authority-mismatch",
        ));
    }
    let receipt_content = JsonValue::Object(
        receipt_fields
            .iter()
            .filter(|(key, _)| key.as_str() != "receipt_digest")
            .map(|(key, value)| (key.clone(), (*value).clone()))
            .collect(),
    );
    if !is_digest(receipt_digest) || digest_json(&receipt_content) != receipt_digest {
        return Err(CrossLanguageError::new(
            "cross-language-node-effect-receipt-digest-mismatch",
        ));
    }
    let mut normalized = Vec::with_capacity(observations.len());
    let mut demand_occurrences = BTreeMap::<String, u64>::new();
    for (sequence, value) in observations.iter().enumerate() {
        let entries = exact_object(
            value,
            &[
                "arguments",
                "demand_id",
                "effect_uid",
                "instance",
                "member",
                "occurrence",
                "receipt_id",
                "reference",
                "response",
                "sequence",
            ],
        )?;
        if required_number(&entries, "sequence")? != sequence.to_string()
            || required_string(&entries, "effect_uid")?.is_empty()
            || !is_digest(required_string(&entries, "demand_id")?)
            || !is_digest(required_string(&entries, "receipt_id")?)
        {
            return Err(CrossLanguageError::new(
                "cross-language-node-effect-receipt-invalid",
            ));
        }
        // The Node bridge records the capability invocation id as the effect
        // uid, so it is bound to the transcript rather than trusted verbatim.
        if required_string(&entries, "effect_uid")?
            != transcript.invocations[sequence].invocation_id
        {
            return Err(CrossLanguageError::new(
                "cross-language-node-effect-receipt-observation-digest-mismatch",
            ));
        }
        let arguments = entries
            .get("arguments")
            .map(|value| (*value).clone())
            .ok_or_else(|| CrossLanguageError::new("cross-language-node-effect-receipt-invalid"))?;
        let instance = required_string(&entries, "instance")?;
        let member = required_string(&entries, "member")?;
        let reference = required_string(&entries, "reference")?;
        let response = entries
            .get("response")
            .map(|value| (*value).clone())
            .ok_or_else(|| CrossLanguageError::new("cross-language-node-effect-receipt-invalid"))?;
        let demand = object(vec![
            ("arguments", arguments.clone()),
            ("instance", JsonValue::String(instance.to_owned())),
            ("member", JsonValue::String(member.to_owned())),
            ("reference", JsonValue::String(reference.to_owned())),
            (
                "schema",
                JsonValue::String("re.runtime-effect-demand@0.1.0".to_owned()),
            ),
        ]);
        let demand_key = canonicalize(&demand);
        let occurrence = *demand_occurrences.get(&demand_key).unwrap_or(&0);
        if required_number(&entries, "occurrence")? != occurrence.to_string() {
            return Err(CrossLanguageError::new(
                "cross-language-node-effect-receipt-demand-mismatch",
            ));
        }
        demand_occurrences.insert(demand_key, occurrence + 1);
        let expected_demand_id = digest_json(&object(vec![
            ("arguments", arguments.clone()),
            ("instance", JsonValue::String(instance.to_owned())),
            ("member", JsonValue::String(member.to_owned())),
            ("occurrence", JsonValue::Number(occurrence.to_string())),
            ("reference", JsonValue::String(reference.to_owned())),
            (
                "schema",
                JsonValue::String("re.runtime-effect-demand@0.1.0".to_owned()),
            ),
        ]));
        let expected_receipt_id = digest_json(&object(vec![
            ("demand_id", JsonValue::String(expected_demand_id.clone())),
            ("response", response.clone()),
            (
                "schema",
                JsonValue::String("re.runtime-effect-receipt@0.1.0".to_owned()),
            ),
        ]));
        if required_string(&entries, "demand_id")? != expected_demand_id
            || required_string(&entries, "receipt_id")? != expected_receipt_id
        {
            return Err(CrossLanguageError::new(
                "cross-language-node-effect-receipt-observation-digest-mismatch",
            ));
        }
        normalized.push(object(vec![
            ("arguments", arguments),
            ("instance", JsonValue::String(instance.to_owned())),
            ("member", JsonValue::String(member.to_owned())),
            ("reference", JsonValue::String(reference.to_owned())),
            ("response", response),
            ("sequence", JsonValue::Number(sequence.to_string())),
        ]));
    }
    let expected = transcript
        .invocations
        .iter()
        .enumerate()
        .map(|(sequence, invocation)| {
            observed_invocation_json(graph, sequence, invocation)
                .map_err(|error| CrossLanguageError::new(&error.code))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if canonicalize(&JsonValue::Array(normalized)) != canonicalize(&JsonValue::Array(expected)) {
        return Err(CrossLanguageError::new(
            "cross-language-node-effect-observation-mismatch",
        ));
    }
    let (code, program_stdout) = observed_process_status(&fields)?;
    Ok(observed_execution_digest(
        code,
        "process.status",
        program_stdout.as_bytes(),
        &observed_effect_projection_digest(graph, transcript)?,
    ))
}

fn observed_process_status<'a>(
    fields: &'a BTreeMap<String, &'a JsonValue>,
) -> Result<(u16, &'a str), CrossLanguageError> {
    let outcome = fields
        .get("outcome")
        .copied()
        .ok_or_else(|| CrossLanguageError::new("cross-language-observed-run-result-invalid"))?;
    let outcome_fields = exact_object(outcome, &["kind", "status"])?;
    if required_string(&outcome_fields, "kind")? != "process-status" {
        return Err(CrossLanguageError::new(
            "cross-language-observed-run-result-invalid",
        ));
    }
    let status = outcome_fields
        .get("status")
        .copied()
        .ok_or_else(|| CrossLanguageError::new("cross-language-observed-run-result-invalid"))?;
    let status_fields = exact_object(status, &["code"])?;
    let code = required_number(&status_fields, "code")?
        .parse::<u16>()
        .map_err(|_| CrossLanguageError::new("cross-language-observed-run-result-invalid"))?;
    let stdout = required_string(fields, "program_stdout")?;
    Ok((code, stdout))
}

pub fn observed_effect_projection_digest(
    graph: &crate::graph::Graph,
    transcript: &NativeReplayTranscript,
) -> Result<String, CrossLanguageError> {
    let invocations = transcript
        .invocations
        .iter()
        .enumerate()
        .map(|(sequence, invocation)| observed_invocation_json(graph, sequence, invocation))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CrossLanguageError::new(&error.code))?;
    Ok(digest_json(&JsonValue::Array(invocations)))
}

pub fn backend_result_digest(result: &CrossLanguageBackendResult) -> String {
    digest_json(&backend_result_json(result, false))
}

pub fn build_cross_language_matrix(
    workload_id: impl Into<String>,
    graph_revision: impl Into<String>,
    input_digest: impl Into<String>,
    transcript_digest: impl Into<String>,
    measured: Vec<CrossLanguageBackendResult>,
    pending: Vec<PendingBackend>,
) -> Result<CrossLanguageReplayMatrix, CrossLanguageError> {
    let matrix = CrossLanguageReplayMatrix {
        schema: CROSS_LANGUAGE_MATRIX_SCHEMA.to_owned(),
        workload_id: workload_id.into(),
        graph_revision: graph_revision.into(),
        input_digest: input_digest.into(),
        transcript_digest: transcript_digest.into(),
        measured,
        pending,
        status: "semantic-equivalent".to_owned(),
        equivalence_digest: String::new(),
        matrix_digest: String::new(),
    };
    validate_matrix_content(&matrix)?;
    let mut matrix = matrix;
    matrix.equivalence_digest = equivalence_digest(&matrix)?;
    matrix.matrix_digest = matrix_digest(&matrix)?;
    validate_cross_language_matrix(&matrix)?;
    Ok(matrix)
}

pub fn serialize_backend_result(
    result: &CrossLanguageBackendResult,
) -> Result<String, CrossLanguageError> {
    validate_backend_result(result)?;
    Ok(format!(
        "{}\n",
        canonicalize(&backend_result_json(result, true))
    ))
}

pub fn parse_backend_result(
    source: &str,
) -> Result<CrossLanguageBackendResult, CrossLanguageError> {
    let value = parse_json(source)
        .map_err(|_| CrossLanguageError::new("cross-language-backend-result-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "backend",
            "graph_revision",
            "input_digest",
            "invocations",
            "outcome_code",
            "outcome_type",
            "observed_result_digest",
            "receipt_digest",
            "result_digest",
            "schema",
            "semantic_digest",
            "status",
            "toolchain_digest",
            "transcript_digest",
        ],
    )?;
    let invocations = match entries.get("invocations") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_invocation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CrossLanguageError::new(
                "cross-language-backend-result-invocations-invalid",
            ));
        }
    };
    let result = CrossLanguageBackendResult {
        schema: required_string(&entries, "schema")?.to_owned(),
        backend: required_string(&entries, "backend")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        toolchain_digest: required_string(&entries, "toolchain_digest")?.to_owned(),
        observed_result_digest: required_string(&entries, "observed_result_digest")?.to_owned(),
        result_digest: required_string(&entries, "result_digest")?.to_owned(),
        receipt_digest: required_string(&entries, "receipt_digest")?.to_owned(),
        semantic_digest: required_string(&entries, "semantic_digest")?.to_owned(),
        outcome_code: required_number(&entries, "outcome_code")?
            .parse()
            .map_err(|_| {
                CrossLanguageError::new("cross-language-backend-result-outcome-invalid")
            })?,
        outcome_type: required_string(&entries, "outcome_type")?.to_owned(),
        invocations,
        status: required_string(&entries, "status")?.to_owned(),
    };
    validate_backend_result(&result)?;
    if serialize_backend_result(&result)?.as_str() != source {
        return Err(CrossLanguageError::new(
            "cross-language-backend-result-non-canonical-source",
        ));
    }
    Ok(result)
}

pub fn serialize_cross_language_matrix(
    matrix: &CrossLanguageReplayMatrix,
) -> Result<String, CrossLanguageError> {
    validate_cross_language_matrix(matrix)?;
    Ok(format!("{}\n", canonicalize(&matrix_json(matrix, true))))
}

pub fn parse_cross_language_matrix(
    source: &str,
) -> Result<CrossLanguageReplayMatrix, CrossLanguageError> {
    let value = parse_json(source)
        .map_err(|_| CrossLanguageError::new("cross-language-matrix-json-invalid"))?;
    let entries = exact_object(
        &value,
        &[
            "equivalence_digest",
            "graph_revision",
            "input_digest",
            "measured",
            "matrix_digest",
            "pending",
            "schema",
            "status",
            "transcript_digest",
            "workload_id",
        ],
    )?;
    let measured = match entries.get("measured") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(|value| {
                let source = format!("{}\n", canonicalize(value));
                parse_backend_result(&source)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CrossLanguageError::new(
                "cross-language-matrix-measured-invalid",
            ));
        }
    };
    let pending = match entries.get("pending") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_pending)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(CrossLanguageError::new(
                "cross-language-matrix-pending-invalid",
            ));
        }
    };
    let matrix = CrossLanguageReplayMatrix {
        schema: required_string(&entries, "schema")?.to_owned(),
        workload_id: required_string(&entries, "workload_id")?.to_owned(),
        graph_revision: required_string(&entries, "graph_revision")?.to_owned(),
        input_digest: required_string(&entries, "input_digest")?.to_owned(),
        transcript_digest: required_string(&entries, "transcript_digest")?.to_owned(),
        measured,
        pending,
        status: required_string(&entries, "status")?.to_owned(),
        equivalence_digest: required_string(&entries, "equivalence_digest")?.to_owned(),
        matrix_digest: required_string(&entries, "matrix_digest")?.to_owned(),
    };
    validate_cross_language_matrix(&matrix)?;
    if serialize_cross_language_matrix(&matrix)?.as_str() != source {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-non-canonical-source",
        ));
    }
    Ok(matrix)
}

pub fn validate_cross_language_matrix(
    matrix: &CrossLanguageReplayMatrix,
) -> Result<(), CrossLanguageError> {
    validate_matrix_content(matrix)?;
    if matrix.equivalence_digest != equivalence_digest(matrix)? {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-equivalence-digest-mismatch",
        ));
    }
    if matrix.matrix_digest != matrix_digest(matrix)? {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-digest-mismatch",
        ));
    }
    Ok(())
}

fn validate_matrix_content(matrix: &CrossLanguageReplayMatrix) -> Result<(), CrossLanguageError> {
    if matrix.schema != CROSS_LANGUAGE_MATRIX_SCHEMA {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-schema-mismatch",
        ));
    }
    if matrix.workload_id.is_empty()
        || !is_digest(&matrix.graph_revision)
        || !is_digest(&matrix.input_digest)
        || !is_digest(&matrix.transcript_digest)
    {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-authority-invalid",
        ));
    }
    if matrix.status != "semantic-equivalent" {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-status-invalid",
        ));
    }
    if matrix
        .measured
        .iter()
        .map(|result| result.backend.as_str())
        .collect::<Vec<_>>()
        != MEASURED_BACKENDS
        || matrix
            .pending
            .iter()
            .map(|backend| backend.backend.as_str())
            .collect::<Vec<_>>()
            != PENDING_BACKENDS
    {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-backend-partition-invalid",
        ));
    }
    for result in &matrix.measured {
        validate_backend_result(result)?;
        if result.graph_revision != matrix.graph_revision
            || result.input_digest != matrix.input_digest
            || result.transcript_digest != matrix.transcript_digest
        {
            return Err(CrossLanguageError::new(
                "cross-language-matrix-authority-mismatch",
            ));
        }
    }
    for pending in &matrix.pending {
        if pending.reason.is_empty() || !PENDING_BACKENDS.contains(&pending.backend.as_str()) {
            return Err(CrossLanguageError::new(
                "cross-language-matrix-pending-invalid",
            ));
        }
    }
    let semantic = matrix
        .measured
        .first()
        .map(|result| result.semantic_digest.as_str())
        .ok_or_else(|| CrossLanguageError::new("cross-language-matrix-measured-invalid"))?;
    if matrix
        .measured
        .iter()
        .any(|result| result.semantic_digest != semantic)
    {
        return Err(CrossLanguageError::new(
            "cross-language-matrix-semantic-mismatch",
        ));
    }
    Ok(())
}

fn validate_backend_result(result: &CrossLanguageBackendResult) -> Result<(), CrossLanguageError> {
    if result.schema != CROSS_LANGUAGE_BACKEND_RESULT_SCHEMA
        || result.status != "measured"
        || !MEASURED_BACKENDS.contains(&result.backend.as_str())
        || result.graph_revision.is_empty()
        || !is_digest(&result.graph_revision)
        || !is_digest(&result.input_digest)
        || !is_digest(&result.transcript_digest)
        || !is_digest(&result.toolchain_digest)
        || !is_digest(&result.observed_result_digest)
        || !is_digest(&result.result_digest)
        || !is_digest(&result.receipt_digest)
        || !is_digest(&result.semantic_digest)
        || result.outcome_type.is_empty()
        || result.semantic_digest
            != backend_semantic_digest(
                result.outcome_code,
                &result.outcome_type,
                &result.invocations,
                &result.observed_result_digest,
            )
        || result.result_digest != backend_result_digest(result)
    {
        return Err(CrossLanguageError::new(
            "cross-language-backend-result-authority-invalid",
        ));
    }
    let mut seen = BTreeSet::new();
    for invocation in &result.invocations {
        if invocation.instance.is_empty()
            || invocation.member.is_empty()
            || invocation.invocation_id.is_empty()
            || invocation.outcome.is_empty()
            || !seen.insert(invocation.invocation_id.clone())
        {
            return Err(CrossLanguageError::new(
                "cross-language-backend-result-invocation-invalid",
            ));
        }
    }
    Ok(())
}

fn equivalence_digest(matrix: &CrossLanguageReplayMatrix) -> Result<String, CrossLanguageError> {
    let semantic = matrix
        .measured
        .first()
        .map(|result| result.semantic_digest.clone())
        .ok_or_else(|| CrossLanguageError::new("cross-language-matrix-measured-invalid"))?;
    Ok(digest_json(&object(vec![
        (
            "graph_revision",
            JsonValue::String(matrix.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(matrix.input_digest.clone()),
        ),
        ("semantic_digest", JsonValue::String(semantic)),
        (
            "transcript_digest",
            JsonValue::String(matrix.transcript_digest.clone()),
        ),
    ])))
}

fn matrix_digest(matrix: &CrossLanguageReplayMatrix) -> Result<String, CrossLanguageError> {
    Ok(digest_json(&matrix_json(matrix, false)))
}

fn backend_result_json(result: &CrossLanguageBackendResult, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        ("backend", JsonValue::String(result.backend.clone())),
        (
            "graph_revision",
            JsonValue::String(result.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(result.input_digest.clone()),
        ),
        (
            "invocations",
            JsonValue::Array(result.invocations.iter().map(invocation_json).collect()),
        ),
        (
            "outcome_code",
            JsonValue::Number(result.outcome_code.to_string()),
        ),
        (
            "outcome_type",
            JsonValue::String(result.outcome_type.clone()),
        ),
        (
            "observed_result_digest",
            JsonValue::String(result.observed_result_digest.clone()),
        ),
        (
            "receipt_digest",
            JsonValue::String(result.receipt_digest.clone()),
        ),
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
            JsonValue::String(CROSS_LANGUAGE_BACKEND_RESULT_SCHEMA.to_owned()),
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
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn matrix_json(matrix: &CrossLanguageReplayMatrix, include_digest: bool) -> JsonValue {
    let mut fields = vec![
        (
            "equivalence_digest",
            JsonValue::String(matrix.equivalence_digest.clone()),
        ),
        (
            "graph_revision",
            JsonValue::String(matrix.graph_revision.clone()),
        ),
        (
            "input_digest",
            JsonValue::String(matrix.input_digest.clone()),
        ),
        (
            "measured",
            JsonValue::Array(
                matrix
                    .measured
                    .iter()
                    .map(|result| backend_result_json(result, true))
                    .collect(),
            ),
        ),
        (
            "matrix_digest",
            if include_digest {
                JsonValue::String(matrix.matrix_digest.clone())
            } else {
                JsonValue::Null
            },
        ),
        (
            "pending",
            JsonValue::Array(
                matrix
                    .pending
                    .iter()
                    .map(|backend| {
                        object(vec![
                            ("backend", JsonValue::String(backend.backend.clone())),
                            ("reason", JsonValue::String(backend.reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("schema", JsonValue::String(matrix.schema.clone())),
        ("status", JsonValue::String(matrix.status.clone())),
        (
            "transcript_digest",
            JsonValue::String(matrix.transcript_digest.clone()),
        ),
        ("workload_id", JsonValue::String(matrix.workload_id.clone())),
    ];
    if !include_digest {
        fields.retain(|(key, _)| *key != "matrix_digest");
    }
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn invocation_json(invocation: &CrossLanguageInvocation) -> JsonValue {
    object(vec![
        ("instance", JsonValue::String(invocation.instance.clone())),
        (
            "invocation_id",
            JsonValue::String(invocation.invocation_id.clone()),
        ),
        ("member", JsonValue::String(invocation.member.clone())),
        ("outcome", JsonValue::String(invocation.outcome.clone())),
    ])
}

fn parse_invocation(value: &JsonValue) -> Result<CrossLanguageInvocation, CrossLanguageError> {
    let entries = exact_object(value, &["instance", "invocation_id", "member", "outcome"])?;
    Ok(CrossLanguageInvocation::new(
        required_string(&entries, "instance")?,
        required_string(&entries, "member")?,
        required_string(&entries, "invocation_id")?,
        required_string(&entries, "outcome")?,
    ))
}

fn parse_pending(value: &JsonValue) -> Result<PendingBackend, CrossLanguageError> {
    let entries = exact_object(value, &["backend", "reason"])?;
    Ok(PendingBackend::new(
        required_string(&entries, "backend")?,
        required_string(&entries, "reason")?,
    ))
}

fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, CrossLanguageError> {
    let JsonValue::Object(entries) = value else {
        return Err(CrossLanguageError::new("cross-language-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(CrossLanguageError::new("cross-language-unexpected-field"));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(CrossLanguageError::new("cross-language-duplicate-field"));
        }
    }
    if result.len() != expected.len() {
        return Err(CrossLanguageError::new(
            "cross-language-required-field-missing",
        ));
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, CrossLanguageError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(CrossLanguageError::new("cross-language-field-invalid")),
    }
}

fn required_number<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, CrossLanguageError> {
    match entries.get(name) {
        Some(JsonValue::Number(value)) => Ok(value),
        _ => Err(CrossLanguageError::new("cross-language-field-invalid")),
    }
}

fn object(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    )
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
