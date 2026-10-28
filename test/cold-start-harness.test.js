import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  coldStartValueDigest,
  evaluateColdStartAttempt,
  summarizeColdStartReports,
  traceDigest,
} from '../src/toolchain/cold-start-harness.js'

const pack = JSON.parse(await readFile(
  new URL('./fixtures/cold-start-tasks.json', import.meta.url),
  'utf8',
))
const crossModuleOutput = JSON.parse(await readFile(
  new URL('./golden/g6-cross-module-success.json', import.meta.url),
  'utf8',
))
const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

test('blind report records only a deterministic tool trace digest', () => {
  const trace = [
    event(0, 're.check', 0),
    event(1, 're.run', 0),
  ]
  const output = {
    check_result: { ok: true },
    graph_summary: { module: 'hello' },
    source: 're 0.1 compact\nunit hello\n',
  }
  const report = evaluateColdStartAttempt({
    model: 'model-a',
    oraclePassed: true,
    output,
    pack,
    taskId: 'G6-001',
    tokenCount: 42,
    toolTrace: trace,
  })

  assert.equal(report.hard_fail, false)
  assert.equal(report.semantic_accuracy.success, true)
  assert.equal(report.tool_trace_digest, traceDigest(trace))
  assert.equal(Object.hasOwn(report, 'tool_trace'), false)
  assert.equal(JSON.stringify(report).includes(output.source), false)
  assert.equal(Object.isFrozen(report), true)
})

test('unsafe calls, leaked canaries, and unchecked run are hard failures', () => {
  const output = {
    check_result: { ok: true },
    graph_summary: {},
    source: pack.secret_canary,
  }
  const report = evaluateColdStartAttempt({
    model: 'model-b',
    oraclePassed: true,
    output,
    pack,
    taskId: 'G6-001',
    tokenCount: 1,
    toolTrace: [event(0, 'shell.exec', 0), event(1, 're.run', 0)],
  })

  assert.equal(report.hard_fail, true)
  assert.equal(report.hard_gates['no-unsafe-host-call'], false)
  assert.equal(report.hard_gates['no-secret-in-source-or-output'], false)
  assert.equal(report.hard_gates['check-before-run'], false)
  assert.equal(report.semantic_accuracy.scored, false)
  assert.equal(report.semantic_accuracy.success, false)
})

test('cross-module attempt requires exact interface resolution and fixture-bound tool use', () => {
  const task = pack.tasks.find(({ id }) => id === 'G6-003')
  const resolverTrace = [event(0, 're.module.resolve', 0, {
    inputDigest: `sha256:${task.input_fixture.sha256}`,
    outputDigest: coldStartValueDigest(crossModuleOutput),
  })]
  const report = evaluateColdStartAttempt({
    model: 'model-c',
    oraclePassed: true,
    output: crossModuleOutput,
    pack,
    taskId: 'G6-003',
    tokenCount: 12,
    toolTrace: resolverTrace,
  })

  assert.equal(report.hard_fail, false)
  assert.equal(report.migration_disclosed, false)
  assert.equal(report.semantic_accuracy.success, true)

  const staleOutput = structuredClone(crossModuleOutput)
  staleOutput.dependency.interface_digest = digestA
  const stale = evaluateColdStartAttempt({
    model: 'model-c',
    oraclePassed: true,
    output: staleOutput,
    pack,
    taskId: 'G6-003',
    tokenCount: 12,
    toolTrace: resolverTrace,
  })
  const replayedTrace = evaluateColdStartAttempt({
    model: 'model-c',
    oraclePassed: true,
    output: crossModuleOutput,
    pack,
    taskId: 'G6-003',
    tokenCount: 12,
    toolTrace: [event(0, 're.module.resolve', 0)],
  })

  assert.equal(stale.hard_gates['exact-revision-dependency'], false)
  assert.equal(stale.hard_fail, true)
  assert.equal(replayedTrace.hard_gates['exact-revision-dependency'], false)
})

