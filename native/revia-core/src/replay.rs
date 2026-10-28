use std::collections::{BTreeMap, BTreeSet};

use crate::{
    canonical_json::{JsonValue, canonicalize},
    project::parse_json,
    vm::{CapabilityBridge, CapabilityResponse, VmValue, serialize_vm_value},
};

pub const NATIVE_REPLAY_SCHEMA: &str = "re.native-vm-replay@0.1.0";
const INVOCATION_MISMATCH: &str = "native-conformance-replay-invocation-mismatch";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayError {
    pub code: String,
}

impl ReplayError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeReplayInvocation {
    pub arguments: BTreeMap<String, VmValue>,
    pub instance: String,
    pub invocation_id: String,
    pub member: String,
    pub response: CapabilityResponse,
}

impl NativeReplayInvocation {
    pub fn new(
        instance: impl Into<String>,
        member: impl Into<String>,
        invocation_id: impl Into<String>,
        arguments: BTreeMap<String, VmValue>,
        response: CapabilityResponse,
    ) -> Self {
        Self {
            arguments,
            instance: instance.into(),
            invocation_id: invocation_id.into(),
            member: member.into(),
            response,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeReplayTranscript {
    pub invocations: Vec<NativeReplayInvocation>,
    pub schema: String,
}

impl NativeReplayTranscript {
    pub fn new(invocations: Vec<NativeReplayInvocation>) -> Self {
        Self {
            invocations,
            schema: NATIVE_REPLAY_SCHEMA.to_owned(),
        }
    }
}

pub fn parse_native_replay_transcript(source: &str) -> Result<NativeReplayTranscript, ReplayError> {
    let value = parse_json(source).map_err(|error| {
        if error.code == "duplicate-json-field" {
            ReplayError::new("native-replay-transcript-duplicate-field")
        } else {
            ReplayError::new("native-replay-transcript-json-invalid")
        }
    })?;
    let entries = exact_object(&value, &["invocations", "schema"])?;
    let schema = required_string(&entries, "schema")?.to_owned();
    let invocations = match entries.get("invocations") {
        Some(JsonValue::Array(values)) => values
            .iter()
            .map(parse_invocation)
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-invocations-invalid",
            ));
        }
    };
    let transcript = NativeReplayTranscript {
        invocations,
        schema,
    };
    validate_transcript(&transcript)?;
    if serialize_native_replay_transcript(&transcript)? != source {
        return Err(ReplayError::new(
            "native-replay-transcript-non-canonical-source",
        ));
    }
    Ok(transcript)
}

pub fn serialize_native_replay_transcript(
    transcript: &NativeReplayTranscript,
) -> Result<String, ReplayError> {
    validate_transcript(transcript)?;
    Ok(format!("{}\n", canonicalize(&transcript_json(transcript)?)))
}

pub struct ReplayBridge {
    transcript: NativeReplayTranscript,
    cursor: usize,
    failure: Option<String>,
    observed_failure: Option<CapabilityResponse>,
}

impl ReplayBridge {
    pub fn new(transcript: NativeReplayTranscript) -> Self {
        Self {
            transcript,
            cursor: 0,
            failure: None,
            observed_failure: None,
        }
    }

