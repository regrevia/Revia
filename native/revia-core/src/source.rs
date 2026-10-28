use std::str;

use crate::diagnostic::Diagnostic;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceText {
    pub file: String,
    pub text: String,
}

impl SourceText {
    pub fn from_bytes(bytes: &[u8], file: &str) -> Result<Self, Diagnostic> {
        if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            return Err(Diagnostic::from_invalid_bytes(
                file,
                "byte-order-mark-not-allowed",
                0,
            ));
        }
        match str::from_utf8(bytes) {
            Ok(text) => Ok(Self {
                file: file.to_owned(),
                text: text.to_owned(),
            }),
            Err(error) => Err(Diagnostic::from_invalid_bytes(
                file,
                "invalid-utf8-source",
                error.valid_up_to(),
            )),
        }
    }
}
