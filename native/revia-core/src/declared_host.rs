//! Production execution for declared capabilities: registry, policy, adapter.
//!
//! A schema registry only *declares* a member's shape. It never authorizes a
//! call and never implements one. This module adds the two missing layers for
//! the members this toolchain actually implements:
//!
//! 1. [`CapabilityPolicy`] — a `revia.capability-policy@0.1.0` artifact that
//!    names the declared members a run is allowed to invoke. Parsing is strict:
//!    an unknown field, a duplicate grant, or a member this toolchain does not
//!    serve is refused instead of ignored.
//! 2. [`DeclaredCapabilityHost`] — a host adapter wrapping a real host
//!    (`SystemHost`/`MemoryHost`). It answers `HostOperation::Declared` only for
//!    a member that is both implemented here and granted by the policy, and
//!    delegates every other operation to the wrapped host unchanged.
//!
//! `SystemHost` and `MemoryHost` keep refusing `HostOperation::Declared`, so
//! the boundary they pin (WP-351/WP-352/WP-354) is untouched: without this
//! adapter a declared call still fails closed at the host boundary.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
    time::Instant,
};

use crate::{
    canonical_json::{JsonValue, quote},
    graph::{DeclaredSchema, Graph},
    minimal_std::{HostAdapter, HostOperation, HostOutcome, HostRequest, StdError},
    project::parse_json,
};

/// Schema of the policy artifact this module parses.
pub const CAPABILITY_POLICY_SCHEMA: &str = "revia.capability-policy@0.1.0";
/// The policy artifact is malformed, duplicated, or names an unknown field.
pub const CAPABILITY_POLICY_INVALID: &str = "native-capability-policy-invalid";
/// The policy text begins with a UTF-8 byte-order mark, which is not JSON.
pub const BYTE_ORDER_MARK_NOT_ALLOWED: &str = "byte-order-mark-not-allowed";
/// A graph names declared capabilities but the run supplied no policy.
pub const CAPABILITY_POLICY_MISSING: &str = "native-host-capability-policy-missing";
/// The policy grants a member this toolchain does not implement.
pub const CAPABILITY_POLICY_NOT_SERVED: &str = "native-host-capability-policy-not-served";

/// Largest text a served member will produce. A member that would exceed it
/// reports its own declared error variant instead of truncating.
pub const MAX_DECLARED_TEXT_BYTES: usize = 65_536;

const POLICY_FIELDS: [&str; 2] = ["grants", "schema"];
const GRANT_FIELDS: [&str; 2] = ["members", "reference"];

/// The declared members a run is authorized to invoke.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityPolicy {
    grants: BTreeMap<String, BTreeSet<String>>,
}