    pub fn failure_code(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    pub fn observed_failure(&self) -> Option<(&str, &str)> {
        match self.observed_failure.as_ref()? {
            CapabilityResponse::CheckFailure { code } => Some(("check-failure", code)),
            CapabilityResponse::HostFault { code } => Some(("host-fault", code)),
            CapabilityResponse::Value { .. } => None,
        }
    }

    pub fn finish(&self) -> Result<(), String> {
        if let Some(code) = &self.failure {
            return Err(code.clone());
        }
        if self.cursor != self.transcript.invocations.len() {
            return Err(INVOCATION_MISMATCH.to_owned());
        }
        Ok(())
    }

    fn invoke_expected(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        let Some(expected) = self.transcript.invocations.get(self.cursor) else {
            return self.mismatch();
        };
        if expected.instance != instance
            || expected.member != member
            || expected.invocation_id != invocation_id
            || expected.arguments != *arguments
        {
            return self.mismatch();
        }
        self.cursor += 1;
        let response = expected.response.clone();
        if matches!(
            response,
            CapabilityResponse::CheckFailure { .. } | CapabilityResponse::HostFault { .. }
        ) {
            self.observed_failure = Some(response.clone());
        }
        Ok(response)
    }

    fn mismatch(&mut self) -> Result<CapabilityResponse, String> {
        self.failure = Some(INVOCATION_MISMATCH.to_owned());
        Err(INVOCATION_MISMATCH.to_owned())
    }
}

impl CapabilityBridge for ReplayBridge {
    fn invoke(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
    ) -> Result<CapabilityResponse, String> {
        self.invoke_expected(instance, member, arguments, invocation_id)
    }

    fn invoke_with_input(
        &mut self,
        instance: &str,
        member: &str,
        arguments: &BTreeMap<String, VmValue>,
        invocation_id: &str,
        input: Option<&VmValue>,
    ) -> Result<CapabilityResponse, String> {
        if input.is_some() {
            return self.mismatch();
        }
        self.invoke_expected(instance, member, arguments, invocation_id)
    }
}

fn validate_transcript(transcript: &NativeReplayTranscript) -> Result<(), ReplayError> {
    if transcript.schema != NATIVE_REPLAY_SCHEMA {
        return Err(ReplayError::new("native-replay-transcript-schema-mismatch"));
    }
    for invocation in &transcript.invocations {
        if invocation.instance.is_empty()
            || invocation.member.is_empty()
            || invocation.invocation_id.is_empty()
        {
            return Err(ReplayError::new(
                "native-replay-transcript-invocation-invalid",
            ));
        }
        validate_response(&invocation.response)?;
    }
    Ok(())
}

fn validate_response(response: &CapabilityResponse) -> Result<(), ReplayError> {
    match response {
        CapabilityResponse::Value { variant, .. } if variant == "ok" || variant == "err" => Ok(()),
        CapabilityResponse::Value { .. } => Err(ReplayError::new(
            "native-replay-transcript-response-invalid",
        )),
        CapabilityResponse::CheckFailure { code } | CapabilityResponse::HostFault { code }
            if !code.is_empty() =>
        {
            Ok(())
        }
        CapabilityResponse::CheckFailure { .. } | CapabilityResponse::HostFault { .. } => Err(
            ReplayError::new("native-replay-transcript-response-invalid"),
        ),
    }
}

fn parse_invocation(value: &JsonValue) -> Result<NativeReplayInvocation, ReplayError> {
    let entries = exact_object(
        value,
        &[
            "arguments",
            "instance",
            "invocation_id",
            "member",
            "response",
        ],
    )?;
    let arguments = match entries.get("arguments") {
        Some(JsonValue::Object(values)) => {
            let mut arguments = BTreeMap::new();
            for (name, value) in values {
                if name.is_empty()
                    || arguments
                        .insert(name.clone(), parse_vm_value(value)?)
                        .is_some()
                {
                    return Err(ReplayError::new(
                        "native-replay-transcript-arguments-invalid",
                    ));
                }
            }
            arguments
        }
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-arguments-invalid",
            ));
        }
    };
    let response = parse_response(entries.get("response").copied())?;
    Ok(NativeReplayInvocation::new(
        required_string(&entries, "instance")?,
        required_string(&entries, "member")?,
        required_string(&entries, "invocation_id")?,
        arguments,
        response,
    ))
}

