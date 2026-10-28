import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  buildAbstractCorpusSchema,
  validateAbstractCorpusPairs,
} from '../src/toolchain/abstract-corpus.js'
import { parseExecutableGrammar } from '../src/toolchain/executable-grammar.js'
import { parseGrammarCandidate, summarizeCandidateCst } from '../src/toolchain/grammar-bakeoff.js'
import { classifyS2Token } from '../src/toolchain/grammar-freeze.js'
import { PEG_CANDIDATES } from '../src/toolchain/grammar-peg.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/grammar-corpus.json', import.meta.url),
  'utf8',
))

test('shared grammar corpus has one stable identity per case', () => {
  assert.equal(corpus.schema, 're.grammar-corpus@0.7.0')
  assert.equal(corpus.status, 'candidate-evidence')
  const identities = corpus.cases.map((entry) => entry.id)
  assert.equal(new Set(identities).size, identities.length)
})

test('shared corpus schema acknowledges paired grammar tasks', () => {
  const schema = buildAbstractCorpusSchema()
  assert.ok(schema.grammar_candidates.includes('S1'))
  assert.ok(schema.grammar_candidates.includes('S2'))
  assert.ok(schema.accepted_fields.includes('source_shape'))
})

test('settled header rules satisfy the shared grammar corpus', () => {
  for (const entry of corpus.cases.filter(({ subject }) => subject === 'header')) {
    const result = parseExecutableGrammar(entry.input, { file: entry.id })
    assert.deepEqual(projectHeader(result), entry.expected, entry.id)
  }
})

test('S2 token-role candidate satisfies its shared grammar corpus', () => {
  for (const entry of corpus.cases.filter(({ subject }) => subject === 's2-token')) {
    const result = classifyS2Token(entry.input)
    const projected = result.ok
      ? result
      : { ok: false, diagnostic: result.diagnostic.code }
    assert.deepEqual(projected, entry.expected, entry.id)
  }
})

test('paired grammar tasks separate grammar candidate from source form', () => {
  const paired = corpus.cases.filter(({ subject }) => subject === 'paired-task')
  assert.equal(paired.length, 28)
  for (const entry of paired) {
    assert.ok(['S1', 'S2'].includes(entry.grammar))
    assert.ok(['compact', 'canonical'].includes(entry.source_form))
    const header = parseExecutableGrammar(entry.input, { file: entry.id })
    assert.equal(header.ok, true, entry.id)
    assert.equal(header.value.kind, entry.source_form, entry.id)
  }
  assert.deepEqual(validateAbstractCorpusPairs(paired), {
    ok: true,
    value: { entries: 28, pairs: 14 },
  })
})

test('paired grammar tasks execute both candidates against independent expectations', () => {
  const paired = corpus.cases.filter(({ subject }) => subject === 'paired-task')
  for (const entry of paired) {
    const result = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    const projected = result.ok
      ? { ok: true, summary: summarizeCandidateCst(result.value) }
      : {
          ok: false,
          diagnostic: result.diagnostics[0].code,
          ...(entry.expected.reason === undefined
            ? {}
            : { reason: result.diagnostics[0].reason }),
        }
    assert.deepEqual(projected, entry.expected, entry.id)
  }
})

test('successful S1 and S2 variants produce the same normalized CST', () => {
  const variants = corpus.cases.filter(
    ({ pair_id: pairId }) => pairId === 'PAIR-HELLO',
  )
  const parsed = variants.map((entry) =>
    parseGrammarCandidate(entry.input, { grammar: entry.grammar }).value,
  )
  assert.deepEqual(parsed[0], parsed[1])
})

test('numeric corpus preserves arbitrary-precision text and decimal scale', () => {
  const variants = corpus.cases.filter(
    ({ pair_id: pairId }) => pairId === 'PAIR-NUMERIC',
  )
  const parsed = variants.map((entry) =>
    parseGrammarCandidate(entry.input, { grammar: entry.grammar }).value,
  )
  assert.deepEqual(parsed[0], parsed[1])
  assert.deepEqual(parsed[0].functions[0].statements[0]
    .value.arguments[0].value, {
    kind: 'decimal-literal',
    scale: 5,
    value: '-1234567890.00100',
  })
  assert.deepEqual(parsed[0].functions[0].statements[1]
    .value.branches[0].value.arguments[0].value, {
    kind: 'int-literal',
    value: '0',
  })
  assert.deepEqual(parsed[0].functions[0].statements[1]
    .value.branches[1].value.arguments[0].value, {
    kind: 'int-literal',
    value: '123456789012345678901234567890',
  })
})

test('active negative tasks have stable expected diagnostic codes', () => {
  const entries = corpus.cases.filter(
    ({ expected, subject }) => subject === 'paired-task' && !expected.ok,
  )
  for (const entry of entries) {
    const first = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    const second = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    assert.equal(first.ok, false, entry.id)
    assert.equal(second.ok, false, entry.id)
    assert.ok(['lex', 'parse'].includes(first.diagnostics[0].phase), entry.id)
    assert.equal(first.diagnostics[0].code, entry.expected.diagnostic, entry.id)
    assert.equal(second.diagnostics[0].code, entry.expected.diagnostic, entry.id)
    assert.equal(first.diagnostics[0].code, second.diagnostics[0].code, entry.id)
    if (entry.expected.reason !== undefined) {
      assert.equal(first.diagnostics[0].reason, entry.expected.reason, entry.id)
      assert.equal(second.diagnostics[0].reason, entry.expected.reason, entry.id)
    }
    assertGrammarDiagnostic(first.diagnostics[0], entry.input, entry.id)
  }
})

