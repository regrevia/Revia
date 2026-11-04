//! WP-351: registry-declared members are dispatched at the runtime host
//! boundary, not only admitted at checking time.

use std::collections::BTreeMap;

use revia_core::{
    graph::{
        DeclaredMember, DeclaredSchema, Graph, check_graph_with_declared_schemas, graph_revision,
        parse_compact_graph,
    },
    minimal_std::{HostAdapter, HostBackedBridge, HostOutcome, HostRequest, StdError},
    vm::{CapabilityBridge, CapabilityResponse, VmValue},
};

const INPUT_DIGEST: &str =
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

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
        errors: errors.iter().map(|variant| (*variant).to_owned()).collect(),
    }
}

fn echo_members() -> Vec<DeclaredMember> {
    vec![
        member(
            "say",
            &[("text", "text.utf8")],
            Some("result<text.utf8, demo.echo_error>"),
            &["empty"],
        ),
        member(
            "fail",
            &[],
            Some("result<unit, demo.echo_error>"),
            &["empty"],
        ),
        member("count", &[], Some("number.i64"), &[]),
        member("list", &[], Some("list<text.utf8>"), &[]),
        member("flag", &[], Some("bool"), &[]),
        member("ping", &[], Some("unit"), &[]),
    ]
}

fn declarations() -> Vec<DeclaredSchema> {
    vec![DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members: echo_members(),
    }]
}

fn graph(declared: &[DeclaredSchema]) -> Graph {
    let parsed = parse_compact_graph(PROGRAM, "demo.re").unwrap();
    check_graph_with_declared_schemas(parsed, declared).unwrap()
}

fn bridge_with_declarations<A: HostAdapter>(
    host: A,
    declared: &[DeclaredSchema],
) -> (HostBackedBridge<A>, Graph) {
    let graph = graph(declared);
    let revision = graph_revision(&graph).unwrap();
    let bridge =
        HostBackedBridge::new_with_declarations(&graph, host, revision, INPUT_DIGEST, declared)
            .unwrap();
    (bridge, graph)
}

fn invoke(
    bridge: &mut HostBackedBridge<StubHost>,
    member: &str,
    arguments: &[(&str, VmValue)],
) -> Result<CapabilityResponse, String> {
    let arguments = arguments
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    bridge.invoke("@echo", member, &arguments, "invocation-1")
}

/// The minimal host that answers declared members, used so the dispatch path is
/// observable without teaching a real adapter the declaration table.
struct StubHost {
    outcome: Result<HostOutcome, StdError>,
    seen: Option<HostRequest>,
}

impl StubHost {
    fn answering(outcome: Result<HostOutcome, StdError>) -> Self {
        Self {
            outcome,
            seen: None,
        }
    }
}

impl HostAdapter for StubHost {
    fn invoke(&mut self, request: &HostRequest) -> Result<HostOutcome, StdError> {
        self.seen = Some(request.clone());
        self.outcome.clone()
    }

    fn close_secrets(&mut self) {}
}

const TEXT: fn(&str) -> VmValue = |value: &str| VmValue::Text(value.to_owned());

#[test]
fn declared_member_dispatches_to_the_host_and_returns_its_text() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("hi!".to_owned()))),
        &declared,
    );

    let response = invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap();

    assert_eq!(
        response,
        CapabilityResponse::ok(VmValue::Text("hi!".to_owned()))
    );
    let observations = bridge.observations();
    assert_eq!(observations.len(), 1);
    assert_eq!(observations[0].outcome, "text");
    assert_eq!(observations[0].operation, "declared:demo.echo@0.1.0.say");
}

#[test]
fn declared_member_maps_a_declared_failure_onto_the_declared_error_family() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::DeclaredFailure("empty".to_owned()))),
        &declared,
    );

    let response = invoke(&mut bridge, "say", &[("text", TEXT(""))]).unwrap();

    assert_eq!(
        response,
        CapabilityResponse::err(VmValue::ResultErr {
            type_name: "demo.echo_error".to_owned(),
            variant: "empty".to_owned(),
        })
    );
    assert_eq!(bridge.observations()[0].outcome, "declared_failure");
}

