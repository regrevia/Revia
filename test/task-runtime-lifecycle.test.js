import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  runTaskRuntimeLifecycleBenchmark,
  taskRuntimeLifecycleReportDigest,
  taskRuntimeLifecycleRequestDigest,
  taskRuntimeLifecycleResultDigest,
  verifyTaskRuntimeLifecycleBenchmark,
} from '../src/toolchain/task-runtime-lifecycle.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/task-runtime-lifecycle.json', import.meta.url),
  'utf8',
))

test('task runtime lifecycle report freezes the complete reference corpus', async () => {
  const first = await runTaskRuntimeLifecycleBenchmark(corpus)
  const second = await runTaskRuntimeLifecycleBenchmark(corpus)

  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(first, second)
  assert.equal(first.value.schema, 're.task-runtime-lifecycle-report@0.1.0')
  assert.equal(first.value.runtime, 'node-reference')
  assert.deepEqual(
    first.value.workloads.map(({ id }) => id),
    corpus.scenarios.map(({ id }) => id),
  )
  assert.deepEqual(await verifyTaskRuntimeLifecycleBenchmark(first.value, corpus), {
    ok: true,
  })
})

test('task runtime lifecycle receipt fixes cancellation, cleanup, retry, and replay facts', async () => {
  const report = (await runTaskRuntimeLifecycleBenchmark(corpus)).value
  const byId = new Map(report.workloads.map((workload) => [workload.id, workload]))

  assert.deepEqual(
    byId.get('retry-transient-success').result.receipt.trace
      .map(({ kind }) => kind),
    [
      'attempt-start',
      'attempt-error',
      'retry',
      'attempt-start',
      'attempt-error',
      'retry',
      'attempt-start',
      'success',
      'resource-close',
    ],
  )
  assert.equal(
    byId.get('replay-existing-effect').result.receipt.replayed,
    true,
  )
  assert.equal(
    byId.get('timeout-late-effect').result.receipt.cancel_reason,
    'timeout',
  )
  assert.equal(
    byId.get('parent-wins-timeout').result.receipt.cancel_reason,
    'parent',
  )
  assert.deepEqual(
    byId.get('resource-close-fault').result.error,
    { code: 'task-resource-close-failure' },
  )
  assert.equal(
    byId.get('resource-close-fault').result.receipt.effect_count,
    0,
  )
  assert.deepEqual(
    byId.get('cleanup-first-fault').result.error,
    { code: 'invalid-task-timeout' },
  )
  assert.deepEqual(
    byId.get('cleanup-first-fault').result.receipt.cleanup_events,
    ['timer-clear', 'signal-remove', 'resource-close'],
  )
})

test('task runtime lifecycle verifier rejects workload set drift', async () => {
  const report = (await runTaskRuntimeLifecycleBenchmark(corpus)).value
  const mutations = [
    (value) => value.workloads.pop(),
    (value) => value.workloads.push(structuredClone(value.workloads[0])),
    (value) => value.workloads.reverse(),
    (value) => { value.workloads[1].id = value.workloads[0].id },
  ]

  for (const mutate of mutations) {
    const candidate = structuredClone(report)
    mutate(candidate)
    candidate.report_digest = taskRuntimeLifecycleReportDigest(candidate)
    const result = await verifyTaskRuntimeLifecycleBenchmark(candidate, corpus)
    assert.equal(result.ok, false)
  }
})

test('task runtime lifecycle verifier rejects synchronized request authority forgery', async () => {
  const report = (await runTaskRuntimeLifecycleBenchmark(corpus)).value
  const fields = [
    ['contract_digest', `sha256:${'a'.repeat(64)}`],
    ['corpus_digest', `sha256:${'b'.repeat(64)}`],
    ['task_request_digest', `sha256:${'c'.repeat(64)}`],
    ['scenario_digest', `sha256:${'d'.repeat(64)}`],
  ]

  for (const [field, value] of fields) {
    const candidate = structuredClone(report)
    const workload = candidate.workloads[0]
    workload.request[field] = value
    workload.request.request_digest = taskRuntimeLifecycleRequestDigest(workload.request)
    workload.result.request_digest = workload.request.request_digest
    workload.result.result_digest = taskRuntimeLifecycleResultDigest(workload.result)
    candidate.report_digest = taskRuntimeLifecycleReportDigest(candidate)
    const result = await verifyTaskRuntimeLifecycleBenchmark(candidate, corpus)
    assert.equal(result.ok, false, field)
  }
})

test('task runtime lifecycle verifier rejects synchronized result and receipt forgery', async () => {
  const report = (await runTaskRuntimeLifecycleBenchmark(corpus)).value
  const mutations = [
    (result) => { result.terminal = 'failed' },
    (result) => { result.receipt.attempts = 99 },
    (result) => { result.receipt.effect_count = 99 },
    (result) => { result.receipt.cleanup_events = [] },
    (result) => { result.error = { code: 'forged' } },
    (result) => { result.trace_digest = `sha256:${'e'.repeat(64)}` },
  ]

  for (const mutate of mutations) {
    const candidate = structuredClone(report)
    const workload = candidate.workloads[0]
    mutate(workload.result)
    workload.result.result_digest = taskRuntimeLifecycleResultDigest(workload.result)
    candidate.report_digest = taskRuntimeLifecycleReportDigest(candidate)
    const result = await verifyTaskRuntimeLifecycleBenchmark(candidate, corpus)
    assert.equal(result.ok, false)
  }
})
