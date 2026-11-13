//! WP-524: a VM result carrying a byte-order mark is named.
//!
//! `build_runtime_load_receipt` reads the VM result bytes and reports every
//! failure there as `native-runtime-load-receipt-result-invalid`. A result that
//! opens with a UTF-8 byte-order mark decodes as ordinary text, so the mark was
//! filed as an invalid result — a diagnosis that sends the reader looking at
//! the result document's contents when only the leading mark is wrong.
//!
//! The plain `{}` result reaches the same code, so the JSON layer accepted those
//! bytes; with the mark in front the same document was still reported as an
//! invalid result rather than as a marked document.

use revia_core::{
    runtime_authority::RuntimeLoadAuthorityPin, runtime_receipt::build_runtime_load_receipt,
};

fn pin() -> RuntimeLoadAuthorityPin {
    RuntimeLoadAuthorityPin {
        schema: "re.native-runtime-load-authority@0.1.0".to_owned(),
        reviewed_source_digest: "sha256:00".to_owned(),
        graph_revision: "1".to_owned(),
        build_artifact_digest: "sha256:00".to_owned(),
        reviewed_bundle_digest: "sha256:00".to_owned(),
        loaded_bytes_digest: "sha256:00".to_owned(),
        runtime: "revia-vm".to_owned(),
        command: "run".to_owned(),
        environment_input_digest:
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
        hash_algorithm: "sha256".to_owned(),
        canonicalization: "revia.canonical-json@1".to_owned(),
        load_process: "revia-vm-run@1".to_owned(),
        pin_digest: "sha256:00".to_owned(),
    }
}

fn code(result: &[u8]) -> String {
    build_runtime_load_receipt(&pin(), result, b"")
        .expect_err("the result is not a VM result")
        .code
}

#[test]
fn a_vm_result_with_a_byte_order_mark_is_refused_as_a_mark() {
    assert_eq!(
        code(b"{}\n"),
        "native-runtime-load-receipt-result-invalid",
        "the plain result got past the JSON layer"
    );

    assert_eq!(
        code("\u{feff}{}\n".as_bytes()),
        "byte-order-mark-not-allowed",
        "the mark is named, not reported as an invalid result"
    );

    // The result class still belongs to text that really is malformed.
    assert_eq!(
        code(b"not json\n"),
        "native-runtime-load-receipt-result-invalid",
        "malformed JSON keeps its own code"
    );
}
