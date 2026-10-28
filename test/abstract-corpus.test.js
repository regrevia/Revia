import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAbstractCorpusSchema,
  validateAbstractCorpusEntry,
  validateAbstractCorpusPairs,
} from '../src/toolchain/abstract-corpus.js'

test('shared abstract corpus schema fixes the paired task contract', () => {
  const schema = buildAbstractCorpusSchema()
  assert.equal(schema.corpus_kind, 'shared-abstract-corpus')
  assert.deepEqual(schema.grammar_candidates, ['S1', 'S2'])
  assert.deepEqual(schema.source_forms, ['compact', 'canonical'])
  assert.ok(schema.accepted_fields.includes('expected_graph'))
  assert.ok(schema.accepted_fields.includes('source_shape'))
  assert.ok(schema.accepted_fields.includes('pair_id'))
  assert.ok(schema.accepted_fields.includes('input'))
  assert.ok(schema.accepted_fields.includes('blocked_by'))
  assert.equal(schema.version, '0.4')
})

test('shared abstract corpus keeps grammar candidate and source form separate', () => {
  assert.deepEqual(validateAbstractCorpusEntry({
    body: 'abstract hello task',
    grammar: 'S2',
    id: 'hello-001',
    input: 're 0.1 compact\nunit hello\n',
    pair_id: 'hello',
    source_form: 'compact',
    source_shape: 'hello-call-match',
  }), {
    ok: true,
    value: {
      body: 'abstract hello task',
      grammar: 'S2',
      id: 'hello-001',
      input: 're 0.1 compact\nunit hello\n',
      pair_id: 'hello',
      source_form: 'compact',
      source_shape: 'hello-call-match',
    },
  })

  assert.deepEqual(validateAbstractCorpusEntry({
    body: 'x',
    grammar: 'compact',
    id: 'bad-grammar',
    input: 'x',
    pair_id: 'bad',
    source_form: 'compact',
    source_shape: 'negative',
  }), {
    diagnostics: [{ actual: 'compact', code: 'invalid-abstract-corpus-grammar' }],
    ok: false,
  })

  assert.deepEqual(validateAbstractCorpusEntry({
    body: 'x',
    grammar: 'S1',
    id: 'bad-form',
    input: 'x',
    pair_id: 'bad',
    source_form: 're 0.1',
    source_shape: 'negative',
  }), {
    diagnostics: [{ actual: 're 0.1', code: 'invalid-abstract-corpus-source-form' }],
    ok: false,
  })
})

test('paired entries require executable source and pairing identity', () => {
  assert.deepEqual(validateAbstractCorpusEntry({
    body: 'x',
    grammar: 'S1',
    id: 'missing-pair',
    source_form: 'compact',
    source_shape: 'hello-call-match',
  }), {
    diagnostics: [{ code: 'missing-abstract-corpus-field', field: 'pair_id' }],
    ok: false,
  })
})

test('paired corpus requires exactly one S1 and one S2 variant per task', () => {
  const pair = [
    pairedEntry({ grammar: 'S1', id: 'HELLO-S1' }),
    pairedEntry({ grammar: 'S2', id: 'HELLO-S2' }),
  ]
  assert.deepEqual(validateAbstractCorpusPairs(pair), {
    ok: true,
    value: { entries: 2, pairs: 1 },
  })

  assert.deepEqual(validateAbstractCorpusPairs(pair.slice(0, 1)), {
    diagnostics: [{
      actual: ['S1'],
      code: 'incomplete-abstract-corpus-pair',
      expected: ['S1', 'S2'],
      pair_id: 'HELLO',
    }],
    ok: false,
  })

  assert.deepEqual(validateAbstractCorpusPairs([
    pairedEntry({ grammar: 'S1', id: 'HELLO-S1-A' }),
    pairedEntry({ grammar: 'S1', id: 'HELLO-S1-B' }),
  ]), {
    diagnostics: [{
      actual: ['S1', 'S1'],
      code: 'incomplete-abstract-corpus-pair',
      expected: ['S1', 'S2'],
      pair_id: 'HELLO',
    }],
    ok: false,
  })
})

test('paired corpus rejects tasks that change an abstract dimension', () => {
  assert.deepEqual(validateAbstractCorpusPairs([
    pairedEntry({ grammar: 'S1', id: 'HELLO-S1' }),
    pairedEntry({
      grammar: 'S2',
      id: 'HELLO-S2',
      source_shape: 'different-task',
    }),
  ]), {
    diagnostics: [{
      code: 'abstract-corpus-pair-mismatch',
      field: 'source_shape',
      pair_id: 'HELLO',
    }],
    ok: false,
  })
})

test('paired corpus validates entries before comparing them', () => {
  assert.deepEqual(validateAbstractCorpusPairs('not-an-array'), {
    diagnostics: [{ code: 'invalid-abstract-corpus-pairs' }],
    ok: false,
  })
  assert.deepEqual(validateAbstractCorpusPairs([]), {
    diagnostics: [{ code: 'empty-abstract-corpus-pairs' }],
    ok: false,
  })

  const invalid = pairedEntry({ grammar: 'S1', id: 'HELLO-S1' })
  delete invalid.input
  assert.deepEqual(validateAbstractCorpusPairs([invalid]), {
    diagnostics: [{
      code: 'missing-abstract-corpus-field',
      entry_id: 'HELLO-S1',
      field: 'input',
    }],
    ok: false,
  })
})

function pairedEntry(overrides) {
  return {
    body: 'one abstract task',
    grammar: 'S1',
    id: 'HELLO-S1',
    input: 're 0.1 compact\nunit hello\n',
    pair_id: 'HELLO',
    source_form: 'compact',
    source_shape: 'hello',
    ...overrides,
  }
}
