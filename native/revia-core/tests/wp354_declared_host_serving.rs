//! WP-354: a host that *serves* registry-declared members.
//!
//! WP-352/353 proved that a declaring graph reaches the host boundary and that
//! the boundary refuses what it cannot answer. This file closes the next gap:
//! an adapter that does answer `HostOperation::Declared` drives the declaring
//! program end to end through the VM (`translate_graph_with_declarations` ->
//! `HostBackedBridge::new_with_declarations` -> `execute_bytecode_with_declarations`),
//! and everything it does not serve stays fail-closed.
//!
//! The host here is deliberately test-local. `SystemHost` and `MemoryHost` keep
//! refusing `Declared` (that boundary is pinned by `wp351`/`wp352`, and the
//! cheap `MemoryHost` case below repeats it), so no production host is made
//! more permissive by this evidence.

use std::collections::BTreeMap;

use revia_core::{
    bytecode::{serialize_bytecode_artifact, translate_graph_with_declarations},
    graph::{
        DeclaredMember, DeclaredSchema, Graph, check_graph_with_declared_schemas, graph_revision,
        parse_compact_graph,
    },
    minimal_std::{
        HostAdapter, HostBackedBridge, HostObservation, HostOperation, HostOutcome, HostRequest,
        MemoryHost, StdError,
    },
    vm::{
        CapabilityBridge, CapabilityResponse, VmLimits, VmRequest, VmResult, VmValue,
        execute_bytecode_with_declarations,
    },
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const PROGRAM: &str = r#"re 0.1 compact
unit @demo

cap @echo: demo.echo@0.1.0
cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %value = @echo.say(text: "hi")
  return match %value {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
"#;

/// A handler answers one declared member. The key is the full
/// `reference.member` pair, so the adapter is answering what the *declaration*
/// names, not what the graph happens to call.
type Handler = fn(&HostRequest) -> Result<HostOutcome, StdError>;

struct ServingHost {
    handlers: BTreeMap<String, Handler>,
    seen: Vec<HostRequest>,
}

impl ServingHost {
    fn serving(entries: &[(&str, Handler)]) -> Self {
        Self {
            handlers: entries
                .iter()
                .map(|(key, handler)| ((*key).to_owned(), *handler))
                .collect(),
            seen: Vec::new(),
        }
    }
}

impl HostAdapter for ServingHost {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
        self.seen.push(request.clone());
        let key = match &request.operation {
            HostOperation::Declared { reference, member } => format!("{reference}.{member}"),
            _ => return Err(StdError::UnknownOperation),
        };
        match self.handlers.get(&key) {
            Some(handler) => handler(request),
            None => Err(StdError::UnknownOperation),
        }
    }

    fn close_secrets(&mut self) {}
}

fn echo_say_ok(_request: &HostRequest) -> Result<HostOutcome, StdError> {
    Ok(HostOutcome::Text("hi!".to_owned()))
}

fn echo_say_empty(_request: &HostRequest) -> Result<HostOutcome, StdError> {
    Ok(HostOutcome::DeclaredFailure("empty".to_owned()))
}

fn echo_say_bytes(_request: &HostRequest) -> Result<HostOutcome, StdError> {
    Ok(HostOutcome::Bytes(vec![1, 2, 3]))
}

fn echo_say_undeclared(_request: &HostRequest) -> Result<HostOutcome, StdError> {
    // `demo.echo_error` declares only `empty`; this one is not in the family.
    Ok(HostOutcome::DeclaredFailure("boom".to_owned()))
}

fn member(
    name: &str,
    parameters: &[(&str, &str)],
    returns: Option<&str>,
    errors: &[&str],
) -> DeclaredMember {
    DeclaredMember {
        name: name.to_owned(),
        parameters: parameters
            .iter()
            .map(|(name, type_name)| ((*name).to_owned(), (*type_name).to_owned()))
            .collect(),
        returns: returns.map(str::to_owned),
        errors: errors.iter().map(|error| (*error).to_owned()).collect(),
    }
}

/// The registry -> declarations parse is pinned by the `wp352`/`wp353` CLI
/// tests; this file starts from the same `DeclaredSchema` shape those produce.
fn declarations() -> Vec<DeclaredSchema> {
    vec![DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members: vec![
            member(
                "say",
                &[("text", "text.utf8")],
                Some("result<text.utf8, demo.echo_error>"),
                &["empty"],
            ),
            member("ping", &[], Some("unit"), &[]),
        ],
    }]
}