#[test]
fn declared_member_rejects_an_error_variant_outside_its_family() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::DeclaredFailure("boom".to_owned()))),
        &declared,
    );

    let error = invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap_err();

    assert_eq!(
        error,
        "native-host-bridge-error-variant-unknown:demo.echo_error.boom"
    );
}

#[test]
fn declared_member_accepts_number_and_list_returns() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Int("42".to_owned()))),
        &declared,
    );
    assert_eq!(
        invoke(&mut bridge, "count", &[]).unwrap(),
        CapabilityResponse::ok(VmValue::Int(42))
    );

    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Args(vec!["a".to_owned()]))),
        &declared,
    );
    assert_eq!(
        invoke(&mut bridge, "list", &[]).unwrap(),
        CapabilityResponse::ok(VmValue::List(vec![VmValue::Text("a".to_owned())]))
    );
}

#[test]
fn declared_member_rejects_a_return_value_the_declaration_does_not_promise() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Bytes(vec![1, 2, 3]))),
        &declared,
    );

    assert_eq!(
        invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap(),
        CapabilityResponse::host_fault("native-host-return-type-mismatch")
    );
}

#[test]
fn declared_argument_checks_reuse_the_existing_bridge_failures() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("ok".to_owned()))),
        &declared,
    );

    assert_eq!(
        invoke(&mut bridge, "say", &[]).unwrap_err(),
        "native-host-bridge-argument-missing"
    );
    assert_eq!(
        invoke(&mut bridge, "say", &[("text", VmValue::Int(1))]).unwrap_err(),
        "native-host-bridge-argument-type-mismatch"
    );
    assert_eq!(
        invoke(
            &mut bridge,
            "say",
            &[("text", TEXT("hi")), ("extra", TEXT("x"))]
        )
        .unwrap_err(),
        "native-host-bridge-argument-unknown:extra"
    );
}

#[test]
fn declared_reference_with_an_undeclared_member_fails_closed() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("ok".to_owned()))),
        &declared,
    );

    assert_eq!(
        invoke(&mut bridge, "nope", &[]).unwrap_err(),
        "native-host-bridge-declared-member-unknown:demo.echo@0.1.0.nope"
    );
}

#[test]
fn adapter_that_does_not_implement_declared_members_fails_closed() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Err(StdError::UnknownOperation)),
        &declared,
    );

    assert_eq!(
        invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap(),
        CapabilityResponse::host_fault("native-host-bridge-operation-unsupported:@echo.say")
    );
}

#[test]
fn built_in_references_keep_their_closed_failure_with_declarations_present() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("ok".to_owned()))),
        &declared,
    );

    let error = bridge
        .invoke("@stdout", "nope", &BTreeMap::new(), "invocation-1")
        .unwrap_err();

    assert_eq!(
        error,
        "native-host-bridge-operation-unsupported:@stdout.nope"
    );
}

#[test]
fn constructor_rejects_a_declaration_that_shadows_a_built_in() {
    let mut declared = declarations();
    declared.push(DeclaredSchema {
        reference: "fs.read@0.1.0".to_owned(),
        members: echo_members(),
    });
    let graph = graph(&declarations());
    let revision = graph_revision(&graph).unwrap();
    let error = HostBackedBridge::new_with_declarations(
        &graph,
        StubHost::answering(Ok(HostOutcome::Unit)),
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .err()
    .expect("shadowing declaration must be rejected");

    assert_eq!(error, "native-host-bridge-declaration-invalid");
}

#[test]
fn constructor_rejects_a_declared_type_the_bridge_cannot_type_check() {
    let declared = vec![DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members: vec![member(
            "say",
            &[("text", "map<text.utf8,number.i64>")],
            None,
            &[],
        )],
    }];
    let graph = graph(&declarations());
    let revision = graph_revision(&graph).unwrap();
    let error = HostBackedBridge::new_with_declarations(
        &graph,
        StubHost::answering(Ok(HostOutcome::Unit)),
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .err()
    .expect("unsupported declared type must be rejected");

    assert_eq!(
        error,
        "native-host-bridge-declared-type-unsupported:map<text.utf8,number.i64>"
    );
}

#[test]
fn declared_member_maps_a_unit_result_success() {
    let declared = declarations();
    let (mut bridge, _) =
        bridge_with_declarations(StubHost::answering(Ok(HostOutcome::Unit)), &declared);

    assert_eq!(
        invoke(&mut bridge, "fail", &[]).unwrap(),
        CapabilityResponse::ok(VmValue::Unit)
    );
    assert_eq!(bridge.observations()[0].outcome, "unit");
}

#[test]
fn declared_member_maps_bool_and_unit_returns() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Int("1".to_owned()))),
        &declared,
    );
    assert_eq!(
        invoke(&mut bridge, "flag", &[]).unwrap(),
        CapabilityResponse::ok(VmValue::Bool(true))
    );

    let (mut bridge, _) =
        bridge_with_declarations(StubHost::answering(Ok(HostOutcome::Unit)), &declared);
    assert_eq!(
        invoke(&mut bridge, "ping", &[]).unwrap(),
        CapabilityResponse::ok(VmValue::Unit)
    );
}

