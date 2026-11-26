//! The wildcard is the only branch pattern `0.1` accepts.
//!
//! `ok(%data)` / `err(%error)` are published as `0.2` work, not as a shape the
//! parser knows. Until that work lands, the refusal is what keeps a program
//! from reading as though a matched value were reachable: the branch body is an
//! effect call, `BranchNode` carries no binding, and the VM's `BranchResult`
//! moves a jump rather than a payload. A regression that let `%data` through
//! would reach a graph the checker cannot type and the VM cannot populate, so
//! the refusal is asserted here with the fields a caller sees.

use revia_core::{parser::parse_source, source::SourceText};

fn program(branches: &str) -> String {
    format!(
        r#"re 0.1 compact
unit @match_binding

cap @input: fs.read@0.1.0

fn @main() -> process.status {{
  %contents = @input.read_file("input.txt")
  return match %contents {{
{branches}
  }}
}}
"#
    )
}

fn refusal(branches: &str) -> revia_core::diagnostic::Diagnostic {
    let source = program(branches);
    parse_source(&source, "match-binding.re").expect_err("the binding form is not in the grammar")
}

#[test]
fn wildcard_branches_parse() {
    let source = program("    ok(_) => process.exit(0)\n    err(_) => process.exit(2)");
    parse_source(&source, "match-binding.re").expect("`ok(_)` / `err(_)` is the shipped shape");
}

#[test]
fn ok_binding_is_refused_at_the_wildcard_position() {
    let error = refusal("    ok(%data) => process.exit(0)\n    err(_) => process.exit(2)");
    assert_eq!(error.code, "unexpected-token");
    assert_eq!(error.phase, "parse");
    assert_eq!(error.rule, "compact.token-role");
    assert_eq!(error.lexeme, "%data");
    assert_eq!(error.expected.as_deref(), Some("_"));
    assert_eq!(error.actual.as_deref(), Some("%data"));
}

#[test]
fn err_binding_is_refused_at_the_wildcard_position() {
    let error = refusal("    ok(_) => process.exit(0)\n    err(%error) => process.exit(2)");
    assert_eq!(error.code, "unexpected-token");
    assert_eq!(error.phase, "parse");
    assert_eq!(error.rule, "compact.token-role");
    assert_eq!(error.lexeme, "%error");
    assert_eq!(error.expected.as_deref(), Some("_"));
    assert_eq!(error.actual.as_deref(), Some("%error"));
}

#[test]
fn the_refusal_is_a_parse_answer_rather_than_a_binding_diagnostic() {
    // A program the parser refuses never reaches the checker, so no graph, no
    // return type and no host decision is involved in the answer. The codes a
    // binding rule would introduce do not exist yet, and the refusal must not
    // start looking like one of them before they do.
    let error = refusal("    ok(%data) => process.exit(0)\n    err(_) => process.exit(2)");
    for absent in [
        "result-binding",
        "binding-type",
        "match-subject",
        "match-input",
        "not-a-result",
        "expected-result",
    ] {
        assert_ne!(error.code, absent);
        assert_ne!(error.rule, absent);
    }
}

#[test]
fn a_binding_form_does_not_survive_a_bom_free_redecode() {
    // The same refusal is reachable from bytes, so the shape is not an artefact
    // of how the test built the string.
    let bytes = program("    ok(%data) => process.exit(0)\n    err(_) => process.exit(2)");
    let source = SourceText::from_bytes(bytes.as_bytes(), "match-binding.re")
        .expect("the program is valid UTF-8");
    let error = parse_source(source.text.as_str(), "match-binding.re")
        .expect_err("the binding form is not in the grammar");
    assert_eq!(error.code, "unexpected-token");
    assert_eq!(error.expected.as_deref(), Some("_"));
}