fn graph(declared: &[DeclaredSchema]) -> Graph {
    let parsed = parse_compact_graph(PROGRAM, "wp354-declared-host-serving.re").unwrap();
    check_graph_with_declared_schemas(parsed, declared).unwrap()
}

fn execute(
    host: ServingHost,
    declared: &[DeclaredSchema],
) -> (Result<VmResult, String>, Vec<HostObservation>, ServingHost) {
    let graph = graph(declared);
    let artifact = translate_graph_with_declarations(&graph, declared).unwrap();
    let artifact_source = serialize_bytecode_artifact(&artifact).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let request = VmRequest::new(
        revision.clone(),
        artifact.artifact_digest.clone(),
        artifact.profile.clone(),
        INPUT_DIGEST,
    );
    let mut bridge =
        HostBackedBridge::new_with_declarations(&graph, host, revision, INPUT_DIGEST, declared)
            .unwrap();
    let result = execute_bytecode_with_declarations(
        &graph,
        &artifact_source,
        &request,
        &mut bridge,
        VmLimits::default(),
        declared,
    )
    .map_err(|error| error.code);
    let observations = bridge.observations().to_vec();
    (result, observations, bridge.into_host())
}

#[test]
fn a_serving_host_runs_a_declared_member_end_to_end() {
    let declared = declarations();
    let (result, observations, host) = execute(
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_ok)]),
        &declared,
    );

    let result = result.unwrap();
    assert_eq!(result.outcome.code, 0);
    assert_eq!(result.invocations.len(), 1);
    assert_eq!(result.invocations[0].instance, "@echo");
    assert_eq!(result.invocations[0].member, "say");
    assert_eq!(result.invocations[0].outcome, "ok");

    // The adapter received the declared operation and the canonical argument
    // envelope for the call-site value.
    assert_eq!(host.seen.len(), 1);
    assert_eq!(
        host.seen[0].operation,
        HostOperation::Declared {
            reference: "demo.echo@0.1.0".to_owned(),
            member: "say".to_owned(),
        }
    );
    assert_eq!(
        host.seen[0].argument,
        r#"{"text":{"type":"text.utf8","value":"hi"}}"#
    );

    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].instance, "@echo");
    assert_eq!(observations[0].member, "say");
    assert_eq!(observations[0].operation, "declared:demo.echo@0.1.0.say");
    assert_eq!(observations[0].outcome, "text");
    assert!(observations[0].error.is_none());
    assert!(!observations[0].effect_committed);
}

#[test]
fn a_declared_failure_lands_on_the_programs_err_branch() {
    let declared = declarations();
    let (result, observations, _) = execute(
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_empty)]),
        &declared,
    );

    let result = result.unwrap();
    assert_eq!(result.outcome.code, 1);
    assert_eq!(result.invocations.len(), 1);
    assert_eq!(result.invocations[0].outcome, "err");
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].outcome, "declared_failure");
    assert!(observations[0].error.is_none());
    assert!(!observations[0].effect_committed);
}

#[test]
fn a_member_the_host_does_not_serve_fails_closed() {
    let declared = declarations();
    let (result, observations, host) = execute(ServingHost::serving(&[]), &declared);

    // The request still reaches the adapter as a declared operation; the
    // adapter refuses it, and the boundary turns that refusal into a host
    // fault instead of inventing a value.
    assert_eq!(result.unwrap_err(), "native-vm-capability-failed");
    assert_eq!(host.seen.len(), 1);
    assert_eq!(
        host.seen[0].operation,
        HostOperation::Declared {
            reference: "demo.echo@0.1.0".to_owned(),
            member: "say".to_owned(),
        }
    );
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].operation, "declared:demo.echo@0.1.0.say");
    // The observation records what the adapter answered, not the bridge's
    // later mapping; the refusal is visible as the adapter's own error name.
    assert_eq!(observations[0].outcome, "error");
    assert_eq!(observations[0].error.as_deref(), Some("unknown_operation"));
    assert!(!observations[0].effect_committed);
}

