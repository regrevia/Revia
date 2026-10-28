use std::collections::BTreeMap;

use crate::{
    bytecode::{
        BytecodeArtifact, BytecodeInstruction, load_bytecode_artifact, verify_bytecode_artifact,
    },
    canonical_json::{JsonValue, canonicalize, quote},
    digest::sha256_hex,
    graph::{Graph, GraphError, graph_revision},
};

pub const NATIVE_VM_RESULT_SCHEMA: &str = "re.native-vm-result@0.1.0";
pub const NATIVE_VM_RECEIPT_SCHEMA: &str = "re.native-vm-receipt@0.1.0";
pub const NATIVE_VM_EXECUTOR: &str = "re.native-vm@0.1.0";
pub const NATIVE_VM_PROFILE: &str = "re.native-vm@0.1.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VmValue {
    Unit,
    Bool(bool),
    Text(String),
    Bytes(Vec<u8>),
    Int(i64),
    List(Vec<VmValue>),
    Record(BTreeMap<String, VmValue>),
    ResultOk(Box<VmValue>),
    ResultErr { type_name: String, variant: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityResponse {
    Value { variant: String, payload: VmValue },
    CheckFailure { code: String },
    HostFault { code: String },
}

impl CapabilityResponse {
    pub fn ok(payload: VmValue) -> Self {
        Self::Value {
            variant: "ok".to_owned(),
            payload,
        }
    }

    pub fn err(payload: VmValue) -> Self {
        Self::Value {
            variant: "err".to_owned(),
            payload,
        }
    }

    pub fn host_fault(code: impl Into<String>) -> Self {
        Self::HostFault { code: code.into() }
    }

    pub fn check_failure(code: impl Into<String>) -> Self {
        Self::CheckFailure { code: code.into() }
    }
}

pub trait CapabilityBridge {
    fn verify_authority(&self, _graph_revision: &str, _input_digest: &str) -> Result<(), String> {
        Ok(())
    }

    fn invoke(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
    ) -> Result<CapabilityResponse, String>;

    fn invoke_with_input(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
        input: Option<&VmValue>,
    ) -> Result<CapabilityResponse, String> {
        if input.is_some() {
            return Err("native-vm-input-handoff-unsupported".to_owned());
        }
        self.invoke(instance, member, arguments, invocation_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmLimits {
    pub max_steps: usize,
    pub max_allocations: usize,
    pub max_trace_entries: usize,
}

impl Default for VmLimits {
    fn default() -> Self {
        Self {
            max_steps: 64,
            max_allocations: 128,
            max_trace_entries: 64,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmRequest {
    pub schema: String,
    pub graph_revision: String,
    pub artifact_digest: String,
    pub profile: String,
    pub input_digest: String,
}

impl VmRequest {
    pub fn new(
        graph_revision: impl Into<String>,
        artifact_digest: impl Into<String>,
        profile: impl Into<String>,
        input_digest: impl Into<String>,
    ) -> Self {
        Self {
            schema: "re.native-vm-request@0.1.0".to_owned(),
            graph_revision: graph_revision.into(),
            artifact_digest: artifact_digest.into(),
            profile: profile.into(),
            input_digest: input_digest.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmInvocation {
    pub instance: String,
    pub member: String,
    pub invocation_id: String,
    pub outcome: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmTraceEntry {
    pub pc: usize,
    pub operation: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmOutcome {
    pub code: u8,
    pub type_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmReceipt {
    pub schema: String,
    pub executor: String,
    pub profile: String,
    pub graph_revision: String,
    pub artifact_digest: String,
    pub input_digest: String,
    pub invocations: Vec<VmInvocation>,
    pub outcome: VmOutcome,
    pub trace: Vec<VmTraceEntry>,
    pub receipt_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmResult {
    pub schema: String,
    pub executor: String,
    pub profile: String,
    pub graph_revision: String,
    pub artifact_digest: String,
    pub input_digest: String,
    pub invocations: Vec<VmInvocation>,
    pub outcome: VmOutcome,
    pub trace: Vec<VmTraceEntry>,
    pub receipt: VmReceipt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmExecution {
    pub result: VmResult,
    pub returned_value: VmValue,
}

pub fn execute_bytecode(
    checked_graph: &Graph,
    artifact_source: &str,
    request: &VmRequest,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<VmResult, GraphError> {
    execute_bytecode_with_return_value(checked_graph, artifact_source, request, bridge, limits)
        .map(|execution| execution.result)
}

pub fn execute_bytecode_with_return_value(
    checked_graph: &Graph,
    artifact_source: &str,
    request: &VmRequest,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
) -> Result<VmExecution, GraphError> {
    let artifact = load_bytecode_artifact(artifact_source)?;
    let verified = verify_bytecode_artifact(checked_graph, artifact_source)?;
    validate_request(checked_graph, &verified, request)?;
    bridge
        .verify_authority(&request.graph_revision, &request.input_digest)
        .map_err(|_| GraphError::new("native-vm-capability-authority-mismatch"))?;
    execute_verified(checked_graph, &artifact, request, bridge, limits, None)
}

pub fn execute_bytecode_with_input_value(
    checked_graph: &Graph,
    artifact_source: &str,
    request: &VmRequest,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
    input: &VmValue,
) -> Result<VmExecution, GraphError> {
    let artifact = load_bytecode_artifact(artifact_source)?;
    let verified = verify_bytecode_artifact(checked_graph, artifact_source)?;
    validate_request(checked_graph, &verified, request)?;
    bridge
        .verify_authority(&request.graph_revision, &request.input_digest)
        .map_err(|_| GraphError::new("native-vm-capability-authority-mismatch"))?;
    execute_verified(
        checked_graph,
        &artifact,
        request,
        bridge,
        limits,
        Some(input),
    )
}

fn validate_request(
    graph: &Graph,
    artifact: &BytecodeArtifact,
    request: &VmRequest,
) -> Result<(), GraphError> {
    if request.schema != "re.native-vm-request@0.1.0" {
        return Err(GraphError::new("native-vm-request-schema-mismatch"));
    }
    let revision = graph_revision(graph)?;
    if request.graph_revision != revision {
        return Err(GraphError::new("native-vm-request-graph-mismatch"));
    }
    if artifact.graph_revision != request.graph_revision {
        return Err(GraphError::new("native-vm-request-graph-mismatch"));
    }
    if request.artifact_digest != artifact.artifact_digest {
        return Err(GraphError::new("native-vm-request-artifact-mismatch"));
    }
    if request.profile != artifact.profile {
        return Err(GraphError::new("native-vm-request-profile-mismatch"));
    }
    if !valid_digest(&request.input_digest) {
        return Err(GraphError::new("native-vm-request-input-digest-invalid"));
    }
    Ok(())
}

fn execute_verified(
    _checked_graph: &Graph,
    artifact: &BytecodeArtifact,
    request: &VmRequest,
    bridge: &mut dyn CapabilityBridge,
    limits: VmLimits,
    input: Option<&VmValue>,
) -> Result<VmExecution, GraphError> {
    if limits.max_steps == 0 {
        return Err(GraphError::new("native-vm-step-limit-invalid"));
    }
    let mut registers = BTreeMap::<u16, CapabilityResponse>::new();
    let mut invocations = Vec::new();
    let mut trace = Vec::new();
    let mut pc = 0usize;
    let mut steps = 0usize;
    let mut allocations = 0usize;
    let mut returned_value = None;

    loop {
        if steps >= limits.max_steps {
            return Err(GraphError::new("native-vm-step-limit-exceeded"));
        }
        let instruction = artifact
            .instructions
            .get(pc)
            .ok_or_else(|| GraphError::new("native-vm-termination-missing"))?;
        if trace.len() >= limits.max_trace_entries {
            return Err(GraphError::new("native-vm-trace-limit-exceeded"));
        }
        trace.push(VmTraceEntry {
            pc,
            operation: instruction_name(instruction).to_owned(),
        });
        steps += 1;

        match instruction {
            BytecodeInstruction::InvokeCapability {
                destination,
                instance,
                member,
                invocation_id,
                arguments,
            } => {
                let mut values = BTreeMap::new();
                for argument in arguments {
                    let literal = artifact
                        .literals
                        .get(argument.literal)
                        .ok_or_else(|| GraphError::new("native-vm-literal-missing"))?;
                    let value = literal_value(literal)?;
                    allocations = allocations.saturating_add(value_allocations(&value));
                    if allocations > limits.max_allocations {
                        return Err(GraphError::new("native-vm-allocation-limit-exceeded"));
                    }
                    if values.insert(argument.name.clone(), value).is_some() {
                        return Err(GraphError::new("native-vm-argument-duplicate"));
                    }
                }
                let response = bridge
                    .invoke_with_input(instance, member, &values, invocation_id, input)
                    .map_err(|_| GraphError::new("native-vm-capability-fault"))?;
                validate_capability_response(&response)?;
                if let CapabilityResponse::Value { payload, .. } = &response {
                    returned_value = Some(payload.clone());
                }
                invocations.push(VmInvocation {
                    instance: instance.clone(),
                    member: member.clone(),
                    invocation_id: invocation_id.clone(),
                    outcome: response_outcome(&response),
                });
                registers.insert(*destination, response);
                pc = pc
                    .checked_add(1)
                    .ok_or_else(|| GraphError::new("native-vm-program-counter-overflow"))?;
            }
            BytecodeInstruction::BranchResult { source, ok, err } => {
                let response = registers
                    .get(source)
                    .ok_or_else(|| GraphError::new("native-vm-register-missing"))?;
                match response {
                    CapabilityResponse::Value { variant, .. } if variant == "ok" => {
                        pc = *ok;
                    }
                    CapabilityResponse::Value { variant, .. } if variant == "err" => {
                        pc = *err;
                    }
                    CapabilityResponse::Value { .. } => {
                        return Err(GraphError::new("native-vm-result-invalid"));
                    }
                    CapabilityResponse::CheckFailure { .. }
                    | CapabilityResponse::HostFault { .. } => {
                        return Err(GraphError::new("native-vm-capability-failed"));
                    }
                }
                if pc >= artifact.instructions.len() {
                    return Err(GraphError::new("native-vm-jump-invalid"));
                }
            }
            BytecodeInstruction::ReturnStatus { code_literal } => {
                let literal = artifact
                    .literals
                    .get(*code_literal)
                    .ok_or_else(|| GraphError::new("native-vm-literal-missing"))?;
                let code = process_status_value(&literal_value(literal)?)?;
                let outcome = VmOutcome {
                    code,
                    type_name: "process.status".to_owned(),
                };
                let receipt = build_receipt(artifact, request, &invocations, &outcome, &trace);
                return Ok(VmExecution {
                    result: VmResult {
                        schema: NATIVE_VM_RESULT_SCHEMA.to_owned(),
                        executor: NATIVE_VM_EXECUTOR.to_owned(),
                        profile: NATIVE_VM_PROFILE.to_owned(),
                        graph_revision: artifact.graph_revision.clone(),
                        artifact_digest: artifact.artifact_digest.clone(),
                        input_digest: request.input_digest.clone(),
                        invocations,
                        outcome,
                        trace,
                        receipt,
                    },
                    returned_value: returned_value
                        .ok_or_else(|| GraphError::new("native-vm-return-value-missing"))?,
                });
            }
        }
    }
}

pub fn vm_value_type_name(value: &VmValue) -> String {
    match value {
        VmValue::Unit => "unit".to_owned(),
        VmValue::Bool(_) => "bool".to_owned(),
        VmValue::Text(_) => "text.utf8".to_owned(),
        VmValue::Bytes(_) => "bytes".to_owned(),
        VmValue::Int(_) => "int".to_owned(),
        VmValue::List(_) => "list".to_owned(),
        VmValue::Record(_) => "record".to_owned(),
        VmValue::ResultOk(_) => "result.ok".to_owned(),
        VmValue::ResultErr { type_name, .. } => type_name.clone(),
    }
}

pub fn serialize_vm_value(value: &VmValue) -> String {
    canonicalize(&vm_value_json(value))
}

pub fn vm_value_digest(value: &VmValue) -> String {
    format!(
        "sha256:{}",
        sha256_hex(serialize_vm_value(value).as_bytes())
    )
}

fn vm_value_json(value: &VmValue) -> JsonValue {
    match value {
        VmValue::Unit => object(vec![
            ("type", JsonValue::String("unit".to_owned())),
            ("value", JsonValue::Null),
        ]),
        VmValue::Bool(value) => object(vec![
            ("type", JsonValue::String("bool".to_owned())),
            ("value", JsonValue::Bool(*value)),
        ]),
        VmValue::Text(value) => object(vec![
            ("type", JsonValue::String("text.utf8".to_owned())),
            ("value", JsonValue::String(value.clone())),
        ]),
        VmValue::Bytes(value) => object(vec![
            ("type", JsonValue::String("bytes".to_owned())),
            (
                "value",
                JsonValue::String(format!(
                    "hex:{}",
                    value
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                )),
            ),
        ]),
        VmValue::Int(value) => object(vec![
            ("type", JsonValue::String("int".to_owned())),
            ("value", JsonValue::Number(value.to_string())),
        ]),
        VmValue::List(values) => object(vec![
            ("type", JsonValue::String("list".to_owned())),
            (
                "value",
                JsonValue::Array(values.iter().map(vm_value_json).collect()),
            ),
        ]),
        VmValue::Record(fields) => object(vec![
            ("type", JsonValue::String("record".to_owned())),
            (
                "value",
                JsonValue::Object(
                    fields
                        .iter()
                        .map(|(name, value)| (name.clone(), vm_value_json(value)))
                        .collect(),
                ),
            ),
        ]),
        VmValue::ResultOk(value) => object(vec![
            ("type", JsonValue::String("result.ok".to_owned())),
            ("value", vm_value_json(value)),
        ]),
        VmValue::ResultErr { type_name, variant } => object(vec![
            ("type", JsonValue::String(type_name.clone())),
            ("value", JsonValue::String(variant.clone())),
        ]),
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

fn build_receipt(
    artifact: &BytecodeArtifact,
    request: &VmRequest,
    invocations: &[VmInvocation],
    outcome: &VmOutcome,
    trace: &[VmTraceEntry],
) -> VmReceipt {
    let mut receipt = VmReceipt {
        schema: NATIVE_VM_RECEIPT_SCHEMA.to_owned(),
        executor: NATIVE_VM_EXECUTOR.to_owned(),
        profile: NATIVE_VM_PROFILE.to_owned(),
        graph_revision: artifact.graph_revision.clone(),
        artifact_digest: artifact.artifact_digest.clone(),
        input_digest: request.input_digest.clone(),
        invocations: invocations.to_vec(),
        outcome: outcome.clone(),
        trace: trace.to_vec(),
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = format!(
        "sha256:{}",
        sha256_hex(serialize_receipt_without_digest(&receipt).as_bytes())
    );
    receipt
}

fn serialize_receipt_without_digest(receipt: &VmReceipt) -> String {
    let invocations = receipt
        .invocations
        .iter()
        .map(|invocation| {
            format!(
                "{}|{}|{}|{}",
                quote(&invocation.instance),
                quote(&invocation.member),
                quote(&invocation.invocation_id),
                quote(&invocation.outcome)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let trace = receipt
        .trace
        .iter()
        .map(|entry| format!("{}:{}", entry.pc, quote(&entry.operation)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "schema={};executor={};profile={};graph_revision={};artifact_digest={};input_digest={};outcome={}:{};invocations=[{}];trace=[{}]\n",
        receipt.schema,
        receipt.executor,
        receipt.profile,
        receipt.graph_revision,
        receipt.artifact_digest,
        receipt.input_digest,
        receipt.outcome.code,
        receipt.outcome.type_name,
        invocations,
        trace
    )
}

fn literal_value(literal: &crate::bytecode::BytecodeLiteral) -> Result<VmValue, GraphError> {
    match literal.type_name.as_str() {
        "text.utf8" | "fs.path" | "text.encoding" => Ok(VmValue::Text(literal.value.clone())),
        "int" => literal
            .value
            .parse::<i64>()
            .map(VmValue::Int)
            .map_err(|_| GraphError::new("native-vm-integer-invalid")),
        "bytes" => {
            let hex = literal
                .value
                .strip_prefix("hex:")
                .ok_or_else(|| GraphError::new("native-vm-bytes-invalid"))?;
            let mut bytes = Vec::with_capacity(hex.len() / 2);
            for pair in hex.as_bytes().chunks_exact(2) {
                let text = std::str::from_utf8(pair)
                    .map_err(|_| GraphError::new("native-vm-bytes-invalid"))?;
                bytes.push(
                    u8::from_str_radix(text, 16)
                        .map_err(|_| GraphError::new("native-vm-bytes-invalid"))?,
                );
            }
            Ok(VmValue::Bytes(bytes))
        }
        _ => Err(GraphError::new("native-vm-literal-type-invalid")),
    }
}

fn process_status_value(value: &VmValue) -> Result<u8, GraphError> {
    let VmValue::Int(value) = value else {
        return Err(GraphError::new("native-vm-process-status-invalid"));
    };
    (*value)
        .try_into()
        .map_err(|_| GraphError::new("native-vm-process-status-invalid"))
}

fn validate_capability_response(response: &CapabilityResponse) -> Result<(), GraphError> {
    match response {
        CapabilityResponse::Value { variant, .. } if variant == "ok" || variant == "err" => Ok(()),
        CapabilityResponse::Value { .. } => {
            Err(GraphError::new("native-vm-capability-outcome-invalid"))
        }
        CapabilityResponse::CheckFailure { code } | CapabilityResponse::HostFault { code }
            if !code.is_empty() =>
        {
            Ok(())
        }
        CapabilityResponse::CheckFailure { .. } | CapabilityResponse::HostFault { .. } => {
            Err(GraphError::new("native-vm-capability-outcome-invalid"))
        }
    }
}

fn response_outcome(response: &CapabilityResponse) -> String {
    match response {
        CapabilityResponse::Value { variant, .. } => variant.clone(),
        CapabilityResponse::CheckFailure { .. } => "check-failure".to_owned(),
        CapabilityResponse::HostFault { .. } => "host-fault".to_owned(),
    }
}

fn value_allocations(value: &VmValue) -> usize {
    match value {
        VmValue::Unit
        | VmValue::Bool(_)
        | VmValue::Text(_)
        | VmValue::Bytes(_)
        | VmValue::Int(_) => 1,
        VmValue::List(values) => 1 + values.iter().map(value_allocations).sum::<usize>(),
        VmValue::Record(values) => 1 + values.values().map(value_allocations).sum::<usize>(),
        VmValue::ResultOk(value) => 1 + value_allocations(value),
        VmValue::ResultErr { .. } => 1,
    }
}

fn instruction_name(instruction: &BytecodeInstruction) -> &'static str {
    match instruction {
        BytecodeInstruction::InvokeCapability { .. } => "invoke-capability",
        BytecodeInstruction::BranchResult { .. } => "branch-result",
        BytecodeInstruction::ReturnStatus { .. } => "return-status",
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
