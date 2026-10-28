import assert from 'node:assert/strict'
import test from 'node:test'

import { parseGrammarCandidate } from '../src/toolchain/grammar-bakeoff.js'
import { parseProgram } from '../src/toolchain/parser.js'

const S2_HELLO = `re 0.1 compact
unit hello
cap $stdout: process.stdout@0.1.0
fn main() -> process.status {
  %printed = $stdout.write(data: "Hello, World!\\n")
  return match %printed {
    ok(_) => process.exit(code: 0)
    err(_) => process.exit(code: 1)
  }
}
`

test('candidate parser produces one stable parse and token stream', () => {
  const first = parseGrammarCandidate(S2_HELLO, {
    file: 'hello.re',
    grammar: 'S2',
  })
  const second = parseGrammarCandidate(S2_HELLO, {
    file: 'hello.re',
    grammar: 'S2',
  })
  assert.equal(first.ok, true)
  assert.equal(first.parseCount, 1)
  assert.deepEqual(first, second)
  assert.deepEqual(
    first.value.functions[0].statements.map(({ kind }) => kind),
    ['let', 'return'],
  )
})

test('candidate parser accepts canonical int and decimal token surfaces', () => {
  const cases = [
    ['-123456789012345678901234567890', 'int-literal', 0],
    ['123456789012345678901234567890', 'int-literal', 0],
    ['-1234567890.00100', 'decimal-literal', 5],
    ['0.00', 'decimal-literal', 2],
  ]

  for (const [text, kind, scale] of cases) {
    const source = S2_HELLO.replace('code: 0', `code: ${text}`)
    const result = parseGrammarCandidate(source, {
      file: `numeric-${kind}.re`,
      grammar: 'S2',
    })

    assert.equal(result.ok, true, text)
    const literal = result.value.functions[0].statements[1]
      .value.branches[0].value.arguments[0].value
    assert.deepEqual(literal, {
      kind,
      ...(kind === 'decimal-literal' ? { scale } : {}),
      value: text,
    })
  }
})

test('candidate parser gives one diagnostic for non-canonical numeric tokens', () => {
  const cases = [
    ['+1', 'leading-plus'],
    ['01', 'leading-zero'],
    ['-0', 'negative-zero'],
    ['1e3', 'exponent'],
    ['1_000', 'digit-separator'],
    ['1.', 'decimal-shape'],
    ['.5', 'decimal-shape'],
    ['-0.00', 'negative-zero'],
  ]

  for (const [text, reason] of cases) {
    const source = S2_HELLO.replace('code: 0', `code: ${text}`)
    const result = parseGrammarCandidate(source, {
      file: 'invalid-numeric.re',
      grammar: 'S2',
    })

    assert.equal(result.ok, false, text)
    assert.equal(result.diagnostics[0].code, 'invalid-numeric-literal', text)
    assert.equal(result.diagnostics[0].reason, reason, text)
    assert.equal(result.diagnostics[0].rule, 'compact.numeric-literal', text)
    assert.equal(result.diagnostics[0].lexeme, text, text)
  }
})

test('candidate parser fails closed for canonical source', () => {
  assert.deepEqual(project(parseGrammarCandidate(
    're 0.1 canonical\nunit hello\n',
    { file: 'canonical.re', grammar: 'S2' },
  )), {
    actual: 'canonical',
    code: 'unsupported-bakeoff-source-form',
    column: 1,
    expected: 'compact',
    file: 'canonical.re',
    grammar: 'S2',
    line: 1,
    phase: 'dispatch',
  })
})

test('candidate parser returns stable candidate-specific diagnostics', () => {
  const source = S2_HELLO.replace('$stdout.write', '@stdout.write')
  const first = parseGrammarCandidate(source, {
    file: 'wrong-sigil.re',
    grammar: 'S2',
  })
  const second = parseGrammarCandidate(source, {
    file: 'wrong-sigil.re',
    grammar: 'S2',
  })
  assert.deepEqual(first, second)
  assert.deepEqual(project(first), {
    actual: '@stdout.write',
    code: 'unexpected-candidate-token',
    column: 14,
    expected: 'candidate operation call',
    file: 'wrong-sigil.re',
    grammar: 'S2',
    line: 5,
    phase: 'parse',
  })
})