impl CapabilityPolicy {
    /// A policy that grants nothing. It is valid and refuses every call.
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// Parses a `revia.capability-policy@0.1.0` artifact.
    pub fn parse(source: &str) -> Result<Self, String> {
        if source.starts_with('\u{feff}') {
            return Err(BYTE_ORDER_MARK_NOT_ALLOWED.to_owned());
        }
        let value =
            parse_json(source).map_err(|_| format!("{CAPABILITY_POLICY_INVALID}:not-json"))?;
        let JsonValue::Object(entries) = value else {
            return Err(format!("{CAPABILITY_POLICY_INVALID}:not-an-object"));
        };
        let mut schema = None;
        let mut grants = None;
        let mut seen = BTreeSet::new();
        for (name, field) in entries {
            if !seen.insert(name.clone()) {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:duplicate-field:{name}"
                ));
            }
            match name.as_str() {
                "schema" => schema = Some(field),
                "grants" => grants = Some(field),
                other => {
                    return Err(format!("{CAPABILITY_POLICY_INVALID}:unknown-field:{other}"));
                }
            }
        }
        for expected in POLICY_FIELDS {
            if !seen.contains(expected) {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:missing-field:{expected}"
                ));
            }
        }
        match schema {
            Some(JsonValue::String(value)) if value == CAPABILITY_POLICY_SCHEMA => {}
            Some(JsonValue::String(value)) => {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:schema-unsupported:{value}"
                ));
            }
            Some(_) => return Err(format!("{CAPABILITY_POLICY_INVALID}:schema-not-text")),
            None => return Err(format!("{CAPABILITY_POLICY_INVALID}:missing-field:schema")),
        }
        let Some(JsonValue::Array(items)) = grants else {
            return Err(format!("{CAPABILITY_POLICY_INVALID}:grants-not-an-array"));
        };
        let mut table = BTreeMap::<String, BTreeSet<String>>::new();
        for item in items {
            let JsonValue::Object(fields) = item else {
                return Err(format!("{CAPABILITY_POLICY_INVALID}:grant-not-an-object"));
            };
            let mut reference = None;
            let mut members = None;
            let mut seen = BTreeSet::new();
            for (name, field) in fields {
                if !seen.insert(name.clone()) {
                    return Err(format!(
                        "{CAPABILITY_POLICY_INVALID}:duplicate-field:{name}"
                    ));
                }
                match name.as_str() {
                    "reference" => reference = Some(field),
                    "members" => members = Some(field),
                    other => {
                        return Err(format!(
                            "{CAPABILITY_POLICY_INVALID}:unknown-grant-field:{other}"
                        ));
                    }
                }
            }
            for expected in GRANT_FIELDS {
                if !seen.contains(expected) {
                    return Err(format!(
                        "{CAPABILITY_POLICY_INVALID}:missing-grant-field:{expected}"
                    ));
                }
            }
            let Some(JsonValue::String(reference)) = reference else {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:grant-reference-not-text"
                ));
            };
            if reference.is_empty() {
                return Err(format!("{CAPABILITY_POLICY_INVALID}:grant-reference-empty"));
            }
            let Some(JsonValue::Array(items)) = members else {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:grant-members-not-an-array"
                ));
            };
            if items.is_empty() {
                return Err(format!(
                    "{CAPABILITY_POLICY_INVALID}:grant-members-empty:{reference}"
                ));
            }
            let entry = table.entry(reference.clone()).or_default();
            for item in items {
                let JsonValue::String(member) = item else {
                    return Err(format!(
                        "{CAPABILITY_POLICY_INVALID}:grant-member-not-text:{reference}"
                    ));
                };
                if member.is_empty() {
                    return Err(format!(
                        "{CAPABILITY_POLICY_INVALID}:grant-member-empty:{reference}"
                    ));
                }
                if !entry.insert(member.clone()) {
                    return Err(format!(
                        "{CAPABILITY_POLICY_INVALID}:grant-member-duplicate:{reference}.{member}"
                    ));
                }
            }
        }
        Ok(Self { grants: table })
    }

    /// Whether the policy authorizes `reference.member`.
    pub fn is_granted(&self, reference: &str, member: &str) -> bool {
        self.grants
            .get(reference)
            .is_some_and(|members| members.contains(member))
    }

    /// The grants as declared, sorted bytewise.
    pub fn grants(&self) -> &BTreeMap<String, BTreeSet<String>> {
        &self.grants
    }

    /// Renders the artifact back to canonical JSON. Only grants are written, so
    /// a policy round-trips through [`Self::parse`] unchanged.
    pub fn render(&self) -> String {
        let grants = self
            .grants
            .iter()
            .map(|(reference, members)| {
                format!(
                    "{{\"members\":[{}],\"reference\":{}}}",
                    members
                        .iter()
                        .map(|member| quote(member))
                        .collect::<Vec<_>>()
                        .join(","),
                    quote(reference)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"grants\":[{grants}],\"schema\":{}}}",
            quote(CAPABILITY_POLICY_SCHEMA)
        )
    }
}

/// The members this toolchain implements behind the host boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProductionMember {
    /// `revia.strings@0.1.0.concat(left: text.utf8, right: text.utf8) -> text.utf8`
    TextConcat,
    /// `revia.strings@0.1.0.scalar_count(value: text.utf8) -> number.i64`
    TextScalarCount,
    /// `revia.clock@0.1.0.monotonic_nanos() -> number.i64`
    ClockMonotonicNanos,
}

