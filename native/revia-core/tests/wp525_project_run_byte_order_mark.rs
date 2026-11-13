//! WP-525: a project run document carrying a byte-order mark is named.
//!
//! `verify_project_run_serialized` parses the run document with the shared
//! project JSON parser and passes its error code straight through. That parser
//! is shared with the project manifest, so a run document that opens with a
//! UTF-8 byte-order mark was refused as `project-manifest-json-invalid` — the
//! manifest's code on a run document, a diagnosis that names the wrong file
//! and hides the real cause.
//!
//! A run document of `{}` gets past the JSON layer and stops at
//! `native-project-run-schema-mismatch`, which proves the JSON layer accepts
//! those bytes; the two documents differ only in the leading mark.

use revia_core::project_runtime::verify_project_run_serialized;

fn code(source: &str) -> String {
    verify_project_run_serialized(source)
        .expect_err("the document is not a project run")
        .code
}

#[test]
fn a_project_run_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "native-project-run-schema-mismatch",
        "the plain run document got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n"),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as a manifest error"
    );

    // Text that really is malformed keeps the parser's own code.
    assert_eq!(
        code("not json\n"),
        "project-manifest-json-invalid",
        "malformed JSON keeps the parser code"
    );
}