test('candidate diagnostics are versioned, attributable, byte-exact, and repairable', () => {
  const source = S2_HELLO
    .replace('unit hello', 'unit hello // 中文')
    .replace('$stdout.write', '@stdout.write')
  const result = parseGrammarCandidate(source, {
    file: 'agent-repair.re',
    grammar: 'S2',
  })
  const diagnostic = result.diagnostics[0]
  const start = source.indexOf('@stdout.write')
  const end = start + '@stdout.write'.length

  assert.equal(result.ok, false)
  assert.deepEqual(diagnostic, {
    actual: '@stdout.write',
    byte_end: Buffer.byteLength(source.slice(0, end), 'utf8'),
    byte_start: Buffer.byteLength(source.slice(0, start), 'utf8'),
    code: 'unexpected-candidate-token',
    column: 14,
    end_column: 27,
    end_line: 5,
    expected: 'candidate operation call',
    file: 'agent-repair.re',
    grammar: 'S2',
    lexeme: '@stdout.write',
    line: 5,
    phase: 'parse',
    repair: {
      action: 'replace',
      expected: 'candidate operation call',
    },
    rule: 'compact.token-role',
    schema: 're.source-diagnostic@0.1.0',
    severity: 'error',
  })
})

test('candidate parser rejects unknown grammar profiles', () => {
  assert.deepEqual(project(parseGrammarCandidate(S2_HELLO, {
    file: 'hello.re',
    grammar: 'S3',
  })), {
    actual: 'S3',
    code: 'unknown-grammar-candidate',
    column: 1,
    expected: ['S1', 'S2'],
    file: 'hello.re',
    grammar: 'S3',
    line: 1,
    phase: 'candidate-selection',
  })
})

test('candidate parser attributes header and lexer failures to one phase', () => {
  assert.equal(project(parseGrammarCandidate(
    're 0.1\n',
    { file: 'bad-header.re', grammar: 'S2' },
  )).phase, 'header')

  assert.equal(project(parseGrammarCandidate(
    're 0.1 compact\nunit hello\n"unterminated\n',
    { file: 'bad-string.re', grammar: 'S2' },
  )).phase, 'lex')
})

test('header diagnostics use the same Agent-readable source contract', () => {
  const result = parseGrammarCandidate(
    're 0.2 compact\n',
    { file: 'future.re', grammar: 'S2' },
  )
  const diagnostic = result.diagnostics[0]

  assert.equal(result.ok, false)
  assert.equal(diagnostic.schema, 're.source-diagnostic@0.1.0')
  assert.equal(diagnostic.phase, 'header')
  assert.equal(diagnostic.rule, 'header.language-version')
  assert.equal(diagnostic.byte_start, 3)
  assert.equal(diagnostic.byte_end, 6)
  assert.equal(diagnostic.line, 1)
  assert.equal(diagnostic.column, 4)
  assert.equal(diagnostic.end_line, 1)
  assert.equal(diagnostic.end_column, 7)
  assert.deepEqual(diagnostic.repair, {
    action: 'choose',
    expected: ['0.1'],
  })
})

test('candidate parser rejects non-ASCII compact trivia at a stable span', () => {
  for (const grammar of ['S1', 'S2']) {
    const semantic = grammar === 'S1' ? '@hello' : 'hello'
    for (const [character, actual] of [
      ['\r', 'U+000D'],
      ['\u00a0', 'U+00A0'],
      ['\u2003', 'U+2003'],
      ['\u2028', 'U+2028'],
    ]) {
      const source = `re 0.1 compact\nunit${character}${semantic}\n`
      assert.deepEqual(project(parseGrammarCandidate(source, {
        file: `trivia-${grammar}.re`,
        grammar,
      })), {
        actual,
        code: 'non-ascii-compact-trivia',
        column: 5,
        expected: 'ASCII space, tab, or LF',
        file: `trivia-${grammar}.re`,
        grammar,
        line: 2,
        phase: 'lex',
      })
    }
  }
})