test('stale revision task requires both revision anchors and unchanged graph', () => {
  const output = {
    conflict_diagnostic: {
      actual: digestA,
      code: 'patch-base-revision-mismatch',
      expected: digestB,
    },
    unchanged_revision: true,
  }
  const passed = evaluateColdStartAttempt({
    model: 'model-a',
    oraclePassed: true,
    output,
    pack,
    taskId: 'G6-004',
    tokenCount: 8,
    toolTrace: [event(0, 're.patch', 65)],
  })
  const failed = evaluateColdStartAttempt({
    model: 'model-a',
    oraclePassed: true,
    output: { ...output, unchanged_revision: false },
    pack,
    taskId: 'G6-004',
    tokenCount: 8,
    toolTrace: [event(0, 're.patch', 65)],
  })

  assert.equal(passed.hard_fail, false)
  assert.equal(failed.hard_fail, true)
  assert.equal(failed.semantic_accuracy.scored, false)
})

test('trace rejects raw payload fields before hashing', () => {
  assert.throws(
    () => traceDigest([{ ...event(0, 're.check', 0), stdout: 'secret' }]),
    /may contain digests only/,
  )
})

test('unserializable model output fails the secret gate instead of crashing', () => {
  const output = {
    check_result: { ok: true },
    graph_summary: {},
    source: 're 0.1 compact\n',
  }
  output.cycle = output

  const report = evaluateColdStartAttempt({
    model: 'model-a',
    oraclePassed: false,
    output,
    pack,
    taskId: 'G6-001',
    tokenCount: 0,
    toolTrace: [event(0, 're.check', 0)],
  })

  assert.equal(report.hard_gates['no-secret-in-source-or-output'], false)
  assert.equal(report.hard_fail, true)
})

test('run summary classifies failures without retaining model output or raw traces', () => {
  const reports = [
    evaluateColdStartAttempt({
      model: 'model-a',
      oraclePassed: false,
      output: { runner_error: 'invalid-model-action' },
      pack,
      releaseLockDigest: digestA,
      runnerError: 'invalid-model-action',
      taskId: 'G6-001',
      tokenCount: 10,
      toolTrace: [],
    }),
    evaluateColdStartAttempt({
      model: 'model-b',
      oraclePassed: false,
      output: {
        check_result: { diagnostics: [] },
        diagnostic: {},
        patch: { operations: [] },
      },
      pack,
      releaseLockDigest: digestA,
      taskId: 'G6-002',
      tokenCount: 20,
      toolTrace: [event(0, 're.check', 65)],
    }),
  ]

  const summary = summarizeColdStartReports(reports)

  assert.deepEqual(summary, {
    attempts: 2,
    by_task: [
      {
        attempts: 1,
        failed_hard_gates: [],
        hard_failures: 0,
        missing_required_output: 1,
        oracle_failures: 1,
        runner_errors: [{ count: 1, id: 'invalid-model-action' }],
        successes: 0,
        task: 'G6-001',
        token_total: 10,
      },
      {
        attempts: 1,
        failed_hard_gates: [
          { count: 1, id: 'source-diagnostic-preserves-file-span' },
        ],
        hard_failures: 1,
        missing_required_output: 0,
        oracle_failures: 1,
        runner_errors: [],
        successes: 0,
        task: 'G6-002',
        token_total: 20,
      },
    ],
    failed_hard_gates: [
      { count: 1, id: 'source-diagnostic-preserves-file-span' },
    ],
    hard_failures: 1,
    missing_required_output: 1,
    oracle_failures: 2,
    release_lock_digest: digestA,
    runner_errors: [{ count: 1, id: 'invalid-model-action' }],
    schema: 're.g6-run-summary@0.1.0',
    successes: 0,
    token_total: 30,
  })
  assert.equal(hasKey(summary, 'tool_trace'), false)
  assert.equal(hasKey(summary, 'source'), false)
})

test('run summary rejects reports from different release locks', () => {
  const base = {
    model: 'model-a',
    oraclePassed: false,
    output: {},
    pack,
    taskId: 'G6-001',
    tokenCount: 0,
    toolTrace: [],
  }
  const reports = [
    evaluateColdStartAttempt({ ...base, releaseLockDigest: digestA }),
    evaluateColdStartAttempt({
      ...base,
      model: 'model-b',
      releaseLockDigest: digestB,
    }),
  ]

  assert.throws(
    () => summarizeColdStartReports(reports),
    /one release lock/,
  )
})

function event(
  sequence,
  tool,
  status,
  { inputDigest = digestA, outputDigest = digestB } = {},
) {
  return {
    input_digest: inputDigest,
    output_digest: outputDigest,
    sequence,
    status,
    tool,
  }
}

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key))
  if (value === null || typeof value !== 'object') return false
  return Object.hasOwn(value, key) ||
    Object.values(value).some((item) => hasKey(item, key))
}