impl ProductionMember {
    /// Looks a member up in the production table.
    pub fn lookup(reference: &str, member: &str) -> Option<Self> {
        match (reference, member) {
            ("revia.strings@0.1.0", "concat") => Some(Self::TextConcat),
            ("revia.strings@0.1.0", "scalar_count") => Some(Self::TextScalarCount),
            ("revia.clock@0.1.0", "monotonic_nanos") => Some(Self::ClockMonotonicNanos),
            _ => None,
        }
    }

    /// The operation name recorded in observations for this member.
    pub fn operation_name(self) -> &'static str {
        match self {
            Self::TextConcat => "declared:revia.strings@0.1.0.concat",
            Self::TextScalarCount => "declared:revia.strings@0.1.0.scalar_count",
            Self::ClockMonotonicNanos => "declared:revia.clock@0.1.0.monotonic_nanos",
        }
    }
}

/// Every member this toolchain implements, sorted.
pub fn served_members() -> [(&'static str, &'static str); 3] {
    [
        ("revia.clock@0.1.0", "monotonic_nanos"),
        ("revia.strings@0.1.0", "concat"),
        ("revia.strings@0.1.0", "scalar_count"),
    ]
}

/// A host adapter that answers granted, implemented declared members and
/// delegates everything else to the wrapped host.
#[derive(Debug)]
pub struct DeclaredCapabilityHost<H> {
    inner: H,
    policy: CapabilityPolicy,
}

impl<H> DeclaredCapabilityHost<H> {
    /// Wraps `inner` with `policy`.
    ///
    /// Every grant must name a member this toolchain implements: a policy that
    /// authorizes something the adapter cannot answer would otherwise read as a
    /// capability the run has, so it is refused at construction time instead.
    pub fn new(inner: H, policy: CapabilityPolicy) -> Result<Self, String> {
        for (reference, members) in policy.grants() {
            for member in members {
                if ProductionMember::lookup(reference, member).is_none() {
                    return Err(format!(
                        "{CAPABILITY_POLICY_NOT_SERVED}:{reference}.{member}"
                    ));
                }
            }
        }
        Ok(Self { inner, policy })
    }

    /// The policy in force.
    pub fn policy(&self) -> &CapabilityPolicy {
        &self.policy
    }

    /// Returns the wrapped host.
    pub fn into_inner(self) -> H {
        self.inner
    }
}

impl<H: HostAdapter> HostAdapter for DeclaredCapabilityHost<H> {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
        let HostOperation::Declared { reference, member } = &request.operation else {
            return self.inner.invoke(request);
        };
        let Some(implemented) = ProductionMember::lookup(reference, member) else {
            // Not in the production table: the inner host refuses the declared
            // operation exactly as it did before this adapter existed.
            return self.inner.invoke(request);
        };
        if !self.policy.is_granted(reference, member) {
            return Err(StdError::CapabilityDenied);
        }
        match implemented {
            ProductionMember::TextConcat => concat(request),
            ProductionMember::TextScalarCount => scalar_count(request),
            ProductionMember::ClockMonotonicNanos => monotonic_nanos(request),
        }
    }

    fn close_secrets(&mut self) {
        self.inner.close_secrets();
    }
}

/// One decoded parameter value. The bridge sends declared arguments in the
/// VM's canonical typed encoding (`{"type": ..., "value": ...}`), so an adapter
/// cannot confuse a text for a number or read a value of the wrong kind.
#[derive(Clone, Debug, PartialEq, Eq)]
enum DeclaredArgument {
    Text(String),
    Int(i64),
    Bool(bool),
    Unit,
    Bytes(Vec<u8>),
    List(Vec<DeclaredArgument>),
}

