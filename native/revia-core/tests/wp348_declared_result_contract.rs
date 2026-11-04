// WP-348: the registry carries the declared result contract.
//
// WP-347 projected identity, revision, member names, parameter names and
// parameter types. That is enough to admit a call at check time, and nothing
// else: a runtime that dispatches on the declaration also needs to know what
// the member returns and which error variants its failure can name.
//
// This file pins the second half of the projection — `returns` and the
// variants of the family it names in the definition's `types` table — in the
// same artifact shape the Node registry already validates
// (`src/host/schema-registry.js`) and the demo definitions already use
// (`src/host/demo-schema.js`).
//
// What stays closed on purpose: no runtime dispatch reads these fields yet.
// The four hard-coded runtime sites still reject every declared member, so a
// graph admitted through a registry is still closed at the host boundary until
// the dispatch slice. `access` rules and resource catalogs stay out of the
// projection.

use revia_core::{
    graph::{
        DeclaredMember, DeclaredSchema, GraphError, check_graph_with_declared_schemas,
        parse_compact_graph, validate_declarations,
    },
    host_schema_registry::{REGISTRY_SCHEMA, parse_registry, render_registry},
};

const DECLARED_SOURCE: &str = r#"re 0.1 compact
// Declared schema, named argument.

unit @declared

cap @echo: demo.echo@0.1.0

fn @main() -> process.status {
  %echoed = @echo.say(text: "hello")
  return match %echoed {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

fn registry(definitions: &str) -> String {
    format!(r#"{{"definitions":[{definitions}],"schema":"{REGISTRY_SCHEMA}"}}"#)
}

/// A definition whose single member declares a result with two variants.
fn result_registry() -> String {
    registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":["unavailable","refused"]}}}"#,
    )
}

fn registry_error(source: &str) -> GraphError {
    parse_registry(source).expect_err("registry is rejected")
}

fn programmatic(reference: &str, members: Vec<DeclaredMember>) -> Vec<DeclaredSchema> {
    vec![DeclaredSchema {
        reference: reference.to_owned(),
        members,
    }]
}

fn member(name: &str, returns: Option<&str>, errors: &[&str]) -> DeclaredMember {
    DeclaredMember {
        name: name.to_owned(),
        parameters: vec![("text".to_owned(), "text.utf8".to_owned())],
        returns: returns.map(str::to_owned),
        errors: errors.iter().map(|variant| (*variant).to_owned()).collect(),
    }
}

#[test]
fn the_result_contract_is_projected_from_the_artifact() {
    let declared = parse_registry(&result_registry()).unwrap();
    assert_eq!(
        declared,
        vec![DeclaredSchema {
            reference: "demo.echo@0.1.0".to_owned(),
            members: vec![DeclaredMember {
                name: "say".to_owned(),
                parameters: vec![("text".to_owned(), "text.utf8".to_owned())],
                returns: Some("result<text.utf8, demo.echo_error>".to_owned()),
                errors: vec!["unavailable".to_owned(), "refused".to_owned()],
            }],
        }]
    );
    // The check phase still admits the graph: the new fields add vocabulary,
    // they do not change argument or return checking.
    let graph = parse_compact_graph(DECLARED_SOURCE, "test.re").unwrap();
    check_graph_with_declared_schemas(graph, &declared).expect("declared call is admitted");
}

#[test]
fn a_plain_return_type_is_carried_without_an_error_family() {
    let declared = parse_registry(&registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"text.utf8"}},"revision":"0.1.0"}"#,
    ))
    .unwrap();
    assert_eq!(declared[0].members[0].returns.as_deref(), Some("text.utf8"));
    assert!(declared[0].members[0].errors.is_empty());
}

#[test]
fn an_absent_return_type_stays_absent() {
    let declared = parse_registry(&registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0"}"#,
    ))
    .unwrap();
    assert_eq!(declared[0].members[0].returns, None);
    assert!(declared[0].members[0].errors.is_empty());
}

#[test]
fn a_family_without_a_types_entry_keeps_an_empty_variant_list() {
    // A producer may name a family it does not define here (an imported
    // definition, a family living in another definition's `types`). The
    // reference is carried; the variant list stays empty rather than guessed.
    let declared = parse_registry(&registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0"}"#,
    ))
    .unwrap();
    assert_eq!(
        declared[0].members[0].returns.as_deref(),
        Some("result<text.utf8, demo.echo_error>")
    );
    assert!(declared[0].members[0].errors.is_empty());
}

#[test]
fn malformed_result_contracts_are_rejected() {
    let cases = [
        // `returns` must be a non-empty string.
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":5}},"revision":"0.1.0"}"#,
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":""}},"revision":"0.1.0"}"#,
        // `types` must be an object.
        r#"{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0","types":5}"#,
        // The family entry must be an error sum.
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"product","variants":["a"]}}}"#,
        // Its variants must be a list of non-empty strings.
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":"a"}}}"#,
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":["a",""]}}}"#,
        // An empty variant list would vanish through rendering.
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":[]}}}"#,
        // A `types` entry no member names would be dropped by rendering.
        r#"{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":["a"]}}}"#,
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"result<text.utf8, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.other_error":{"kind":"error-sum","variants":["a"]}}}"#,
    ];
    for case in cases {
        let error = registry_error(&registry(case));
        assert_eq!(error.code, "declared-schema-registry-invalid", "{case}");
        assert!(error.actual.is_some(), "{case}");
    }
}

