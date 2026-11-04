//! WP-353: check time and the runtime bridge ask one declared-type validator,
//! so a referenced declaration either passes both or is rejected by both with
//! the same offending type name.

use std::collections::BTreeMap;

use revia_core::{
    graph::{
        DeclaredMember, DeclaredSchema, check_graph_with_declared_schemas,
        declared_return_type_supported, graph_revision, is_supported_declared_type,
        parse_compact_graph, validate_declarations,
    },
    minimal_std::{HostAdapter, HostBackedBridge, HostOutcome, HostRequest, StdError},
    vm::{CapabilityBridge, CapabilityResponse, VmValue},
};

const INPUT_DIGEST: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const PROGRAM: &str = r#"re 0.1 compact
unit @demo

cap @echo: demo.echo@0.1.0

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

fn say() -> DeclaredMember {
    member(
        "say",
        &[("text", "text.utf8")],
        Some("result<text.utf8, demo.echo_error>"),
        &["empty"],
    )
}

fn schema(members: Vec<DeclaredMember>) -> DeclaredSchema {
    DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members,
    }
}

/// A declaration list the graph can call: its only member is the one the
/// program invokes, with supported types.
fn callable_declarations() -> Vec<DeclaredSchema> {
    vec![schema(vec![say()])]
}

/// The same reference, widened with a member the program never calls whose
/// types are the ones under test.
fn probe_declarations(probe: DeclaredMember) -> Vec<DeclaredSchema> {
    vec![schema(vec![say(), probe])]
}

fn graph_with(declared: &[DeclaredSchema]) -> Result<(), String> {
    let parsed = parse_compact_graph(PROGRAM, "demo.re").map_err(|error| error.code)?;
    check_graph_with_declared_schemas(parsed, declared)
        .map(|_| ())
        .map_err(|error| format!("{}:{}", error.code, error.actual.unwrap_or_default()))
}

struct StubHost;

impl HostAdapter for StubHost {
    fn invoke(&mut self, _request: &HostRequest) -> Result<HostOutcome, StdError> {
        Ok(HostOutcome::Text("hi!".to_owned()))
    }

    fn close_secrets(&mut self) {}
}

/// Build the bridge the way a caller would after checking `callable` — the
/// graph reference is valid — but hand it the declaration list under test, so
/// the bridge's own validation is what answers.
fn bridge_with(declared: &[DeclaredSchema]) -> Result<(), String> {
    let parsed = parse_compact_graph(PROGRAM, "demo.re").unwrap();
    let callable = callable_declarations();
    let graph = check_graph_with_declared_schemas(parsed, &callable).unwrap();
    let revision = graph_revision(&graph).unwrap();
    HostBackedBridge::new_with_declarations(&graph, StubHost, revision, INPUT_DIGEST, declared)
        .map(|_| ())
}

/// The whole point of WP-353: for every type name the two sides must not
/// disagree about, a referenced declaration is accepted by both or rejected by
/// both, and the rejection names the same type.
fn assert_sides_agree(type_name: &str, parameter: bool) {
    let probe = if parameter {
        member("probe", &[("value", type_name)], None, &[])
    } else {
        let errors: &[&str] = if type_name.starts_with("result<") {
            &["empty"]
        } else {
            &[]
        };
        member("probe", &[], Some(type_name), errors)
    };
    let declared = probe_declarations(probe);
    let supported = if parameter {
        is_supported_declared_type(type_name)
    } else {
        declared_return_type_supported(type_name)
    };
    let check = graph_with(&declared);
    let bridge = bridge_with(&declared);
    if supported {
        assert_eq!(check, Ok(()), "check time rejected supported {type_name}");
        assert_eq!(bridge, Ok(()), "bridge rejected supported {type_name}");
    } else {
        assert_eq!(
            check,
            Err(format!("declared-type-unsupported:{type_name}")),
            "check time accepted unsupported {type_name}"
        );
        assert_eq!(
            bridge,
            Err(format!(
                "native-host-bridge-declared-type-unsupported:{type_name}"
            )),
            "bridge accepted unsupported {type_name}"
        );
    }
}

#[test]
fn supported_payload_types_are_accepted_by_both_sides() {
    for type_name in [
        "text.utf8",
        "bytes",
        "fs.path",
        "text.encoding",
        "number.i64",
        "bool",
        "unit",
        "list<text.utf8>",
    ] {
        assert_sides_agree(type_name, true);
    }
}

#[test]
fn unsupported_payload_types_are_rejected_by_both_sides() {
    for type_name in [
        "map<text.utf8,number.i64>",
        "list<number.i64>",
        "text.ascii",
        "demo.money",
        "result<text.utf8, demo.echo_error>",
    ] {
        assert_sides_agree(type_name, true);
    }
}

#[test]
fn supported_return_types_are_accepted_by_both_sides() {
    for type_name in [
        "unit",
        "number.i64",
        "list<text.utf8>",
        "result<text.utf8, demo.echo_error>",
        "result<unit, demo.echo_error>",
    ] {
        assert_sides_agree(type_name, false);
    }
}

