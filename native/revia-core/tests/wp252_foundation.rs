use revia_core::{
    canonical_json::{JsonValue, canonicalize},
    diagnostic::Diagnostic,
    digest::sha256_hex,
    lexer::{TokenKind, tokenize},
    parser::parse_source,
    source::SourceText,
};

#[test]
fn sha256_matches_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn canonical_json_sorts_object_keys_and_escapes_strings() {
    let value = JsonValue::Object(vec![
        ("z".to_owned(), JsonValue::String("line\n".to_owned())),
        ("a".to_owned(), JsonValue::Bool(true)),
    ]);
    assert_eq!(canonicalize(&value), r#"{"a":true,"z":"line\n"}"#);
}

#[test]
fn source_text_rejects_bom_and_reports_invalid_utf8() {
    let bom = SourceText::from_bytes(b"\xef\xbb\xbf re 0.1 compact\n", "bom.re").unwrap_err();
    assert_eq!(bom.code, "byte-order-mark-not-allowed");

    let invalid = SourceText::from_bytes(b"re 0.1 compact\n\xff", "invalid.re").unwrap_err();
    assert_eq!(invalid.code, "invalid-utf8-source");
    assert_eq!(invalid.byte_start, Some(15));
}

#[test]
fn diagnostic_positions_use_utf8_bytes_and_unicode_scalars() {
    let source = "re 0.1 compact\n// 中\nunit";
    let diagnostic =
        Diagnostic::new(source, "position.re", "x", "lex", "rule", 18, 21).with_actual("x");
    assert_eq!(diagnostic.byte_start, Some(18));
    assert_eq!(diagnostic.line, 2);
    assert_eq!(diagnostic.column, 4);
}

#[test]
fn compact_lexer_preserves_tokens_and_rejects_non_ascii_trivia() {
    let source = "re 0.1 compact\nunit @x // 注释\n";
    let body = source.split_once('\n').unwrap().1;
    let tokens = tokenize(body, source, "lexer.re", 16, 2).unwrap();
    assert_eq!(tokens[0].text, "unit");
    assert_eq!(tokens[1].kind, TokenKind::Atom);
    assert_eq!(tokens[1].start, 21);
    assert_eq!(tokens.last().unwrap().kind, TokenKind::End);

    let bad = "unit\u{00a0}@x";
    let error = tokenize(bad, bad, "bad.re", 0, 1).unwrap_err();
    assert_eq!(error.code, "non-ascii-compact-trivia");
    assert_eq!(error.phase, "lex");
}

#[test]
fn compact_lexer_matches_json_string_escape_boundaries() {
    let escaped_pair = r#"re 0.1 compact
unit @x
cap @stdout: process.stdout@0.1.0
fn @main() -> process.status { %x = @stdout.write("\ud83d\ude00") }
"#;
    assert!(parse_source(escaped_pair, "escaped-pair.re").is_ok());

    let raw_newline = "re 0.1 compact\nunit @x\ncap @stdout: process.stdout@0.1.0\nfn @main() -> process.status { %x = @stdout.write(\"a\nb\") }\n";
    let error = parse_source(raw_newline, "raw-newline.re").unwrap_err();
    assert_eq!(error.code, "invalid-string-literal");
}

#[test]
fn executable_parser_accepts_current_hello_fixture() {
    let source = include_str!("../../../examples/hello.re");
    let parsed = parse_source(source, "examples/hello.re").unwrap();
    assert_eq!(parsed.unit, "@hello");
    assert_eq!(parsed.tokens.len(), 44);
}

#[test]
fn executable_parser_uses_capability_schema_for_contextual_literals() {
    let read_source = include_str!("../../../examples/read-encoding.re");
    assert!(parse_source(read_source, "examples/read-encoding.re").is_ok());

    let write_source = include_str!("../../../examples/write-check.re");
    assert!(parse_source(write_source, "examples/write-check.re").is_ok());
}

#[test]
fn executable_parser_does_not_infer_context_from_member_name_alone() {
    let source = r#"re 0.1 compact
unit @wrong_schema
cap @input: fs.write@0.1.0
fn @main() -> process.status {
  %value = @input.read_file(encoding: text.encoding.utf8)
  return match %value {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
"#;
    let error = parse_source(source, "wrong-schema.re").unwrap_err();
    assert_eq!(error.code, "unexpected-token");
    assert_eq!(error.phase, "parse");
}

#[test]
fn native_parser_survives_one_hundred_thousand_deterministic_mutations() {
    let seeds = [
        ("hello", include_str!("../../../examples/hello.re")),
        (
            "args-check",
            include_str!("../../../examples/args-check.re"),
        ),
        (
            "read-check",
            include_str!("../../../examples/read-check.re"),
        ),
        (
            "read-encoding",
            include_str!("../../../examples/read-encoding.re"),
        ),
        (
            "write-check",
            include_str!("../../../examples/write-check.re"),
        ),
        (
            "agent-business-starter",
            include_str!("../../../examples/agent-business-starter.re"),
        ),
        (
            "agent-file-report",
            include_str!("../../../examples/agent-file-report.re"),
        ),
        (
            "agent-args-policy",
            include_str!("../../../examples/agent-args-policy.re"),
        ),
    ];
    let baselines = seeds
        .iter()
        .map(|(name, source)| {
            let file = format!("examples/{name}.re");
            let parsed = parse_source(source, &file).unwrap();
            let tokens = parsed
                .tokens
                .iter()
                .filter(|token| token.kind != TokenKind::End);
            let offsets = tokens
                .flat_map(|token| token.start..token.end)
                .filter(|offset| source.as_bytes()[*offset].is_ascii())
                .collect::<Vec<_>>();
            assert!(!offsets.is_empty(), "{name} must expose mutation offsets");
            (parsed, offsets)
        })
        .collect::<Vec<_>>();

    let mut state = 0x5245_5652_4941_3235u64;
    let mut accepted = 0usize;
    let mut rejected = 0usize;
    for iteration in 0..100_000usize {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let seed_index = iteration % seeds.len();
        let (name, source) = seeds[seed_index];
        let (baseline, offsets) = &baselines[seed_index];
        let offset = offsets[(state as usize) % offsets.len()];
        let original = source.as_bytes()[offset];
        let replacement_index = ((state >> 32) as usize) % 95;
        let mut replacement = 0x21u8 + replacement_index as u8;
        if replacement == original {
            replacement = 0x21u8 + ((replacement_index + 1) % 95) as u8;
        }
        let mut mutated = source.as_bytes().to_vec();
        mutated[offset] = replacement;
        let mutated = String::from_utf8(mutated).expect("ASCII replacement preserves UTF-8");
        let file = format!("generated:{name}:{iteration}");
        let first = parse_source(&mutated, &file);
        let second = parse_source(&mutated, &file);
        assert_eq!(first, second, "mutation {iteration} must be deterministic");
        match first {
            Ok(parsed) => {
                accepted += 1;
                assert_ne!(
                    parsed.tokens, baseline.tokens,
                    "mutation {iteration} silently fell back"
                );
            }
            Err(_) => rejected += 1,
        }
    }
    assert!(accepted > 0);
    assert!(rejected > 0);
}

#[test]
fn executable_parser_matches_stable_failure_shape() {
    let source = "re 0.1 compact\nunit @broken\nbad";
    let error = parse_source(source, "examples/diagnostic-error.re").unwrap_err();
    assert_eq!(error.code, "unexpected-token");
    assert_eq!(error.phase, "parse");
    assert_eq!(error.rule, "compact.token-role");
    assert!(error.byte_start.unwrap() < error.byte_end.unwrap());
}
