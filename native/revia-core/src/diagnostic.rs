use crate::canonical_json::quote;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub schema: String,
    pub severity: String,
    pub file: String,
    pub code: String,
    pub phase: String,
    pub rule: String,
    pub byte_start: Option<usize>,
    pub byte_end: Option<usize>,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub lexeme: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub repair: Option<String>,
}

impl Diagnostic {
    pub fn new(
        source: &str,
        file: &str,
        code: &str,
        phase: &str,
        rule: &str,
        start: usize,
        end: usize,
    ) -> Self {
        let start = start.min(source.len());
        let end = end.max(start).min(source.len());
        let (line, column) = position_at(source, start);
        let (end_line, end_column) = position_at(source, end);
        Self {
            schema: "re.source-diagnostic@0.1.0".to_owned(),
            severity: "error".to_owned(),
            file: file.to_owned(),
            code: code.to_owned(),
            phase: phase.to_owned(),
            rule: rule.to_owned(),
            byte_start: Some(start),
            byte_end: Some(end),
            line,
            column,
            end_line,
            end_column,
            lexeme: source[start..end].to_owned(),
            expected: None,
            actual: None,
            repair: None,
        }
    }

    pub fn from_invalid_bytes(file: &str, code: &str, offset: usize) -> Self {
        Self {
            schema: "re.source-diagnostic@0.1.0".to_owned(),
            severity: "error".to_owned(),
            file: file.to_owned(),
            code: code.to_owned(),
            phase: "source".to_owned(),
            rule: "source.utf8".to_owned(),
            byte_start: Some(offset),
            byte_end: Some(offset + 1),
            line: 1,
            column: 1,
            end_line: 1,
            end_column: 1,
            lexeme: String::new(),
            expected: None,
            actual: None,
            repair: Some("inspect".to_owned()),
        }
    }

    pub fn with_expected(mut self, expected: impl Into<String>) -> Self {
        self.expected = Some(expected.into());
        self
    }

    pub fn with_actual(mut self, actual: impl Into<String>) -> Self {
        self.actual = Some(actual.into());
        self
    }

    pub fn with_repair(mut self, repair: impl Into<String>) -> Self {
        self.repair = Some(repair.into());
        self
    }

    pub fn to_json(&self) -> String {
        let mut fields = vec![
            format!("\"byte_end\":{}", self.byte_end.unwrap_or(0)),
            format!("\"byte_start\":{}", self.byte_start.unwrap_or(0)),
            format!("\"code\":{}", quote(&self.code)),
            format!("\"column\":{}", self.column),
            format!("\"end_column\":{}", self.end_column),
            format!("\"end_line\":{}", self.end_line),
            format!("\"file\":{}", quote(&self.file)),
            format!("\"lexeme\":{}", quote(&self.lexeme)),
            format!("\"line\":{}", self.line),
            format!("\"phase\":{}", quote(&self.phase)),
            format!(
                "\"repair\":{}",
                quote(self.repair.as_deref().unwrap_or("inspect"))
            ),
            format!("\"rule\":{}", quote(&self.rule)),
            format!("\"schema\":{}", quote(&self.schema)),
            format!("\"severity\":{}", quote(&self.severity)),
        ];
        if let Some(expected) = &self.expected {
            fields.push(format!("\"expected\":{}", quote(expected)));
        }
        if let Some(actual) = &self.actual {
            fields.push(format!("\"actual\":{}", quote(actual)));
        }
        format!("{{{}}}", fields.join(","))
    }
}

pub fn position_at(source: &str, byte_offset: usize) -> (usize, usize) {
    let offset = byte_offset.min(source.len());
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let line_start = prefix.rfind('\n').map(|index| index + 1).unwrap_or(0);
    let column = source[line_start..offset].chars().count() + 1;
    (line, column)
}