#[test]
fn unsupported_return_types_are_rejected_by_both_sides() {
    for type_name in [
        "map<text.utf8,number.i64>",
        "list<number.i64>",
        "result<map<text.utf8,number.i64>, demo.echo_error>",
        "result<list<bytes>, demo.echo_error>",
    ] {
        assert_sides_agree(type_name, false);
    }
}

/// A family half must be one bare name: no `@`, no whitespace, no generic
/// punctuation. This is a predicate-level guarantee: `validate_declarations`
/// (the registry shape gate) already refuses these spellings as
/// `declared-schema-invalid` before either side reaches the type gate, so the
/// rule here keeps the public predicate from calling a spelling supported that
/// no declaration could ever carry. The trailing-`>` case is why it exists:
/// stripping one `>` would otherwise leave `family>x` looking like a family.
#[test]
fn malformed_family_halves_are_not_supported() {
    for type_name in [
        "result<text.utf8,>",
        "result<text.utf8, demo@x>",
        "result<text.utf8, demo x>",
        "result<text.utf8, a,b>",
        "result<text.utf8, a<b>",
        "result<text.utf8, family>x>",
    ] {
        assert!(
            !declared_return_type_supported(type_name),
            "the family rule accepted {type_name}"
        );
    }
}

#[test]
fn the_payload_vocabulary_names_every_supported_payload_type() {
    for type_name in [
        "text.utf8",
        "bytes",
        "fs.path",
        "text.encoding",
        "number.i64",
        "bool",
        "unit",
    ] {
        assert!(is_supported_declared_type(type_name));
    }
    assert!(is_supported_declared_type("list<text.utf8>"));
    for type_name in [
        "list<bytes>",
        "result<text.utf8, demo.echo_error>",
        "Text.utf8",
    ] {
        assert!(!is_supported_declared_type(type_name));
    }
    assert!(declared_return_type_supported(
        "result<list<text.utf8>, demo.echo_error>"
    ));
    assert!(!declared_return_type_supported(
        "result<list<bytes>, demo.echo_error>"
    ));
}

/// `validate_declarations` stays vocabulary-free: the registry may describe a
/// type a future adapter will learn, and only a reference the graph names is
/// held to the vocabulary.
#[test]
fn an_uncalled_declaration_keeps_its_own_vocabulary() {
    let unused = DeclaredSchema {
        reference: "demo.unused@0.1.0".to_owned(),
        members: vec![member(
            "spend",
            &[("amount", "map<text.utf8,number.i64>")],
            None,
            &[],
        )],
    };
    let mut declared = callable_declarations();
    declared.push(unused);
    assert_eq!(validate_declarations(&declared).map_err(|e| e.code), Ok(()));

    let parsed = parse_compact_graph(PROGRAM, "demo.re").unwrap();
    assert!(
        check_graph_with_declared_schemas(parsed, &declared).is_ok(),
        "a declaration the program never names must not fail the check"
    );

    // The same schema becomes decisive as soon as the graph names it.
    let referenced = DeclaredSchema {
        reference: "demo.unused@0.1.0".to_owned(),
        members: vec![member(
            "spend",
            &[("amount", "map<text.utf8,number.i64>")],
            None,
            &[],
        )],
    };
    let mut declared = callable_declarations();
    declared.push(referenced.clone());
    let program = PROGRAM.replace(
        "cap @echo: demo.echo@0.1.0",
        "cap @echo: demo.echo@0.1.0\ncap @spend: demo.unused@0.1.0",
    );
    let parsed = parse_compact_graph(&program, "demo.re").unwrap();
    let error = check_graph_with_declared_schemas(parsed, &declared).unwrap_err();
    assert_eq!(error.code, "declared-type-unsupported");
    assert_eq!(error.actual.as_deref(), Some("map<text.utf8,number.i64>"));
}

/// The argument digest is untouched by this slice: a supported declared call
/// still maps to the same canonical request shape.
#[test]
fn a_supported_declared_call_still_maps_its_request() {
    let declared = callable_declarations();
    let parsed = parse_compact_graph(PROGRAM, "demo.re").unwrap();
    let graph = check_graph_with_declared_schemas(parsed, &declared).unwrap();
    let revision = graph_revision(&graph).unwrap();
    let mut bridge = HostBackedBridge::new_with_declarations(
        &graph,
        StubHost,
        revision,
        INPUT_DIGEST,
        &declared,
    )
    .unwrap();
    let mut arguments = BTreeMap::new();
    arguments.insert("text".to_owned(), VmValue::Text("hi".to_owned()));
    let response = bridge
        .invoke("@echo", "say", &arguments, "invocation-1")
        .unwrap();
    assert_eq!(bridge.observations()[0].instance, "@echo");
    assert_eq!(
        bridge.observations()[0].operation,
        "declared:demo.echo@0.1.0.say"
    );
    assert_eq!(
        response,
        CapabilityResponse::ok(VmValue::Text("hi!".to_owned()))
    );
}