fn parse_response(value: Option<&JsonValue>) -> Result<CapabilityResponse, ReplayError> {
    let value =
        value.ok_or_else(|| ReplayError::new("native-replay-transcript-response-invalid"))?;
    let JsonValue::Object(entries) = value else {
        return Err(ReplayError::new(
            "native-replay-transcript-response-invalid",
        ));
    };
    let kind = match entries.iter().find(|(key, _)| key == "kind") {
        Some((_, JsonValue::String(value))) => value.as_str(),
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-response-invalid",
            ));
        }
    };
    let keys = match kind {
        "value" => ["kind", "payload", "variant"].as_slice(),
        "check_failure" | "host_fault" => ["code", "kind"].as_slice(),
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-response-invalid",
            ));
        }
    };
    let entries = exact_object(value, keys)?;
    match kind {
        "value" => {
            let variant = required_string(&entries, "variant")?.to_owned();
            let payload =
                parse_vm_value(entries.get("payload").copied().ok_or_else(|| {
                    ReplayError::new("native-replay-transcript-response-invalid")
                })?)?;
            Ok(CapabilityResponse::Value { variant, payload })
        }
        "check_failure" => Ok(CapabilityResponse::CheckFailure {
            code: required_string(&entries, "code")?.to_owned(),
        }),
        "host_fault" => Ok(CapabilityResponse::HostFault {
            code: required_string(&entries, "code")?.to_owned(),
        }),
        _ => Err(ReplayError::new(
            "native-replay-transcript-response-invalid",
        )),
    }
}

fn parse_vm_value(value: &JsonValue) -> Result<VmValue, ReplayError> {
    let JsonValue::Object(_) = value else {
        return Err(ReplayError::new(
            "native-replay-transcript-vm-value-invalid",
        ));
    };
    let entries = exact_object(value, &["type", "value"])?;
    let type_name = required_string(&entries, "type")?;
    let vm_value = match type_name {
        "unit" if matches!(entries.get("value"), Some(JsonValue::Null)) => VmValue::Unit,
        "bool" => match entries.get("value") {
            Some(JsonValue::Bool(value)) => VmValue::Bool(*value),
            _ => {
                return Err(ReplayError::new(
                    "native-replay-transcript-vm-value-invalid",
                ));
            }
        },
        "text.utf8" => VmValue::Text(required_string(&entries, "value")?.to_owned()),
        "bytes" => VmValue::Bytes(parse_bytes(entries.get("value").copied())?),
        "int" => VmValue::Int(parse_int(entries.get("value").copied())?),
        "list" => {
            let Some(JsonValue::Array(values)) = entries.get("value") else {
                return Err(ReplayError::new(
                    "native-replay-transcript-vm-value-invalid",
                ));
            };
            VmValue::List(
                values
                    .iter()
                    .map(parse_vm_value)
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        "record" => {
            let Some(JsonValue::Object(values)) = entries.get("value") else {
                return Err(ReplayError::new(
                    "native-replay-transcript-vm-value-invalid",
                ));
            };
            let mut fields = BTreeMap::new();
            for (name, value) in values {
                if fields
                    .insert(name.clone(), parse_vm_value(value)?)
                    .is_some()
                {
                    return Err(ReplayError::new(
                        "native-replay-transcript-vm-value-invalid",
                    ));
                }
            }
            VmValue::Record(fields)
        }
        "result.ok" => VmValue::ResultOk(Box::new(parse_vm_value(
            entries
                .get("value")
                .copied()
                .ok_or_else(|| ReplayError::new("native-replay-transcript-vm-value-invalid"))?,
        )?)),
        "result.err" => VmValue::ResultErr {
            type_name: type_name.to_owned(),
            variant: required_string(&entries, "value")?.to_owned(),
        },
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-vm-value-invalid",
            ));
        }
    };
    if serialize_vm_value(&vm_value) != canonicalize(value) {
        return Err(ReplayError::new(
            "native-replay-transcript-vm-value-non-canonical",
        ));
    }
    Ok(vm_value)
}

