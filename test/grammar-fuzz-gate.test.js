import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeFuzzValue,
  runGrammarFuzzGate,
  verifyGrammarFuzzBaseline,
} from '../src/toolchain/grammar-fuzz-gate.js'

test('grammar fuzz semantic projection strips locations but preserves graph values', () => {
  const baseline = {
    kind: 'call',
    location: { line: 1, column: 1 },
    value: {
      name: 'process.exit',
      location: { line: 1, column: 2 },
      argument: 0,
    },
  }
  const commentShifted = {
    ...baseline,
    location: { line: 4, column: 1 },
    value: {
      ...baseline.value,
      location: { line: 4, column: 2 },
    },
  }
  const changedValue = {
    ...commentShifted,
    value: {
      ...commentShifted.value,
      argument: 1,
    },
  }

  assert.deepEqual(normalizeFuzzValue(commentShifted), normalizeFuzzValue(baseline))
  assert.notDeepEqual(normalizeFuzzValue(changedValue), normalizeFuzzValue(baseline))
})

test('grammar fuzz gate is replayable without materializing its corpus', async () => {
  const options = {
    enforceTiming: false,
    iterations: 20_000,
    lengthProbe: false,
    seed: 0x52455f32,
  }
  const first = await runGrammarFuzzGate(options)
  const second = await runGrammarFuzzGate(options)

  assert.equal(first.ok, true)
  assert.equal(first.iterations, 20_000)
  assert.equal(first.crash_count, 0)
  assert.equal(first.nondeterministic_count, 0)
  assert.equal(first.wrong_graph_count, 0)
  assert.equal(first.accepted_changed + first.rejected, first.iterations)
  assert.deepEqual(
    first.seed_cases.map(({ id, iterations, parser }) => ({
      id,
      iterations,
      parser,
    })),
    [
      {
        id: 'PAIR-HELLO-S2',
        iterations: 5_000,
        parser: 'grammar-candidate:S2',
      },
      {
        id: 'PAIR-NUMERIC-S2',
        iterations: 5_000,
        parser: 'grammar-candidate:S2',
      },
      {
        id: 'SRC-001',
        iterations: 5_000,
        parser: 'module-surface',
      },
      {
        id: 'ARGS-CHECK',
        iterations: 5_000,
        parser: 'production:parseProgram',
      },
    ],
  )
  assert.equal(first.outcome_digest, second.outcome_digest)
  assert.equal(first.source_digest, second.source_digest)
  assert.deepEqual(first.seed_cases, second.seed_cases)
})

test('grammar fuzz gate rejects invalid iteration counts', async () => {
  await assert.rejects(
    runGrammarFuzzGate({ iterations: 0 }),
    /grammar fuzz iterations must be a positive integer/,
  )
})

test('grammar fuzz baseline verification rejects semantic drift', () => {
  const report = {
    accepted_changed: 0,
    candidate: 'S2',
    crash_count: 0,
    iterations: 1,
    mutation: 'two-distinct-grammar-byte-replacements',
    mutation_offsets: 1,
    nondeterministic_count: 0,
    outcome_digest: 'sha256:outcome',
    rejected: 1,
    seed: 1,
    seed_cases: [{
      accepted_changed: 0,
      crash_count: 0,
      id: 'PAIR-HELLO-S2',
      iterations: 1,
      mutation_offsets: 1,
      nondeterministic_count: 0,
      outcome_digest: 'sha256:seed-outcome',
      rejected: 1,
      seed: 1,
      source_digest: 'sha256:seed-source',
      wrong_graph_count: 0,
    }],
    source_digest: 'sha256:source',
    wrong_graph_count: 0,
  }
  const baseline = {
    schema: 're.grammar-fuzz-baseline@0.5.0',
    ...report,
  }

  assert.equal(verifyGrammarFuzzBaseline(report, baseline), true)
  assert.equal(
    verifyGrammarFuzzBaseline(
      { ...report, wrong_graph_count: 1 },
      baseline,
    ),
    false,
  )
  assert.equal(
    verifyGrammarFuzzBaseline(
      {
        ...report,
        seed_cases: [{
          ...report.seed_cases[0],
          rejected: 0,
        }],
      },
      baseline,
    ),
    false,
  )
})
