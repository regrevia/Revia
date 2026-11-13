//! WP-523: a runtime load receipt carrying a byte-order mark is named.
//!
//! `parse_runtime_load_receipt` reported every JSON failure as
//! `native-runtime-load-receipt-json-invalid`. A receipt that opens with a
//! UTF-8 byte-order mark is valid text, so the trailing-newline check passes
//! and the mark was then filed as unreadable JSON — a diagnosis that sends the
//! reader looking for a syntax error the document does not have.
//!
//! The plain `{}` receipt is refused by the receipt's own field rules
//! (`native-runtime-load-receipt-fields-invalid`), which proves the JSON layer
//! accepted those bytes. The two documents differ only in the leading mark, so
//! only the mark can account for the different verdict.

use revia_core::runtime_receipt::parse_runtime_load_receipt;

/// A well-formed JSON document that is not a receipt: the JSON layer accepts
/// it and the receipt's own field rules refuse it.
const RECEIPT: &str = "{}\n";

fn code(source: &str) -> String {
    parse_runtime_load_receipt(source)
        .expect_err("the document is not a receipt")
        .code
}

#[test]
fn a_runtime_load_receipt_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code(RECEIPT),
        "native-runtime-load-receipt-fields-invalid",
        "the plain receipt got past the JSON layer"
    );

    let marked = format!("\u{feff}{RECEIPT}");
    assert_eq!(
        code(&marked),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as unreadable JSON"
    );

    // The JSON class still belongs to text that really is malformed.
    assert_eq!(
        code("not json\n"),
        "native-runtime-load-receipt-json-invalid",
        "malformed JSON keeps its own code"
    );
}