#[test]
fn a_declared_call_never_commits_an_effect() {
    let declared = declarations();
    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("hi!".to_owned()))),
        &declared,
    );

    invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap();

    assert!(!bridge.observations()[0].effect_committed);
}

#[test]
fn declared_arguments_are_serialized_in_canonical_key_order() {
    // The registry lists `zeta` before `alpha`; the canonical argument object
    // must still serialize `alpha` first so its digest is registry-independent.
    let mut declared = declarations();
    declared.push(DeclaredSchema {
        reference: "demo.pair@0.1.0".to_owned(),
        members: vec![member(
            "join",
            &[("zeta", "text.utf8"), ("alpha", "text.utf8")],
            Some("text.utf8"),
            &[],
        )],
    });
    let source = PROGRAM.replace(
        "cap @echo: demo.echo@0.1.0",
        "cap @echo: demo.echo@0.1.0\ncap @pair: demo.pair@0.1.0",
    );
    let graph = check_graph_with_declared_schemas(
        parse_compact_graph(&source, "demo.re").unwrap(),
        &declared,
    )
    .unwrap();
    let revision = graph_revision(&graph).unwrap();
    let mut bridge = HostBackedBridge::new_with_declarations(
        &graph,
        StubHost::answering(Ok(HostOutcome::Text("a-z".to_owned()))),
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();

    let response = bridge
        .invoke(
            "@pair",
            "join",
            &[
                ("zeta".to_owned(), TEXT("z")),
                ("alpha".to_owned(), TEXT("a")),
            ]
            .into_iter()
            .collect(),
            "invocation-1",
        )
        .unwrap();

    assert_eq!(
        response,
        CapabilityResponse::ok(VmValue::Text("a-z".to_owned()))
    );
    let expected = "{\"alpha\":{\"type\":\"text.utf8\",\"value\":\"a\"},\"zeta\":{\"type\":\"text.utf8\",\"value\":\"z\"}}";
    assert_eq!(
        bridge.observations()[0].argument_digest,
        format!(
            "sha256:{}",
            revia_core::digest::sha256_hex(expected.as_bytes())
        )
    );
}

#[test]
fn a_graph_carries_only_the_declarations_it_references() {
    // A registry entry the graph never calls must not decide whether the
    // program runs, even when its declared types are outside this bridge's
    // vocabulary. Check time already admits the registry; run time must agree.
    let mut declared = declarations();
    declared.push(DeclaredSchema {
        reference: "demo.unused@0.1.0".to_owned(),
        members: vec![member("weird", &[("x", "map<text.utf8,unit>")], None, &[])],
    });

    let (mut bridge, _) = bridge_with_declarations(
        StubHost::answering(Ok(HostOutcome::Text("hi!".to_owned()))),
        &declared,
    );

    assert_eq!(
        invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap(),
        CapabilityResponse::ok(VmValue::Text("hi!".to_owned()))
    );
}

#[test]
fn two_graph_construction_dispatches_declared_members() {
    let declared = declarations();
    let graph = graph(&declared);
    let revision = graph_revision(&graph).unwrap();
    let mut bridge = HostBackedBridge::new_for_graphs_with_declarations(
        &[&graph, &graph],
        StubHost::answering(Ok(HostOutcome::Text("hi!".to_owned()))),
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();

    assert_eq!(
        invoke(&mut bridge, "say", &[("text", TEXT("hi"))]).unwrap(),
        CapabilityResponse::ok(VmValue::Text("hi!".to_owned()))
    );
}
