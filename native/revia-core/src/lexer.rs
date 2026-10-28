use crate::diagnostic::{Diagnostic, position_at};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Atom,
    End,
    String,
    Symbol,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub text: String,
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub column: usize,
}

pub fn tokenize(
    body: &str,
    full_source: &str,
    file: &str,
    source_offset: usize,
    start_line: usize,
) -> Result<Vec<Token>, Diagnostic> {
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < body.len() {
        let character = body[index..].chars().next().expect("valid char boundary");
        if is_ascii_trivia(character) {
            index += character.len_utf8();
            continue;
        }
        if character.is_whitespace() {
            return Err(failure(
                full_source,
                file,
                source_offset + index,
                source_offset + index + character.len_utf8(),
                "non-ascii-compact-trivia",
                "ASCII space, tab, or LF",
                "compact.trivia",
            ));
        }
        if body[index..].starts_with("//") {
            index += 2;
            while index < body.len() {
                let next = body[index..].chars().next().expect("valid char boundary");
                if next == '\n' {
                    break;
                }
                if next.is_whitespace() && !is_ascii_trivia(next) {
                    return Err(failure(
                        full_source,
                        file,
                        source_offset + index,
                        source_offset + index + next.len_utf8(),
                        "non-ascii-compact-trivia",
                        "ASCII space, tab, or LF",
                        "compact.trivia",
                    ));
                }
                index += next.len_utf8();
            }
            continue;
        }
        if body[index..].starts_with("#[") {
            return Err(failure(
                full_source,
                file,
                source_offset + index,
                source_offset + index + 2,
                "unsupported-v1-annotation",
                "annotations are deferred beyond V1",
                "compact.annotation",
            ));
        }

        let start = index;
        let symbol = if body[index..].starts_with("->") || body[index..].starts_with("=>") {
            Some(&body[index..index + 2])
        } else {
            None
        };
        if let Some(symbol) = symbol {
            index += 2;
            tokens.push(make_token(
                full_source,
                source_offset + start,
                source_offset + index,
                symbol,
                TokenKind::Symbol,
            ));
            continue;
        }
        if "(){}:,=".contains(character) {
            index += character.len_utf8();
            let text = &body[start..index];
            tokens.push(make_token(
                full_source,
                source_offset + start,
                source_offset + index,
                text,
                TokenKind::Symbol,
            ));
            continue;
        }
        if character == '"' {
            index += 1;
            let mut closed = false;
            while index < body.len() {
                let next = body[index..].chars().next().expect("valid char boundary");
                index += next.len_utf8();
                if next == '\\' {
                    if index >= body.len() {
                        break;
                    }
                    let escaped = body[index..].chars().next().expect("valid char boundary");
                    index += escaped.len_utf8();
                } else if next == '"' {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(failure(
                    full_source,
                    file,
                    source_offset + start,
                    source_offset + index,
                    "unterminated-string",
                    "\"",
                    "compact.string-literal",
                ));
            }
            let text = &body[start..index];
            if decode_json_string(text).is_none() {
                return Err(failure(
                    full_source,
                    file,
                    source_offset + start,
                    source_offset + index,
                    "invalid-string-literal",
                    "JSON string escape",
                    "compact.string-literal",
                ));
            }
            tokens.push(make_token(
                full_source,
                source_offset + start,
                source_offset + index,
                text,
                TokenKind::String,
            ));
            continue;
        }

        while index < body.len() {
            let next = body[index..].chars().next().expect("valid char boundary");
            if is_ascii_trivia(next)
                || next.is_whitespace()
                || "(){}:,=\"".contains(next)
                || body[index..].starts_with("//")
                || body[index..].starts_with("#[")
                || body[index..].starts_with("->")
                || body[index..].starts_with("=>")
            {
                break;
            }
            index += next.len_utf8();
        }
        if index == start {
            return Err(failure(
                full_source,
                file,
                source_offset + start,
                source_offset + start + character.len_utf8(),
                "invalid-character",
                "valid compact token",
                "compact.token",
            ));
        }
        let text = &body[start..index];
        tokens.push(make_token(
            full_source,
            source_offset + start,
            source_offset + index,
            text,
            TokenKind::Atom,
        ));
    }

    let end = source_offset + body.len();
    let (line, column) = position_at(full_source, end);
    let _ = start_line;
    tokens.push(Token {
        text: String::new(),
        kind: TokenKind::End,
        start: end,
        end,
        line,
        column,
    });
    Ok(tokens)
}

pub fn decode_json_string(raw: &str) -> Option<String> {
    let chars = raw.chars().collect::<Vec<_>>();
    if chars.first() != Some(&'"') || chars.last() != Some(&'"') {
        return None;
    }
    let mut output = String::new();
    let mut index = 1usize;
    while index + 1 < chars.len() {
        let character = chars[index];
        index += 1;
        if character != '\\' {
            if character <= '\u{1f}' {
                return None;
            }
            output.push(character);
            continue;
        }
        let escaped = *chars.get(index)?;
        index += 1;
        match escaped {
            '"' => output.push('"'),
            '\\' => output.push('\\'),
            '/' => output.push('/'),
            'b' => output.push('\u{08}'),
            'f' => output.push('\u{0c}'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'u' => {
                let value = decode_hex_quad(&chars, index)?;
                index += 4;
                if (0xd800..=0xdbff).contains(&value) {
                    if chars.get(index) == Some(&'\\')
                        && chars.get(index + 1) == Some(&'u')
                        && let Some(low) = decode_hex_quad(&chars, index + 2)
                        && (0xdc00..=0xdfff).contains(&low)
                    {
                        let scalar = 0x1_0000 + ((value - 0xd800) << 10) + (low - 0xdc00);
                        output.push(char::from_u32(scalar)?);
                        index += 6;
                        continue;
                    }
                    output.push('\u{fffd}');
                } else if (0xdc00..=0xdfff).contains(&value) {
                    output.push('\u{fffd}');
                } else {
                    output.push(char::from_u32(value)?);
                }
            }
            _ => return None,
        }
    }
    Some(output)
}

fn decode_hex_quad(chars: &[char], start: usize) -> Option<u32> {
    let digits = chars.get(start..start + 4)?.iter().collect::<String>();
    u32::from_str_radix(&digits, 16).ok()
}

fn make_token(full_source: &str, start: usize, end: usize, text: &str, kind: TokenKind) -> Token {
    let (line, column) = position_at(full_source, start);
    Token {
        text: text.to_owned(),
        kind,
        start,
        end,
        line,
        column,
    }
}

fn failure(
    source: &str,
    file: &str,
    start: usize,
    end: usize,
    code: &str,
    expected: &str,
    rule: &str,
) -> Diagnostic {
    Diagnostic::new(source, file, code, "lex", rule, start, end).with_expected(expected)
}

fn is_ascii_trivia(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n')
}
