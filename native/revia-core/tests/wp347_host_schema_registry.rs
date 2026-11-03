// WP-347: the check-time schema registry artifact.
//
// `doc/12-library-strategy.md` §6 item 1 wants route H vocabulary to arrive as
// data. WP-346 opened the three check-time sites behind
// `check_graph_with_declared_schemas`; this file covers the document that
// carries those declarations, in the shape the Node registry already validates
// (`src/host/schema-registry.js`) and the checked-in demo definitions already
// use (`src/host/demo-schema.js`).
//
// What stays closed on purpose: the projection is identity, revision, member
// names, parameter names and parameter types only. Result types, error
// families, resource catalogs and access rules are read by later slices, and
// the four runtime sites still reject every declared member, so a graph
// admitted through a registry is still closed at the host boundary.

use revia_core::{
    graph::{
        DeclaredMember, DeclaredSchema, check_graph, check_graph_with_declared_schemas,
        parse_compact_graph,
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

fn echo_registry() -> String {
    registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[{"name":"text","type":"text.utf8"}]}},"revision":"0.1.0"}"#,
    )
}

fn check_error_code(source: &str, declared: &[DeclaredSchema]) -> String {
    let graph = parse_compact_graph(source, "test.re").unwrap();
    check_graph_with_declared_schemas(graph, declared)
        .unwrap_err()
        .code
}

#[test]
fn registry_artifact_is_what_admits_the_declared_schema() {
    let declared = parse_registry(&echo_registry()).unwrap();
    assert_eq!(
        declared,
        vec![DeclaredSchema {
            reference: "demo.echo@0.1.0".to_owned(),
            members: vec![DeclaredMember {
                name: "say".to_owned(),
                parameters: vec![("text".to_owned(), "text.utf8".to_owned())],
                returns: None,
                errors: Vec::new(),
            }],
        }]
    );

    // The same source, the same graph: only the registry flips the verdict.
    let graph = parse_compact_graph(DECLARED_SOURCE, "test.re").unwrap();
    assert_eq!(
        check_graph(graph).unwrap_err().code,
        "unknown-schema-reference"
    );
    let graph = parse_compact_graph(DECLARED_SOURCE, "test.re").unwrap();
    assert!(check_graph_with_declared_schemas(graph, &declared).is_ok());
}

#[test]
fn a_member_the_registry_does_not_list_is_still_rejected() {
    let declared = parse_registry(&echo_registry()).unwrap();
    let source = DECLARED_SOURCE.replace("@echo.say", "@echo.shout");
    assert_eq!(
        check_error_code(&source, &declared),
        "unknown-capability-member"
    );
}

#[test]
fn fields_outside_the_projection_are_ignored() {
    // The shape `src/host/demo-schema.js` ships: real definitions carry type
    // sums, access rules, a return type, resource metadata and parameter
    // annotations this reader does not project yet.
    let declared = parse_registry(&registry(
        r#"{
          "identity": "demo.echo",
          "revision": "0.1.0",
          "resource_catalog": [{"parent": "fs.storage", "aliases": ["fs.file"]}],
          "types": {"demo.echo_error": {"kind": "error-sum", "variants": ["io"]}},
          "members": {
            "say": {
              "access": ["read process.argv"],
              "params": [{"name": "text", "primary": true, "type": "text.utf8", "default": "x"}],
              "returns": "result<text.utf8, demo.echo_error>"
            }
          }
        }"#,
    ))
    .unwrap();
    assert_eq!(declared[0].reference, "demo.echo@0.1.0");
    assert_eq!(
        declared[0].members[0].parameters,
        vec![("text".to_owned(), "text.utf8".to_owned())]
    );
}

