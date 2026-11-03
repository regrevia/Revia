// WP-346: check-time admission of a declared schema.
//
// `doc/12-library-strategy.md` §6 item 1 asks for a registry whose declaration
// drives every closed match site. This file covers the check-time half only:
// the allowlist, the member table, and the argument names/types. The four
// runtime sites stay closed, so a graph admitted here is still rejected by the
// host bridge; that boundary is asserted in `wp345_library_admission_boundary.rs`.
// WP-347 adds the registry artifact format around this same declaration list and
// leaves the runtime sites closed, so it does not widen what this file proves.
//
// Scope limits that keep this honest:
// - source uses named arguments, because positional argument naming happens in
//   the parser (`graph::default_argument_name`), which cannot see declarations
//   yet. That gate is site 3 in doc/12 blocker 1 and is still closed.
// - the declaration widens the vocabulary and can never shadow a built-in
//   reference.

use revia_core::graph::{
    DeclaredMember, DeclaredSchema, Graph, check_graph, check_graph_with_declared_schemas,
    parse_compact_graph,
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

const UNDECLARED_MEMBER_SOURCE: &str = r#"re 0.1 compact
// Declared schema reference, member the declaration does not list.

unit @declared

cap @echo: demo.echo@0.1.0

fn @main() -> process.status {
  %echoed = @echo.shout(text: "hello")
  return match %echoed {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

const WRONG_ARITY_SOURCE: &str = r#"re 0.1 compact
// Declared member called with two arguments.

unit @declared

cap @echo: demo.echo@0.1.0

fn @main() -> process.status {
  %echoed = @echo.say(text: "hello", extra: "there")
  return match %echoed {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

const WRONG_TYPE_SOURCE: &str = r#"re 0.1 compact
// Declared member called with text where the declaration says int.

unit @declared

cap @echo: demo.echo@0.1.0

fn @main() -> process.status {
  %echoed = @echo.say(count: "hello")
  return match %echoed {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;

fn echo_schema() -> DeclaredSchema {
    DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members: vec![DeclaredMember {
            name: "say".to_owned(),
            parameters: vec![("text".to_owned(), "text.utf8".to_owned())],
            returns: None,
            errors: Vec::new(),
        }],
    }
}

fn parse(source: &str) -> Graph {
    parse_compact_graph(source, "declared.re").expect("source parses")
}

#[test]
fn declared_schema_and_member_pass_check() {
    let declared = [echo_schema()];
    let checked = check_graph_with_declared_schemas(parse(DECLARED_SOURCE), &declared)
        .expect("declared schema is admitted");
    assert_eq!(checked.capabilities.len(), 1);
    assert_eq!(checked.capabilities[0].reference, "demo.echo@0.1.0");
}

#[test]
fn undeclared_schema_still_fails_closed_with_the_same_code() {
    let error = check_graph(parse(DECLARED_SOURCE)).expect_err("vocabulary stays closed");
    assert_eq!(error.code, "unknown-schema-reference");
    assert_eq!(error.actual.as_deref(), Some("demo.echo@0.1.0"));
}

#[test]
fn declared_reference_with_undeclared_member_still_fails_closed() {
    let declared = [echo_schema()];
    let error = check_graph_with_declared_schemas(parse(UNDECLARED_MEMBER_SOURCE), &declared)
        .expect_err("member table stays closed");
    assert_eq!(error.code, "unknown-capability-member");
}

#[test]
fn declared_member_arity_is_enforced_from_the_declaration() {
    let declared = [echo_schema()];
    let error = check_graph_with_declared_schemas(parse(WRONG_ARITY_SOURCE), &declared)
        .expect_err("arity comes from the declaration");
    assert_eq!(error.code, "argument-count-mismatch");
}

#[test]
fn declared_member_argument_types_are_enforced_from_the_declaration() {
    let declared = [DeclaredSchema {
        reference: "demo.echo@0.1.0".to_owned(),
        members: vec![DeclaredMember {
            name: "say".to_owned(),
            parameters: vec![("count".to_owned(), "int".to_owned())],
            returns: None,
            errors: Vec::new(),
        }],
    }];
    let error = check_graph_with_declared_schemas(parse(WRONG_TYPE_SOURCE), &declared)
        .expect_err("argument types come from the declaration");
    assert_eq!(error.code, "literal-type-mismatch");
    assert_eq!(error.actual.as_deref(), Some("text.utf8"));
    assert_eq!(error.expected.as_deref(), Some("int"));
}

#[test]
fn declaration_cannot_shadow_a_built_in_reference() {
    let declared = [DeclaredSchema {
        reference: "process.stdout@0.1.0".to_owned(),
        members: vec![DeclaredMember {
            name: "write".to_owned(),
            parameters: vec![("data".to_owned(), "bytes".to_owned())],
            returns: None,
            errors: Vec::new(),
        }],
    }];
    let error = check_graph_with_declared_schemas(parse(DECLARED_SOURCE), &declared)
        .expect_err("built-ins keep their own meaning");
    assert_eq!(error.code, "declared-schema-invalid");
}

#[test]
fn duplicate_or_empty_declarations_are_rejected_before_the_graph_is_read() {
    let duplicated = [echo_schema(), echo_schema()];
    let error = check_graph_with_declared_schemas(parse(DECLARED_SOURCE), &duplicated)
        .expect_err("a reference is declared once");
    assert_eq!(error.code, "declared-schema-invalid");

    let empty_members = [DeclaredSchema {
        reference: "demo.empty@0.1.0".to_owned(),
        members: Vec::new(),
    }];
    let error = check_graph_with_declared_schemas(parse(DECLARED_SOURCE), &empty_members)
        .expect_err("a schema with no members admits nothing");
    assert_eq!(error.code, "declared-schema-invalid");
    assert_eq!(error.actual.as_deref(), Some("demo.empty@0.1.0"));
}

#[test]
fn built_in_graphs_still_check_with_an_empty_declaration_list() {
    let graph = parse(include_str!("../../../examples/hello.re"));
    let checked =
        check_graph_with_declared_schemas(graph, &[]).expect("built-in vocabulary is unaffected");
    assert_eq!(checked.capabilities[0].reference, "process.stdout@0.1.0");
}