test('candidate line comments cannot hide non-ASCII whitespace', () => {
  for (const character of ['\r', '\u00a0', '\u2028', '\u2029']) {
    const result = parseGrammarCandidate(
      `re 0.1 compact\nunit hello // comment${character}\n`,
      { file: 'comment-break.re', grammar: 'S2' },
    )
    assert.equal(result.ok, false)
    assert.equal(result.diagnostics[0].code, 'non-ascii-compact-trivia')
    assert.equal(result.diagnostics[0].phase, 'lex')
  }
})

test('candidate line comments are discarded before CST construction', () => {
  const commented = S2_HELLO
    .replace('unit hello', 'unit hello // human-only note')
    .replace('fn main()', '// another note\nfn main()')
  const plain = parseGrammarCandidate(S2_HELLO, {
    file: 'plain.re',
    grammar: 'S2',
  })
  const withComments = parseGrammarCandidate(commented, {
    file: 'commented.re',
    grammar: 'S2',
  })

  assert.equal(plain.ok, true)
  assert.equal(withComments.ok, true)
  assert.deepEqual(withComments.tokenStream, plain.tokenStream)
  assert.deepEqual(withComments.value, plain.value)
})

test('candidate parser reserves annotation prefix but rejects all V1 placements', () => {
  for (const grammar of ['S1', 'S2']) {
    const semantic = grammar === 'S1' ? '@hello' : 'hello'
    for (const annotation of ['#[audit.trace]', '#[audit.trace("x")]', '#[']) {
      const result = parseGrammarCandidate(
        `re 0.1 compact\nunit ${semantic}\n${annotation}\n`,
        { file: `annotation-${grammar}.re`, grammar },
      )
      assert.deepEqual(project(result), {
        actual: '#[',
        code: 'unsupported-v1-annotation',
        column: 1,
        expected: 'annotations are deferred beyond V1',
        file: `annotation-${grammar}.re`,
        grammar,
        line: 3,
        phase: 'lex',
      })
    }
  }
})

test('production and candidate parsers share byte-exact lexer diagnostics', () => {
  const source = S2_HELLO
    .replace('unit hello', 'unit @hello\u00a0')
    .replace('cap $stdout', 'cap @stdout')
    .replace('fn main', 'fn @main')
    .replace('$stdout.write', '@stdout.write')
  const candidate = parseGrammarCandidate(source, {
    file: 'shared-lexer.re',
    grammar: 'S1',
  })
  const production = parseProgram(source, {
    file: 'shared-lexer.re',
  })

  assert.equal(candidate.ok, false)
  assert.equal(production.ok, false)
  assert.deepEqual(
    projectSharedLexerDiagnostic(candidate.diagnostics[0]),
    projectSharedLexerDiagnostic(production.diagnostics[0]),
  )
})

function project(result) {
  assert.equal(result.ok, false)
  const {
    actual,
    code,
    column,
    expected,
    file,
    grammar,
    line,
    phase,
  } = result.diagnostics[0]
  return { actual, code, column, expected, file, grammar, line, phase }
}

function projectSharedLexerDiagnostic({
  actual,
  byte_end: byteEnd,
  byte_start: byteStart,
  code,
  column,
  end_column: endColumn,
  end_line: endLine,
  expected,
  file,
  lexeme,
  line,
  phase,
  repair,
  rule,
  schema,
  severity,
}) {
  return {
    actual,
    byteEnd,
    byteStart,
    code,
    column,
    endColumn,
    endLine,
    expected,
    file,
    lexeme,
    line,
    phase,
    repair,
    rule,
    schema,
    severity,
  }
}