fn declared_arguments(request: &HostRequest) -> Result<BTreeMap<String, JsonValue>, StdError> {
    let value = parse_json(&request.argument).map_err(|_| StdError::ArgumentTypeMismatch)?;
    let JsonValue::Object(entries) = value else {
        return Err(StdError::ArgumentTypeMismatch);
    };
    let mut arguments = BTreeMap::new();
    for (name, value) in entries {
        if arguments.insert(name, value).is_some() {
            return Err(StdError::ArgumentTypeMismatch);
        }
    }
    Ok(arguments)
}

/// Decodes the canonical typed encoding produced by `serialize_vm_value`.
fn typed_argument(value: &JsonValue) -> Result<DeclaredArgument, StdError> {
    let JsonValue::Object(entries) = value else {
        return Err(StdError::ArgumentTypeMismatch);
    };
    if entries.len() != 2 {
        return Err(StdError::ArgumentTypeMismatch);
    }
    let mut type_name = None;
    let mut payload = None;
    for (name, value) in entries {
        match name.as_str() {
            "type" => type_name = Some(value),
            "value" => payload = Some(value),
            _ => return Err(StdError::ArgumentTypeMismatch),
        }
    }
    let (Some(JsonValue::String(type_name)), Some(payload)) = (type_name, payload) else {
        return Err(StdError::ArgumentTypeMismatch);
    };
    match type_name.as_str() {
        "text.utf8" => match payload {
            JsonValue::String(text) => Ok(DeclaredArgument::Text(text.clone())),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        "int" => match payload {
            JsonValue::Number(number) => number
                .parse::<i64>()
                .map(DeclaredArgument::Int)
                .map_err(|_| StdError::ArgumentTypeMismatch),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        "bool" => match payload {
            JsonValue::Bool(value) => Ok(DeclaredArgument::Bool(*value)),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        "unit" => match payload {
            JsonValue::Null => Ok(DeclaredArgument::Unit),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        "bytes" => match payload {
            JsonValue::String(text) => {
                let hex = text
                    .strip_prefix("hex:")
                    .ok_or(StdError::ArgumentTypeMismatch)?;
                if hex.len() % 2 != 0 {
                    return Err(StdError::ArgumentTypeMismatch);
                }
                let mut bytes = Vec::with_capacity(hex.len() / 2);
                for index in (0..hex.len()).step_by(2) {
                    bytes.push(
                        u8::from_str_radix(&hex[index..index + 2], 16)
                            .map_err(|_| StdError::ArgumentTypeMismatch)?,
                    );
                }
                Ok(DeclaredArgument::Bytes(bytes))
            }
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        "list" => match payload {
            JsonValue::Array(values) => values
                .iter()
                .map(typed_argument)
                .collect::<Result<Vec<_>, _>>()
                .map(DeclaredArgument::List),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        _ => Err(StdError::ArgumentTypeMismatch),
    }
}

fn text_argument(arguments: &BTreeMap<String, JsonValue>, name: &str) -> Result<String, StdError> {
    match arguments.get(name) {
        Some(value) => match typed_argument(value)? {
            DeclaredArgument::Text(text) => Ok(text),
            _ => Err(StdError::ArgumentTypeMismatch),
        },
        None => Err(StdError::ArgumentTypeMismatch),
    }
}

fn exactly(arguments: &BTreeMap<String, JsonValue>, names: &[&str]) -> Result<(), StdError> {
    if arguments.len() != names.len() || names.iter().any(|name| !arguments.contains_key(*name)) {
        return Err(StdError::ArgumentTypeMismatch);
    }
    Ok(())
}

fn concat(request: &HostRequest) -> Result<HostOutcome, StdError> {
    let arguments = declared_arguments(request)?;
    exactly(&arguments, &["left", "right"])?;
    let left = text_argument(&arguments, "left")?;
    let right = text_argument(&arguments, "right")?;
    let length = left.len().saturating_add(right.len());
    if length > MAX_DECLARED_TEXT_BYTES {
        // A member reports its own failure through the declared variant, so the
        // program can handle it; the bridge rejects a variant the schema omits.
        return Ok(HostOutcome::DeclaredFailure("output_limit".to_owned()));
    }
    let mut value = left;
    value.push_str(&right);
    Ok(HostOutcome::Text(value))
}

fn scalar_count(request: &HostRequest) -> Result<HostOutcome, StdError> {
    let arguments = declared_arguments(request)?;
    exactly(&arguments, &["value"])?;
    let value = text_argument(&arguments, "value")?;
    Ok(HostOutcome::Int(value.chars().count().to_string()))
}

fn monotonic_nanos(request: &HostRequest) -> Result<HostOutcome, StdError> {
    static START: OnceLock<Instant> = OnceLock::new();
    let arguments = declared_arguments(request)?;
    exactly(&arguments, &[])?;
    let elapsed = START.get_or_init(Instant::now).elapsed().as_nanos();
    let nanos = elapsed.min(i64::MAX as u128) as i64;
    Ok(HostOutcome::Int(nanos.to_string()))
}

/// The declared references a graph actually names, given the registry it was
/// checked against. Built-in references are excluded: they are served without a
/// policy.
pub fn referenced_declared_references(
    graph: &Graph,
    declared: &[DeclaredSchema],
) -> BTreeSet<String> {
    graph
        .capabilities
        .iter()
        .filter(|capability| {
            declared
                .iter()
                .any(|schema| schema.reference == capability.reference)
        })
        .map(|capability| capability.reference.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: &str = r#"{"grants":[{"members":["concat"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

    #[test]
    fn a_policy_round_trips_through_parse_and_render() {
        let policy = CapabilityPolicy::parse(POLICY).unwrap();
        assert!(policy.is_granted("revia.strings@0.1.0", "concat"));
        assert!(!policy.is_granted("revia.strings@0.1.0", "scalar_count"));
        assert_eq!(policy.render(), POLICY);
        assert_eq!(CapabilityPolicy::parse(&policy.render()).unwrap(), policy);
    }

    #[test]
    fn a_policy_with_an_unknown_field_is_refused() {
        let source = r#"{"grants":[],"schema":"revia.capability-policy@0.1.0","version":1}"#;
        let error = CapabilityPolicy::parse(source).unwrap_err();
        assert!(error.starts_with(CAPABILITY_POLICY_INVALID), "{error}");
        assert!(error.contains("unknown-field:version"), "{error}");
    }

    #[test]
    fn an_empty_policy_grants_nothing_and_renders() {
        let policy = CapabilityPolicy::deny_all();
        assert!(!policy.is_granted("revia.strings@0.1.0", "concat"));
        assert_eq!(
            policy.render(),
            r#"{"grants":[],"schema":"revia.capability-policy@0.1.0"}"#
        );
    }

    #[test]
    fn a_grant_for_an_unserved_member_is_refused_at_binding() {
        let policy = CapabilityPolicy::parse(
            r#"{"grants":[{"members":["spend"],"reference":"demo.bank@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#,
        )
        .unwrap();
        let error = DeclaredCapabilityHost::new(NoHost, policy).unwrap_err();
        assert_eq!(
            error,
            "native-host-capability-policy-not-served:demo.bank@0.1.0.spend"
        );
    }

    /// Args of a declared call as the bridge encodes them: a canonical object
    /// whose values are the VM's typed `{"type": ..., "value": ...}` encodings.
    fn declared_request(reference: &str, member: &str, argument: &str) -> HostRequest {
        HostRequest::declared(reference, member, argument)
    }

    fn strings_host(policy: &str) -> DeclaredCapabilityHost<RecordingHost> {
        DeclaredCapabilityHost::new(
            RecordingHost::default(),
            CapabilityPolicy::parse(policy).unwrap(),
        )
        .unwrap()
    }

    const CONCAT_POLICY: &str = r#"{"grants":[{"members":["concat"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;
    const COUNT_POLICY: &str = r#"{"grants":[{"members":["scalar_count"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;

    fn concat_argument(left: &str, right: &str) -> String {
        format!(
            r#"{{"left":{{"type":"text.utf8","value":{}}},"right":{{"type":"text.utf8","value":{}}}}}"#,
            quote(left),
            quote(right)
        )
    }

    #[test]
    fn a_granted_concat_joins_in_argument_order() {
        let mut host = strings_host(CONCAT_POLICY);
        let request = declared_request(
            "revia.strings@0.1.0",
            "concat",
            &concat_argument("ab", "cd"),
        );
        assert_eq!(
            host.invoke(&request),
            Ok(HostOutcome::Text("abcd".to_owned()))
        );

        let reversed = declared_request(
            "revia.strings@0.1.0",
            "concat",
            &concat_argument("cd", "ab"),
        );
        assert_eq!(
            host.invoke(&reversed),
            Ok(HostOutcome::Text("cdab".to_owned()))
        );
    }

    #[test]
    fn a_granted_scalar_count_counts_characters_not_bytes() {
        let mut host = strings_host(COUNT_POLICY);
        let argument = format!(
            r#"{{"value":{{"type":"text.utf8","value":{}}}}}"#,
            quote("héllo")
        );
        let request = declared_request("revia.strings@0.1.0", "scalar_count", &argument);
        assert_eq!(host.invoke(&request), Ok(HostOutcome::Int("5".to_owned())));
    }

    #[test]
    fn a_granted_clock_is_monotonic() {
        let policy = r#"{"grants":[{"members":["monotonic_nanos"],"reference":"revia.clock@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#;
        let mut host = strings_host(policy);
        let mut read = || {
            let request = declared_request("revia.clock@0.1.0", "monotonic_nanos", "{}");
            match host.invoke(&request) {
                Ok(HostOutcome::Int(value)) => value.parse::<i64>().unwrap(),
                other => panic!("unexpected clock answer: {other:?}"),
            }
        };
        let first = read();
        let second = read();
        assert!(second >= first, "{second} < {first}");
        assert!(first >= 0, "{first}");
    }

    #[test]
    fn a_served_member_that_is_not_granted_is_denied_and_reaches_no_host() {
        let mut host = strings_host(COUNT_POLICY);
        let request = declared_request(
            "revia.strings@0.1.0",
            "concat",
            &concat_argument("ab", "cd"),
        );
        assert_eq!(host.invoke(&request), Err(StdError::CapabilityDenied));
        assert!(host.inner.seen.is_empty());
    }

    #[test]
    fn an_operation_the_adapter_does_not_serve_is_delegated_unchanged() {
        let mut host = strings_host(CONCAT_POLICY);
        let request = HostRequest::unknown("fs.read_bytes");
        assert_eq!(host.invoke(&request), Ok(HostOutcome::Unit));
        assert_eq!(host.inner.seen, vec!["fs.read_bytes".to_owned()]);
    }

    #[test]
    fn an_oversize_concat_is_a_declared_failure() {
        let mut host = strings_host(CONCAT_POLICY);
        let half = "a".repeat(MAX_DECLARED_TEXT_BYTES / 2 + 1);
        let request = declared_request(
            "revia.strings@0.1.0",
            "concat",
            &concat_argument(&half, &half),
        );
        assert_eq!(
            host.invoke(&request),
            Ok(HostOutcome::DeclaredFailure("output_limit".to_owned()))
        );
    }

    #[test]
    fn a_concat_with_the_wrong_argument_shape_is_refused() {
        let mut host = strings_host(CONCAT_POLICY);
        let missing = declared_request(
            "revia.strings@0.1.0",
            "concat",
            r#"{"left":{"type":"text.utf8","value":"ab"}}"#,
        );
        assert_eq!(host.invoke(&missing), Err(StdError::ArgumentTypeMismatch));

        let extra = declared_request(
            "revia.strings@0.1.0",
            "concat",
            r#"{"left":{"type":"text.utf8","value":"ab"},"right":{"type":"text.utf8","value":"cd"},"rest":{"type":"text.utf8","value":"ef"}}"#,
        );
        assert_eq!(host.invoke(&extra), Err(StdError::ArgumentTypeMismatch));

        let wrong_type = declared_request(
            "revia.strings@0.1.0",
            "concat",
            r#"{"left":{"type":"int","value":1},"right":{"type":"text.utf8","value":"cd"}}"#,
        );
        assert_eq!(
            host.invoke(&wrong_type),
            Err(StdError::ArgumentTypeMismatch)
        );

        let raw = declared_request(
            "revia.strings@0.1.0",
            "concat",
            r#"{"left":"ab","right":"cd"}"#,
        );
        assert_eq!(host.invoke(&raw), Err(StdError::ArgumentTypeMismatch));
    }

    #[test]
    fn every_reachable_policy_rejection_reports_its_own_reason() {
        // `parse_json` returns a keyed object, so the `duplicate-field` arms
        // are defensive and cannot be reached from text input; every other
        // rejection is exercised here.
        let cases = [
            ("{", "not-json"),
            ("[]", "not-an-object"),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[],"version":1}"#,
                "unknown-field:version",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0"}"#,
                "missing-field:grants",
            ),
            (r#"{"grants":[]}"#, "missing-field:schema"),
            (
                r#"{"schema":"revia.capability-policy@0.2.0","grants":[]}"#,
                "schema-unsupported:revia.capability-policy@0.2.0",
            ),
            (r#"{"schema":1,"grants":[]}"#, "schema-not-text"),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":{}}"#,
                "grants-not-an-array",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[1]}"#,
                "grant-not-an-object",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":["m"],"extra":1}]}"#,
                "unknown-grant-field:extra",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0"}]}"#,
                "missing-grant-field:members",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0"}]}"#,
                "missing-grant-field:members",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":1,"members":["m"]}]}"#,
                "grant-reference-not-text",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"","members":["m"]}]}"#,
                "grant-reference-empty",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":"m"}]}"#,
                "grant-members-not-an-array",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":[]}]}"#,
                "grant-members-empty:a@1.0.0",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":[1]}]}"#,
                "grant-member-not-text:a@1.0.0",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":[""]}]}"#,
                "grant-member-empty:a@1.0.0",
            ),
            (
                r#"{"schema":"revia.capability-policy@0.1.0","grants":[{"reference":"a@1.0.0","members":["m","m"]}]}"#,
                "grant-member-duplicate:a@1.0.0.m",
            ),
        ];
        for (source, reason) in cases {
            let error = CapabilityPolicy::parse(source).unwrap_err();
            assert_eq!(
                error,
                format!("{CAPABILITY_POLICY_INVALID}:{reason}"),
                "{source}"
            );
        }
    }

    #[test]
    fn a_grant_naming_two_members_authorizes_exactly_those() {
        let policy = CapabilityPolicy::parse(
            r#"{"grants":[{"members":["concat","scalar_count"],"reference":"revia.strings@0.1.0"}],"schema":"revia.capability-policy@0.1.0"}"#,
        )
        .unwrap();
        assert!(policy.is_granted("revia.strings@0.1.0", "concat"));
        assert!(policy.is_granted("revia.strings@0.1.0", "scalar_count"));
        assert!(!policy.is_granted("revia.strings@0.1.0", "monotonic_nanos"));
        assert!(!policy.is_granted("revia.clock@0.1.0", "concat"));
    }

    #[derive(Default)]
    struct RecordingHost {
        seen: Vec<String>,
    }

    impl HostAdapter for RecordingHost {
        fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
            let name = match &request.operation {
                HostOperation::Unknown(name) => name.clone(),
                other => format!("{other:?}"),
            };
            self.seen.push(name);
            Ok(HostOutcome::Unit)
        }

        fn close_secrets(&mut self) {}
    }

    #[derive(Debug)]
    struct NoHost;

    impl HostAdapter for NoHost {
        fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
            Err(StdError::UnknownOperation)
        }

        fn close_secrets(&mut self) {}
    }
}
