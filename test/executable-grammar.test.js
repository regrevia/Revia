import assert from 'node:assert/strict'
import test from 'node:test'

import { parseExecutableGrammar } from '../src/toolchain/executable-grammar.js'
import {
  EXECUTABLE_GRAMMAR_PROFILE,
  executableGrammarHeader,
} from '../src/toolchain/executable-grammar-profile.js'

test('executable grammar profile is the versioned header authority', () => {
  assert.deepEqual(EXECUTABLE_GRAMMAR_PROFILE, {
    canonical_schema: 're.canonical@0.1.0',
    descriptor: 're 0.1 compact|canonical',
    forms: ['compact', 'canonical'],
    headers: {
      canonical: 're 0.1 canonical',
      compact: 're 0.1 compact',
    },
    schema: 're.executable-grammar-profile@0.1.0',
    version: '0.1',
  })
  assert.equal(executableGrammarHeader('compact'), 're 0.1 compact')
  assert.equal(executableGrammarHeader('canonical'), 're 0.1 canonical')
  assert.throws(
    () => executableGrammarHeader('future'),
    /unsupported executable grammar form: future/,
  )
})

test('executable grammar distinguishes compact and canonical headers', () => {
  assert.deepEqual(parseExecutableGrammar('re 0.1 compact\nunit hello\n'), {
    ok: true,
    value: { bodyOffset: 15, kind: 'compact', version: '0.1' },
  })
  assert.deepEqual(parseExecutableGrammar('re 0.1 canonical\nunit hello\n'), {
    ok: true,
    value: { bodyOffset: 17, kind: 'canonical', version: '0.1' },
  })
})

test('executable grammar requires explicit source form', () => {
  const bare = parseExecutableGrammar('re 0.1\n')
  assert.equal(bare.ok, false)
  assert.equal(bare.diagnostics[0].code, 'invalid-grammar-header')
  assert.equal(
    bare.diagnostics[0].expected,
    're <major>.<minor> compact | re <major>.<minor> canonical',
  )

  const missing = parseExecutableGrammar('not re\n')
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'missing-grammar-header')

  const empty = parseExecutableGrammar('')
  assert.equal(empty.ok, false)
  assert.equal(empty.diagnostics[0].code, 'missing-grammar-header')

  const noLineFeed = parseExecutableGrammar('re 0.1 compact')
  assert.equal(noLineFeed.ok, false)
  assert.equal(noLineFeed.diagnostics[0].code, 'invalid-grammar-header')
})

test('executable grammar reads only an exact first physical line', () => {
  for (const source of [
    '\nre 0.1 compact\n',
    '// prelude\nre 0.1 compact\n',
    ' re 0.1 compact\n',
  ]) {
    assert.equal(
      parseExecutableGrammar(source).diagnostics[0].code,
      'missing-grammar-header',
    )
  }

  assert.equal(
    parseExecutableGrammar('re 0.1 compact\r\nunit hello\r\n').diagnostics[0].code,
    'invalid-grammar-header',
  )
})

test('executable grammar separates version syntax from version support', () => {
  const source = 're 0.2 compact\n'
  const result = parseExecutableGrammar(source)

  assert.equal(result.ok, false)
  assert.deepEqual(result.diagnostics[0], {
    actual: '0.2',
    byte_end: 6,
    byte_start: 3,
    code: 'unsupported-language-version',
    column: 4,
    end_column: 7,
    end_line: 1,
    expected: ['0.1'],
    file: '<input>',
    lexeme: '0.2',
    line: 1,
    phase: 'header',
    repair: {
      action: 'choose',
      expected: ['0.1'],
    },
    rule: 'header.language-version',
    schema: 're.source-diagnostic@0.1.0',
    severity: 'error',
    supported: ['0.1'],
  })
})