#[test]
fn a_served_member_returning_the_wrong_shape_fails_closed() {
    let declared = declarations();
    let (result, observations, _) = execute(
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_bytes)]),
        &declared,
    );

    assert_eq!(result.unwrap_err(), "native-vm-capability-failed");
    assert_eq!(observations.len(), 1);
    // The adapter did answer, so the observation records the payload it sent;
    // the bridge rejects the shape and the VM fails the capability call.
    assert_eq!(observations[0].outcome, "bytes");
    assert!(observations[0].error.is_none());
    assert!(!observations[0].effect_committed);
}

#[test]
fn the_fixture_adapter_answers_only_declared_operations() {
    // Guard against this file accidentally proving something about a special
    // host type: the adapter above implements only the two required methods.
    let mut host = ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_ok)]);
    let request = HostRequest::declared(
        "demo.echo@0.1.0".to_owned(),
        "say".to_owned(),
        r#"{"text":{"type":"text.utf8","value":"hi"}}"#.to_owned(),
    );
    // A built-in operation is not on the handler table: the fixture serves
    // declared members only.
    let other = HostRequest {
        operation: HostOperation::StdoutWrite,
        ..request.clone()
    };
    assert!(matches!(
        host.invoke(&other),
        Err(StdError::UnknownOperation)
    ));
    assert_eq!(
        host.invoke(&request).unwrap(),
        HostOutcome::Text("hi!".to_owned())
    );
    host.close_secrets();

    // A production host still refuses the same request: nothing in this file
    // teaches `MemoryHost` (or `SystemHost`) to serve declarations.
    let mut memory = MemoryHost::new(Vec::new(), BTreeMap::new(), BTreeMap::new());
    assert!(matches!(
        memory.invoke(&request),
        Err(StdError::UnknownOperation)
    ));
}

/// The err branch alone only proves that *some* err value arrived. This test
/// pins the bridge response, the only surface that carries the declared family
/// and variant: `ResultErr` names both, an undeclared variant is refused by
/// name, and a wrong-shaped success is the host fault the VM later maps. The VM
/// result deliberately exposes neither name (`VmInvocation` has no payload), so
/// program-visible family matching stays open.
#[test]
fn the_declared_error_family_surfaces_at_the_bridge() {
    let declared = declarations();
    let graph = graph(&declared);
    let revision = graph_revision(&graph).unwrap();
    let arguments = [("text".to_owned(), VmValue::Text("hi".to_owned()))]
        .into_iter()
        .collect::<BTreeMap<_, _>>();

    let mut serving = HostBackedBridge::new_with_declarations(
        &graph,
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_ok)]),
        revision.clone(),
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();
    // The success payload is passed through as declared, not merely typed.
    assert_eq!(
        serving
            .invoke("@echo", "say", &arguments, "invocation-1")
            .unwrap(),
        CapabilityResponse::ok(VmValue::Text("hi!".to_owned()))
    );

    let mut failing = HostBackedBridge::new_with_declarations(
        &graph,
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_empty)]),
        revision.clone(),
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();
    assert_eq!(
        failing
            .invoke("@echo", "say", &arguments, "invocation-1")
            .unwrap(),
        CapabilityResponse::err(VmValue::ResultErr {
            type_name: "demo.echo_error".to_owned(),
            variant: "empty".to_owned(),
        })
    );

    // A wrong-shaped success is a host fault, not a bridged string: the code
    // exists at the bridge response, so pin it where it is observable.
    let mut wrong_shape = HostBackedBridge::new_with_declarations(
        &graph,
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_bytes)]),
        revision.clone(),
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();
    assert_eq!(
        wrong_shape
            .invoke("@echo", "say", &arguments, "invocation-1")
            .unwrap(),
        CapabilityResponse::host_fault("native-host-return-type-mismatch")
    );

    let mut undeclared = HostBackedBridge::new_with_declarations(
        &graph,
        ServingHost::serving(&[("demo.echo@0.1.0.say", echo_say_undeclared)]),
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();
    assert_eq!(
        undeclared
            .invoke("@echo", "say", &arguments, "invocation-1")
            .unwrap_err(),
        "native-host-bridge-error-variant-unknown:demo.echo_error.boom"
    );
}