fn parse_bytes(value: Option<&JsonValue>) -> Result<Vec<u8>, ReplayError> {
    let value = match value {
        Some(JsonValue::String(value)) => value,
        _ => {
            return Err(ReplayError::new(
                "native-replay-transcript-vm-value-invalid",
            ));
        }
    };
    let hex = value
        .strip_prefix("hex:")
        .ok_or_else(|| ReplayError::new("native-replay-transcript-vm-value-invalid"))?;
    if hex.len() % 2 != 0
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ReplayError::new(
            "native-replay-transcript-vm-value-invalid",
        ));
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| ReplayError::new("native-replay-transcript-vm-value-invalid"))
        })
        .collect()
}

fn parse_int(value: Option<&JsonValue>) -> Result<i64, ReplayError> {
    let Some(JsonValue::Number(value)) = value else {
        return Err(ReplayError::new(
            "native-replay-transcript-vm-value-invalid",
        ));
    };
    value
        .parse()
        .map_err(|_| ReplayError::new("native-replay-transcript-vm-value-invalid"))
}

fn transcript_json(transcript: &NativeReplayTranscript) -> Result<JsonValue, ReplayError> {
    Ok(object(vec![
        (
            "invocations",
            JsonValue::Array(
                transcript
                    .invocations
                    .iter()
                    .map(invocation_json)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        ("schema", JsonValue::String(transcript.schema.clone())),
    ]))
}

fn invocation_json(invocation: &NativeReplayInvocation) -> Result<JsonValue, ReplayError> {
    Ok(object(vec![
        (
            "arguments",
            JsonValue::Object(
                invocation
                    .arguments
                    .iter()
                    .map(|(name, value)| (name.clone(), parse_json(&serialize_vm_value(value))))
                    .map(|(name, value)| {
                        value.map(|value| (name, value)).map_err(|_| {
                            ReplayError::new("native-replay-transcript-vm-value-invalid")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        ("instance", JsonValue::String(invocation.instance.clone())),
        (
            "invocation_id",
            JsonValue::String(invocation.invocation_id.clone()),
        ),
        ("member", JsonValue::String(invocation.member.clone())),
        ("response", response_json(&invocation.response)?),
    ]))
}

fn response_json(response: &CapabilityResponse) -> Result<JsonValue, ReplayError> {
    match response {
        CapabilityResponse::Value { variant, payload } => Ok(object(vec![
            ("kind", JsonValue::String("value".to_owned())),
            (
                "payload",
                parse_json(&serialize_vm_value(payload))
                    .map_err(|_| ReplayError::new("native-replay-transcript-vm-value-invalid"))?,
            ),
            ("variant", JsonValue::String(variant.clone())),
        ])),
        CapabilityResponse::CheckFailure { code } => Ok(object(vec![
            ("code", JsonValue::String(code.clone())),
            ("kind", JsonValue::String("check_failure".to_owned())),
        ])),
        CapabilityResponse::HostFault { code } => Ok(object(vec![
            ("code", JsonValue::String(code.clone())),
            ("kind", JsonValue::String("host_fault".to_owned())),
        ])),
    }
}

fn exact_object<'a>(
    value: &'a JsonValue,
    expected: &[&str],
) -> Result<BTreeMap<String, &'a JsonValue>, ReplayError> {
    let JsonValue::Object(entries) = value else {
        return Err(ReplayError::new("native-replay-transcript-object-invalid"));
    };
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    let mut result = BTreeMap::new();
    for (key, value) in entries {
        if !expected.contains(key.as_str()) {
            return Err(ReplayError::new(
                "native-replay-transcript-unexpected-field",
            ));
        }
        if result.insert(key.clone(), value).is_some() {
            return Err(ReplayError::new("native-replay-transcript-duplicate-field"));
        }
    }
    Ok(result)
}

fn required_string<'a>(
    entries: &BTreeMap<String, &'a JsonValue>,
    name: &str,
) -> Result<&'a str, ReplayError> {
    match entries.get(name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(ReplayError::new("native-replay-transcript-field-invalid")),
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
