//! WP-527: an execution plan carrying a byte-order mark is named.
//!
//! `parse_project_execution_plan` parses with the shared project JSON parser and
//! passes its error code straight through, so a plan that opens with a UTF-8
//! byte-order mark was refused as `project-manifest-json-invalid` — the
//! manifest's code on a plan file.
//!
//! A plan of `{}` gets past the JSON layer and stops on the missing fields
//! (`invalid-project-field`), which proves the JSON layer accepts those bytes;
//! the two documents differ only in the leading mark.

use revia_core::project_runtime::parse_project_execution_plan;

fn code(source: &str) -> String {
    match parse_project_execution_plan(source) {
        Ok(_) => "accepted".to_owned(),
        Err(error) => error.code,
    }
}

#[test]
fn a_project_plan_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "invalid-project-field",
        "the plain plan document got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n"),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as a manifest error"
    );

    assert_eq!(
        code("not json\n"),
        "project-manifest-json-invalid",
        "malformed JSON keeps the parser code"
    );
}
