//! WP-530: an experiment kit carrying a byte-order mark is named.
//!
//! `parse_experiment_kit` maps every parse failure to
//! `experiment-kit-json-invalid`, so a kit that opens with a UTF-8 byte-order
//! mark was called malformed JSON although its text is fine.
//!
//! A kit of `{}` gets past the JSON layer and stops on the missing fields
//! (`experiment-kit-required-field-missing`), which proves the JSON layer
//! accepts those bytes; the two documents differ only in the leading mark.

use revia_core::experiment_kit::parse_experiment_kit;

fn code(source: &str) -> String {
    match parse_experiment_kit(source) {
        Ok(_) => "accepted".to_owned(),
        Err(error) => error.code,
    }
}

#[test]
fn an_experiment_kit_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code("{}\n"),
        "experiment-kit-required-field-missing",
        "the plain kit document got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n"),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as malformed JSON"
    );

    assert_eq!(
        code("not json\n"),
        "experiment-kit-json-invalid",
        "malformed JSON keeps the reader's own code"
    );
}