test('independent diagnostic oracle separates distinguishable negative classes', () => {
  const entries = corpus.cases.filter(
    ({ expected, subject }) => subject === 'paired-task' && !expected.ok,
  )
  const diagnosticClassByShape = new Map([
    ['unpinned-capability-reference', 'schema-reference'],
    ['wrong-capability-sigil', 'candidate-token'],
    ['unsupported-cross-module-export', 'candidate-token'],
    ['annotation-token-crossing', 'deferred-annotation'],
    ['numeric-literal-format', 'numeric-token'],
    ['non-ascii-compact-trivia', 'compact-trivia'],
    ['non-lf-compact-line-ending', 'compact-trivia'],
  ])
  const observedCodeByClass = new Map()
  const classByObservedCode = new Map()

  for (const entry of entries) {
    const diagnosticClass = diagnosticClassByShape.get(entry.source_shape)
    assert.ok(diagnosticClass, `${entry.id} has no independent diagnostic class`)
    const result = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    assert.equal(result.ok, false, entry.id)
    const actualCode = result.diagnostics[0].code
    assert.equal(actualCode, entry.expected.diagnostic, entry.id)

    const priorCode = observedCodeByClass.get(diagnosticClass)
    if (priorCode !== undefined) assert.equal(actualCode, priorCode, entry.id)
    observedCodeByClass.set(diagnosticClass, actualCode)

    const priorClass = classByObservedCode.get(actualCode)
    if (priorClass !== undefined) {
      assert.equal(priorClass, diagnosticClass, `${entry.id}: diagnostic code collision`)
    } else {
      classByObservedCode.set(actualCode, diagnosticClass)
    }
  }

  assert.deepEqual(
    Object.fromEntries(observedCodeByClass),
    {
      'schema-reference': 'unpinned-schema-reference',
      'candidate-token': 'unexpected-candidate-token',
      'deferred-annotation': 'unsupported-v1-annotation',
      'compact-trivia': 'non-ascii-compact-trivia',
      'numeric-token': 'invalid-numeric-literal',
    },
  )
})

test('deferred tasks name their blocker and stop at source-form dispatch', () => {
  const deferred = corpus.cases.filter(({ subject }) => subject === 'deferred-task')
  assert.deepEqual(validateAbstractCorpusPairs(deferred), {
    ok: true,
    value: { entries: 6, pairs: 3 },
  })
  for (const entry of deferred) {
    assert.equal(typeof entry.blocked_by, 'string', entry.id)
    const result = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    assert.equal(result.ok, false, entry.id)
    assert.equal(result.diagnostics[0].phase, 'dispatch', entry.id)
    assert.equal(
      result.diagnostics[0].code,
      'unsupported-bakeoff-source-form',
      entry.id,
    )
  }
})

test('every corpus blocker maps to one named deferred grammar seam', () => {
  const knownBlockers = new Set(Object.values(PEG_CANDIDATES.S2.deferred))
  const blocked = corpus.cases.filter(({ blocked_by: blockedBy }) => blockedBy)
  assert.ok(blocked.length > 0)
  for (const entry of blocked) {
    assert.ok(knownBlockers.has(entry.blocked_by), entry.id)
  }
})

test('successful candidate tokenization and parsing are deterministic', () => {
  const entries = corpus.cases.filter(({ expected }) => expected?.ok === true)
    .filter(({ subject }) => subject === 'paired-task')
  for (const entry of entries) {
    const first = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    const second = parseGrammarCandidate(entry.input, {
      file: entry.id,
      grammar: entry.grammar,
    })
    assert.equal(first.parseCount, 1, entry.id)
    assert.equal(second.parseCount, 1, entry.id)
    assert.deepEqual(first.tokenStream, second.tokenStream, entry.id)
    assert.deepEqual(first.value, second.value, entry.id)
  }
})

function projectHeader(result) {
  if (!result.ok) {
    return { ok: false, diagnostic: result.diagnostics[0].code }
  }
  return {
    ok: true,
    body_offset: result.value.bodyOffset,
    form: result.value.kind,
    version: result.value.version,
  }
}

function assertGrammarDiagnostic(diagnostic, source, id) {
  assert.equal(diagnostic.schema, 're.source-diagnostic@0.1.0', id)
  assert.equal(diagnostic.severity, 'error', id)
  assert.equal(typeof diagnostic.rule, 'string', id)
  assert.ok(diagnostic.rule.length > 0, id)
  assert.ok(Number.isSafeInteger(diagnostic.byte_start), id)
  assert.ok(Number.isSafeInteger(diagnostic.byte_end), id)
  assert.ok(diagnostic.byte_start >= 0, id)
  assert.ok(diagnostic.byte_end >= diagnostic.byte_start, id)
  assert.ok(diagnostic.byte_end <= Buffer.byteLength(source, 'utf8'), id)
  assert.ok(Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0, id)
  assert.ok(Number.isSafeInteger(diagnostic.column) && diagnostic.column > 0, id)
  assert.ok(Number.isSafeInteger(diagnostic.end_line) && diagnostic.end_line > 0, id)
  assert.ok(Number.isSafeInteger(diagnostic.end_column) && diagnostic.end_column > 0, id)
  assert.equal(typeof diagnostic.lexeme, 'string', id)
  assert.equal(typeof diagnostic.repair?.action, 'string', id)
}
