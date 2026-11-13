//! WP-528: a project run receipt carrying a byte-order mark is named.
//!
//! `parse_project_run_receipt` parses with the shared project JSON parser and
//! returns that parser's code unchanged, so a receipt that opens with a UTF-8
//! byte-order mark was refused as `project-manifest-json-invalid` — the
//! manifest's code on a receipt file.
//!
//! A receipt of `{}` gets past the JSON layer and stops on the missing fields
//! (`native-project-run-receipt-fields-invalid`), which proves the JSON layer
//! accepts those bytes; the two documents differ only in the leading mark.

use revia_core::project_receipt::parse_project_run_receipt;

fn code(source: &str) -> String {
    match parse_project_run_receipt(source) {
        Ok(_) => "accepted".to_owned(),
        Err(error) => error,
    }
}

#[test]
fn a_project_run_receipt_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "native-project-run-receipt-fields-invalid",
        "the plain receipt document got past the JSON layer"
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
