//! WP-529: a comparison catalog carrying a byte-order mark is named.
//!
//! `parse_comparison_catalog` parses with the shared project JSON parser and
//! reports every parse failure as `comparison-catalog-json-invalid`, so a
//! catalog that opens with a UTF-8 byte-order mark was refused as malformed
//! JSON when its text is fine.
//!
//! A catalog of `{}` gets past the JSON layer and stops on the missing fields,
//! which proves the JSON layer accepts those bytes; the two documents differ
//! only in the leading mark.

use revia_core::comparison_catalog::parse_comparison_catalog;

fn code(source: &str) -> String {
    match parse_comparison_catalog(source) {
        Ok(_) => "accepted".to_owned(),
        Err(error) => error.code,
    }
}

#[test]
fn a_comparison_catalog_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "comparison-catalog-required-field-missing",
        "the plain catalog document got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n"),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as malformed JSON"
    );

    assert_eq!(
        code("not json\n"),
        "comparison-catalog-json-invalid",
        "malformed JSON keeps the reader's own code"
    );
}
