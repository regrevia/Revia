//! WP-531: a runtime bundle carrying a byte-order mark is named.
//!
//! `parse_runtime_bundle` maps every parse failure to
//! `native-runtime-bundle-json-invalid`, so a bundle that opens with a UTF-8
//! byte-order mark was called malformed JSON although its text is fine. The
//! mark is named ahead of the trailing-newline gate, so a marked document is
//! named even without the newline.
//!
//! A bundle of `{}` gets past the JSON layer and stops on the fields
//! (`native-runtime-bundle-fields-invalid`), which proves the JSON layer
//! accepts those bytes; the two documents differ only in the leading mark.

use revia_core::runtime_bundle::parse_runtime_bundle;

fn code(source: &str) -> String {
    match parse_runtime_bundle(source) {
        Ok(_) => "accepted".to_owned(),
        Err(error) => error.code,
    }
}

#[test]
fn a_runtime_bundle_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "native-runtime-bundle-fields-invalid",
        "the plain bundle document got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n"),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as malformed JSON"
    );

    assert_eq!(
        code("\u{feff}"),
        "byte-order-mark-not-allowed",
        "the mark is named ahead of the trailing-newline gate"
    );

    assert_eq!(
        code("not json\n"),
        "native-runtime-bundle-json-invalid",
        "malformed JSON keeps the reader's own code"
    );
}