#[test]
fn a_programmatic_declaration_is_held_to_the_same_result_shape() {
    let validate = |declared: &[DeclaredSchema]| {
        validate_declarations(declared)
            .expect_err("declaration is rejected")
            .code
    };
    let invalid = "declared-schema-invalid";
    // A result type with an empty half.
    assert_eq!(
        validate(&programmatic(
            "demo.echo@0.1.0",
            vec![member("say", Some("result<>"), &[])]
        )),
        invalid
    );
    // A bare result with no error half.
    assert_eq!(
        validate(&programmatic(
            "demo.echo@0.1.0",
            vec![member("say", Some("result<text.utf8>"), &[])]
        )),
        invalid
    );
    // An error family next to a plain return type.
    assert_eq!(
        validate(&programmatic(
            "demo.echo@0.1.0",
            vec![member("say", Some("text.utf8"), &["refused"])]
        )),
        invalid
    );
    // An error family with no return type at all.
    assert_eq!(
        validate(&programmatic(
            "demo.echo@0.1.0",
            vec![member("say", None, &["refused"])]
        )),
        invalid
    );
    // Empty, duplicated, or ill-formed variant names.
    for errors in [
        &[""][..],
        &["refused", "refused"][..],
        &["two words"][..],
        &["bad@variant"][..],
    ] {
        assert_eq!(
            validate(&programmatic(
                "demo.echo@0.1.0",
                vec![member(
                    "say",
                    Some("result<text.utf8, demo.echo_error>"),
                    errors
                )]
            )),
            invalid
        );
    }
    // A result string with a third half is not a result.
    assert_eq!(
        validate(&programmatic(
            "demo.echo@0.1.0",
            vec![member(
                "say",
                Some("result<text.utf8, demo.echo_error, extra>"),
                &[]
            )]
        )),
        invalid
    );
}

#[test]
fn a_generic_ok_half_stays_one_half() {
    // Splitting on the first comma would read `list<text.utf8>` as ok and
    // `demo.echo_error>` as the family; the split respects angle brackets.
    let source = registry(
        r#"{"identity":"demo.echo","members":{"list":{"params":[],"returns":"result<list<text.utf8>, demo.echo_error>"}},"revision":"0.1.0","types":{"demo.echo_error":{"kind":"error-sum","variants":["refused"]}}}"#,
    );
    let declared = parse_registry(&source).unwrap();
    assert_eq!(
        declared[0].members[0].returns.as_deref(),
        Some("result<list<text.utf8>, demo.echo_error>")
    );
    assert_eq!(declared[0].members[0].errors, vec!["refused".to_string()]);
    validate_declarations(&declared).expect("generic ok half is a valid result");
    assert_eq!(
        parse_registry(&render_registry(&declared).unwrap()).unwrap(),
        declared
    );
}

#[test]
fn members_sharing_a_family_must_agree_on_its_variants() {
    let declared = programmatic(
        "demo.echo@0.1.0",
        vec![
            member(
                "say",
                Some("result<text.utf8, demo.echo_error>"),
                &["refused"],
            ),
            member(
                "shout",
                Some("result<text.utf8, demo.echo_error>"),
                &["refused", "unavailable"],
            ),
        ],
    );
    assert_eq!(
        validate_declarations(&declared).unwrap_err().code,
        "declared-schema-invalid"
    );
    // Agreeing members are accepted.
    let agreed = programmatic(
        "demo.echo@0.1.0",
        vec![
            member(
                "say",
                Some("result<text.utf8, demo.echo_error>"),
                &["refused"],
            ),
            member(
                "shout",
                Some("result<text.utf8, demo.echo_error>"),
                &["refused"],
            ),
        ],
    );
    validate_declarations(&agreed).expect("shared family agrees");
}

#[test]
fn rendered_artifact_round_trips_the_result_contract() {
    let source = result_registry();
    let declared = parse_registry(&source).unwrap();
    let rendered = render_registry(&declared).unwrap();
    assert!(
        rendered.contains(r#""returns":"result<text.utf8, demo.echo_error>""#),
        "{rendered}"
    );
    assert!(rendered.contains(r#""kind":"error-sum""#), "{rendered}");
    assert!(
        rendered.contains(r#""variants":["unavailable","refused"]"#),
        "{rendered}"
    );
    // Byte stability: rendering the parsed artifact twice is identical, and
    // re-parsing the rendered form preserves every field.
    assert_eq!(render_registry(&declared).unwrap(), rendered);
    assert_eq!(parse_registry(&rendered).unwrap(), declared);
}

#[test]
fn rendered_artifact_omits_types_when_no_error_family_is_declared() {
    let declared = parse_registry(&registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[],"returns":"text.utf8"}},"revision":"0.1.0"}"#,
    ))
    .unwrap();
    let rendered = render_registry(&declared).unwrap();
    assert!(rendered.contains(r#""returns":"text.utf8""#), "{rendered}");
    assert!(!rendered.contains(r#""types""#), "{rendered}");
    assert_eq!(parse_registry(&rendered).unwrap(), declared);
}