#[test]
fn rendered_registry_round_trips_and_is_byte_stable() {
    let declared = parse_registry(&echo_registry()).unwrap();
    let rendered = render_registry(&declared).unwrap();
    assert_eq!(parse_registry(&rendered).unwrap(), declared);
    assert_eq!(render_registry(&declared).unwrap(), rendered);
    assert!(rendered.contains(r#""schema":"revia.host-schema-definitions@0.1.0""#));
    // Canonical form: `definitions` sorts before `schema`.
    assert!(rendered.starts_with(r#"{"definitions":["#));
}

#[test]
fn an_empty_member_table_is_rejected_but_a_paramless_member_is_not() {
    assert_eq!(
        parse_registry(&registry(
            r#"{"identity":"demo.echo","members":{},"revision":"0.1.0"}"#
        ))
        .unwrap_err()
        .code,
        "declared-schema-registry-invalid"
    );
    let declared = parse_registry(&registry(
        r#"{"identity":"demo.echo","members":{"read":{"params":[]}},"revision":"0.1.0"}"#,
    ))
    .unwrap();
    assert!(declared[0].members[0].parameters.is_empty());
}

#[test]
fn malformed_artifacts_are_rejected_before_the_graph_is_read() {
    let cases = [
        // Not JSON at all.
        String::from("{"),
        // Missing or wrong schema identifier.
        String::from(r#"{"definitions":[]}"#),
        format!(r#"{{"definitions":[],"schema":"{REGISTRY_SCHEMA}.9"}}"#),
        // Unknown top-level keys are typos, not extensions.
        format!(r#"{{"definition":[],"schema":"{REGISTRY_SCHEMA}"}}"#),
        // Empty identity, identity carrying a reference separator, empty revision.
        registry(r#"{"identity":"","members":{"m":{"params":[]}},"revision":"0.1.0"}"#),
        registry(r#"{"identity":"a@b","members":{"m":{"params":[]}},"revision":"0.1.0"}"#),
        registry(r#"{"identity":"demo.echo","members":{"m":{"params":[]}},"revision":""}"#),
        // Missing members, non-object members, member without params.
        registry(r#"{"identity":"demo.echo","revision":"0.1.0"}"#),
        registry(r#"{"identity":"demo.echo","members":[],"revision":"0.1.0"}"#),
        registry(r#"{"identity":"demo.echo","members":{"m":{}},"revision":"0.1.0"}"#),
        // Parameter without a name, without a type, non-string type, duplicate key.
        registry(
            r#"{"identity":"demo.echo","members":{"m":{"params":[{"type":"text.utf8"}]}},"revision":"0.1.0"}"#,
        ),
        registry(
            r#"{"identity":"demo.echo","members":{"m":{"params":[{"name":"a"}]}},"revision":"0.1.0"}"#,
        ),
        registry(
            r#"{"identity":"demo.echo","members":{"m":{"params":[{"name":"a","type":1}]}},"revision":"0.1.0"}"#,
        ),
        registry(
            r#"{"identity":"demo.echo","identity":"demo.echo","members":{"m":{"params":[]}},"revision":"0.1.0"}"#,
        ),
    ];
    for artifact in cases {
        assert_eq!(
            parse_registry(&artifact).unwrap_err().code,
            "declared-schema-registry-invalid",
            "{artifact}"
        );
    }
}

#[test]
fn artifacts_are_validated_like_programmatic_declarations() {
    // Duplicate definitions, duplicate members, duplicate parameters and
    // built-in shadowing are semantic problems: the registry surfaces the same
    // `declared-schema-invalid` code `check_graph_with_declared_schemas` uses.
    let builtin_shadow = registry(
        r#"{"identity":"fs.read","members":{"read_file":{"params":[]}},"revision":"0.1.0"}"#,
    );
    assert_eq!(
        parse_registry(&builtin_shadow).unwrap_err().code,
        "declared-schema-invalid"
    );

    let duplicate_definition = registry(concat!(
        r#"{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0"},"#,
        r#"{"identity":"demo.echo","members":{"say":{"params":[]}},"revision":"0.1.0"}"#,
    ));
    assert_eq!(
        parse_registry(&duplicate_definition).unwrap_err().code,
        "declared-schema-invalid"
    );

    let duplicate_parameter = registry(
        r#"{"identity":"demo.echo","members":{"say":{"params":[{"name":"a","type":"text.utf8"},{"name":"a","type":"text.utf8"}]}},"revision":"0.1.0"}"#,
    );
    assert_eq!(
        parse_registry(&duplicate_parameter).unwrap_err().code,
        "declared-schema-invalid"
    );
}

#[test]
fn a_rendered_reference_without_a_separator_cannot_be_rendered() {
    let malformed = vec![DeclaredSchema {
        reference: "demo.echo".to_owned(),
        members: Vec::new(),
    }];
    assert_eq!(
        render_registry(&malformed).unwrap_err().code,
        "declared-schema-registry-invalid"
    );
}

#[test]
fn two_registries_compose_into_one_declaration_list() {
    let first = parse_registry(&echo_registry()).unwrap();
    let second = parse_registry(&registry(
        r#"{"identity":"vendor.json","members":{"encode":{"params":[{"name":"value","type":"text.utf8"}]}},"revision":"2.0.0"}"#,
    ))
    .unwrap();
    let mut combined = first;
    combined.extend(second);
    let rendered = render_registry(&combined).unwrap();
    assert_eq!(parse_registry(&rendered).unwrap().len(), 2);
    // The artifact carries identity and revision, not the joined reference.
    assert!(rendered.contains(r#""identity":"vendor.json""#));
    assert!(rendered.contains(r#""revision":"2.0.0""#));
}
