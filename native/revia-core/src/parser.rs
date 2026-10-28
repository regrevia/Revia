use crate::{
    diagnostic::Diagnostic,
    lexer::{Token, TokenKind, decode_json_string, tokenize},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedProgram {
    pub unit: String,
    pub capabilities: Vec<Capability>,
    pub tokens: Vec<Token>,
    pub statement_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capability {
    pub instance: String,
    pub reference: String,
}

pub fn tokenize_source(source: &str, file: &str) -> Result<Vec<Token>, Diagnostic> {
    let header = parse_header(source, file)?;
    if header.kind != "compact" {
        return Err(Diagnostic::new(
            source,
            file,
            "unexpected-source-form",
            "dispatch",
            "header.source-form",
            0,
            header.header_end,
        )
        .with_expected("compact")
        .with_actual(header.kind));
    }
    tokenize(
        &source[header.body_offset..],
        source,
        file,
        header.body_offset,
        2,
    )
}

pub fn parse_source(source: &str, file: &str) -> Result<ParsedProgram, Diagnostic> {
    let tokens = tokenize_source(source, file)?;
    let mut cursor = Cursor {
        source,
        file,
        tokens: tokens.clone(),
        index: 0,
    };
    cursor.expect("unit")?;
    let unit = cursor.take("unit identity")?.text;
    let mut capabilities = Vec::new();
    while cursor.peek().text == "cap" {
        cursor.expect("cap")?;
        let instance = cursor.take("capability instance")?.text;
        cursor.expect(":")?;
        let reference = cursor.take("schema reference")?.text;
        capabilities.push(Capability {
            instance,
            reference,
        });
    }
    cursor.expect("fn")?;
    cursor.take("function name")?;
    cursor.expect("(")?;
    cursor.expect(")")?;
    cursor.expect("->")?;
    cursor.take("return type")?;
    cursor.expect("{")?;
    let mut statement_count = 0;
    while cursor.peek().text != "}" {
        if cursor.peek().kind == TokenKind::End {
            return Err(cursor.failure(cursor.peek(), "}", "unexpected-token"));
        }
        if cursor.peek().text.starts_with('%') {
            cursor.take("value binding")?;
            cursor.expect("=")?;
            parse_call(&mut cursor, &capabilities)?;
        } else if cursor.peek().text == "return" {
            cursor.expect("return")?;
            parse_match(&mut cursor, &capabilities)?;
        } else {
            return Err(cursor.failure(
                cursor.peek(),
                "let or return statement",
                "unexpected-token",
            ));
        }
        statement_count += 1;
    }
    cursor.expect("}")?;
    cursor.expect_end()?;
    Ok(ParsedProgram {
        unit,
        capabilities,
        tokens,
        statement_count,
    })
}

struct Header {
    body_offset: usize,
    header_end: usize,
    kind: String,
}

fn parse_header(source: &str, file: &str) -> Result<Header, Diagnostic> {
    let newline = source.find('\n');
    let header_end = newline.unwrap_or(source.len());
    let header = &source[..header_end];
    if !header.starts_with("re ") {
        return Err(Diagnostic::new(
            source,
            file,
            "missing-grammar-header",
            "header",
            "header.required",
            0,
            header_end,
        )
        .with_expected("re 0.1 compact | re 0.1 canonical")
        .with_actual(header));
    }
    let parts = header.split(' ').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "re" || (parts[2] != "compact" && parts[2] != "canonical") {
        return Err(Diagnostic::new(
            source,
            file,
            "invalid-grammar-header",
            "header",
            "header.shape",
            0,
            header_end,
        )
        .with_expected("re <major>.<minor> compact | re <major>.<minor> canonical")
        .with_actual(header));
    }
    if parts[1] != "0.1" {
        let start = source.find(parts[1]).unwrap_or(0);
        return Err(Diagnostic::new(
            source,
            file,
            "unsupported-language-version",
            "header",
            "header.language-version",
            start,
            start + parts[1].len(),
        )
        .with_expected("0.1")
        .with_actual(parts[1]));
    }
    if newline.is_none() {
        return Err(Diagnostic::new(
            source,
            file,
            "invalid-grammar-header",
            "header",
            "header.line-ending",
            0,
            header_end,
        )
        .with_expected("header terminated by LF"));
    }
    Ok(Header {
        body_offset: header_end + 1,
        header_end,
        kind: parts[2].to_owned(),
    })
}

fn parse_match(cursor: &mut Cursor<'_>, capabilities: &[Capability]) -> Result<(), Diagnostic> {
    cursor.expect("match")?;
    let input = cursor.take("matched value")?;
    expect_alias(cursor, &input)?;
    cursor.expect("{")?;
    while cursor.peek().text != "}" {
        cursor.take("match variant")?;
        cursor.expect("(")?;
        cursor.expect("_")?;
        cursor.expect(")")?;
        cursor.expect("=>")?;
        parse_call(cursor, capabilities)?;
    }
    cursor.expect("}")?;
    Ok(())
}

fn parse_call(cursor: &mut Cursor<'_>, capabilities: &[Capability]) -> Result<(), Diagnostic> {
    let operation = cursor.take("operation call")?;
    let operation_text = operation.text.as_str();
    let is_capability =
        operation_text.starts_with('@') && operation_text.rfind('.').is_some_and(|index| index > 1);
    let is_exit = operation_text == "process.exit";
    if !is_capability && !is_exit {
        let expected = if operation_text.starts_with('@') {
            "@instance.member"
        } else {
            "process.exit"
        };
        return Err(cursor.failure(&operation, expected, "unexpected-token"));
    }
    if is_capability {
        let instance = &operation_text[..operation_text.rfind('.').unwrap()];
        let schema_reference = capabilities
            .iter()
            .find(|capability| capability.instance == instance)
            .map(|capability| capability.reference.as_str());
        let member = operation_text.rsplit('.').next();
        cursor.expect("(")?;
        if cursor.peek().text != ")" {
            loop {
                let first = cursor.take("call argument")?;
                let argument_name = if cursor.peek().text == ":" {
                    cursor.expect(":")?;
                    Some(first.text.clone())
                } else {
                    None
                };
                let value = if argument_name.is_some() {
                    cursor.take("call argument")?
                } else {
                    first
                };
                parse_literal(
                    &value,
                    schema_reference,
                    member,
                    operation_text,
                    argument_name.as_deref(),
                    cursor,
                )?;
                if cursor.peek().text != "," {
                    break;
                }
                cursor.expect(",")?;
                if cursor.peek().text == ")" {
                    return Err(cursor.failure(cursor.peek(), "call argument", "unexpected-token"));
                }
            }
        }
        cursor.expect(")")?;
        return Ok(());
    }
    cursor.expect("(")?;
    if cursor.peek().text != ")" {
        loop {
            let first = cursor.take("call argument")?;
            let argument_name = if cursor.peek().text == ":" {
                cursor.expect(":")?;
                Some(first.text.clone())
            } else {
                None
            };
            let value = if argument_name.is_some() {
                cursor.take("call argument")?
            } else {
                first
            };
            parse_literal(
                &value,
                None,
                None,
                operation_text,
                argument_name.as_deref(),
                cursor,
            )?;
            if cursor.peek().text != "," {
                break;
            }
            cursor.expect(",")?;
            if cursor.peek().text == ")" {
                return Err(cursor.failure(cursor.peek(), "call argument", "unexpected-token"));
            }
        }
    }
    cursor.expect(")")?;
    Ok(())
}

fn parse_literal(
    token: &Token,
    schema_reference: Option<&str>,
    member: Option<&str>,
    operation: &str,
    argument_name: Option<&str>,
    cursor: &Cursor<'_>,
) -> Result<(), Diagnostic> {
    if token.kind == TokenKind::String {
        let value = decode_json_string(&token.text).unwrap_or_default();
        if operation == "process.exit" {
            return Err(cursor.failure(token, "process exit code integer", "unexpected-token"));
        }
        if schema_reference == Some("fs.write@0.1.0")
            && member == Some("write_file")
            && argument_name == Some("data")
            && !is_canonical_bytes(&value)
        {
            return Err(cursor.failure(
                token,
                "bytes literal hex:<lowercase-even-hex>",
                "invalid-bytes-literal",
            ));
        }
        return Ok(());
    }
    if schema_reference == Some("fs.read@0.1.0")
        && member == Some("read_file")
        && argument_name == Some("encoding")
    {
        if token.text != "text.encoding.utf8" {
            return Err(cursor.failure(token, "text.encoding.utf8", "unsupported-text-encoding"));
        }
        return Ok(());
    }
    if looks_like_numeric(&token.text) {
        if is_negative_zero(&token.text) || (!is_integer(&token.text) && !is_decimal(&token.text)) {
            return Err(cursor.failure(
                token,
                "canonical int or fixed-scale decimal",
                "invalid-numeric-literal",
            ));
        }
        if let Some(scale) = decimal_scale(&token.text)
            && scale > 255
        {
            return Err(cursor.failure(
                token,
                "decimal scale 1..255",
                "decimal-scale-out-of-range",
            ));
        }
        return Ok(());
    }
    Err(cursor.failure(token, "literal", "unexpected-token"))
}

fn expect_alias(cursor: &Cursor<'_>, token: &Token) -> Result<(), Diagnostic> {
    if token.kind != TokenKind::Atom || !token.text.starts_with('%') {
        return Err(cursor.failure(
            token,
            "compact alias not starting with %u",
            "unexpected-token",
        ));
    }
    if token.text.starts_with("%u") {
        return Err(cursor.failure(
            token,
            "compact alias not starting with %u",
            "reserved-canonical-label",
        ));
    }
    Ok(())
}

fn is_integer(value: &str) -> bool {
    let digits = if let Some(rest) = value.strip_prefix('-') {
        rest
    } else {
        value
    };
    !digits.is_empty()
        && digits.chars().all(|character| character.is_ascii_digit())
        && !(digits.len() > 1 && digits.starts_with('0'))
}

fn looks_like_numeric(value: &str) -> bool {
    value.chars().next().is_some_and(|character| {
        character == '+' || character == '-' || character == '.' || character.is_ascii_digit()
    })
}

fn is_negative_zero(value: &str) -> bool {
    value.strip_prefix('-').is_some_and(|rest| {
        rest == "0"
            || (rest.starts_with("0.") && rest[2..].chars().all(|character| character == '0'))
    })
}

fn is_decimal(value: &str) -> bool {
    let Some((whole, fraction)) = value.split_once('.') else {
        return false;
    };
    let whole = whole.strip_prefix('-').unwrap_or(whole);
    !whole.is_empty()
        && !fraction.is_empty()
        && whole.chars().all(|c| c.is_ascii_digit())
        && fraction.chars().all(|c| c.is_ascii_digit())
        && !(whole.len() > 1 && whole.starts_with('0'))
}

fn decimal_scale(value: &str) -> Option<usize> {
    value.split_once('.').map(|(_, fraction)| fraction.len())
}

fn is_canonical_bytes(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("hex:") else {
        return false;
    };
    !hex.is_empty()
        && hex.len() % 2 == 0
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

struct Cursor<'a> {
    source: &'a str,
    file: &'a str,
    tokens: Vec<Token>,
    index: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn take(&mut self, expected: &str) -> Result<Token, Diagnostic> {
        let token = self.peek().clone();
        if token.kind == TokenKind::End {
            return Err(self.failure(&token, expected, "unexpected-token"));
        }
        self.index += 1;
        Ok(token)
    }

    fn expect(&mut self, text: &str) -> Result<Token, Diagnostic> {
        let token = self.peek().clone();
        if token.text != text {
            return Err(self.failure(&token, text, "unexpected-token"));
        }
        self.index += 1;
        Ok(token)
    }

    fn expect_end(&self) -> Result<(), Diagnostic> {
        let token = self.peek();
        if token.kind != TokenKind::End {
            return Err(self.failure(token, "end of file", "unexpected-token"));
        }
        Ok(())
    }

    fn failure(&self, token: &Token, expected: &str, code: &str) -> Diagnostic {
        Diagnostic::new(
            self.source,
            self.file,
            code,
            "parse",
            rule_for(code),
            token.start,
            token.end,
        )
        .with_expected(expected)
        .with_actual(if token.kind == TokenKind::End {
            "end of file"
        } else {
            &token.text
        })
    }
}

fn rule_for(code: &str) -> &str {
    match code {
        "invalid-bytes-literal" => "compact.bytes-literal",
        "invalid-numeric-literal" => "compact.numeric-literal",
        "decimal-scale-out-of-range" => "compact.decimal-literal",
        "unsupported-text-encoding" => "compact.text-encoding-literal",
        "reserved-canonical-label" => "compact.alias",
        "unexpected-token" => "compact.token-role",
        _ => "compact.parse",
    }
}
