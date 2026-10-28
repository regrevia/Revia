import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  portableFaultProtocolReportDigest,
  portableFaultProtocolRequestDigest,
  portableFaultProtocolResultDigest,
  runPortableFaultProtocolBenchmark,
  verifyPortableFaultProtocolBenchmark,
} from '../src/toolchain/portable-fault-protocol.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/portable-fault-protocol.json', import.meta.url),
  'utf8',
))
const source = await readFile(
  new URL('./golden/canonical-hello.re', import.meta.url),
  'utf8',
)
const checked = checkSource(source, { file: 'test/golden/canonical-hello.re' })
assert.equal(checked.ok, true)
const graph = {
  ...checked.program,
  graph_revision:
    'sha256:fbc879084d06d619f700d640826bebd4e758489171e269d162c57f1c26a19083',
}

test('portable fault protocol freezes core, bytecode, and process failures', async () => {
  const first = await runPortableFaultProtocolBenchmark(corpus, { graph })
  const second = await runPortableFaultProtocolBenchmark(corpus, { graph })

  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(second, first)
  assert.equal(first.value.schema, 're.portable-fault-protocol-report@0.1.0')
  assert.deepEqual(
    first.value.workloads.map(({ id }) => id),
    corpus.scenarios.map(({ id }) => id),
  )
  assert.deepEqual(
    await verifyPortableFaultProtocolBenchmark(first.value, corpus, { graph }),
    { ok: true },
  )
})

test('portable fault protocol records preflight and child lifecycle exactly', async () => {
  const report = (await runPortableFaultProtocolBenchmark(corpus, { graph })).value
  const byId = new Map(report.workloads.map((workload) => [workload.id, workload]))

  assert.deepEqual(byId.get('core-capability-fault').result.error, {
    candidate: 'portable-core',
    code: 'portable-executor-capability-fault',
    phase: 'capability',
    schema: 're.portable-fault-error@0.1.0',
  })
  assert.deepEqual(
    byId.get('process-preflight-check-failure').result.trace
      .map(({ kind }) => kind),
    ['preflight-start', 'preflight-rejected', 'terminal'],
  )
  assert.deepEqual(
    byId.get('process-timeout').result.trace.map(({ kind }) => kind),
    [
      'preflight-start',
      'preflight-accepted',
      'child-spawn',
      'stdin-end',
      'timeout',
      'child-kill',
      'child-close',
      'terminal',
    ],
  )
  for (const id of [
    'process-timeout',
    'process-early-exit',
    'process-malformed-output',
    'process-multiline-output',
    'process-oversized-stdout',
    'process-oversized-stderr',
    'process-forged-output',
  ]) {
    const trace = byId.get(id).result.trace.map(({ kind }) => kind)
    assert.equal(trace.includes('child-spawn'), true, id)
    assert.equal(trace.includes('child-close'), true, id)
    assert.equal(trace.at(-1), 'terminal', id)
  }
  assert.deepEqual(
    byId.get('process-spawn-fault').result.trace.map(({ kind }) => kind),
    [
      'preflight-start',
      'preflight-accepted',
      'child-spawn-fault',
      'terminal',
    ],
  )
  assert.equal(
    byId.get('process-preflight-check-failure').result.error.phase,
    'preflight',
  )
  assert.equal(
    byId.get('process-spawn-fault').result.error.phase,
    'process',
  )
  assert.equal(
    byId.get('process-timeout').result.error.phase,
    'process',
  )
})

test('portable fault verifier rejects workload set drift', async () => {
  const report = (await runPortableFaultProtocolBenchmark(corpus, { graph })).value
  const mutations = [
    (value) => value.workloads.pop(),
    (value) => value.workloads.push(structuredClone(value.workloads[0])),
    (value) => value.workloads.reverse(),
    (value) => { value.workloads[1].id = value.workloads[0].id },
  ]

  for (const mutate of mutations) {
    const candidate = structuredClone(report)
    mutate(candidate)
    candidate.report_digest = portableFaultProtocolReportDigest(candidate)
    const result = await verifyPortableFaultProtocolBenchmark(
      candidate,
      corpus,
      { graph },
    )
    assert.equal(result.ok, false)
  }
})

test('portable fault verifier rejects synchronized authority and result forgery', async () => {
  const report = (await runPortableFaultProtocolBenchmark(corpus, { graph })).value
  const mutations = [
    (workload) => {
      workload.request.graph_revision = `sha256:${'a'.repeat(64)}`
      resignRequest(workload)
    },
    (workload) => {
      workload.request.scenario_digest = `sha256:${'b'.repeat(64)}`
      resignRequest(workload)
    },
    (workload) => {
      workload.result.error.code = 'forged'
      resignResult(workload)
    },
    (workload) => {
      workload.result.trace[0].kind = 'forged'
      resignResult(workload)
    },
    (workload) => {
      workload.result.diagnostic.code = 'forged'
      resignResult(workload)
    },
  ]

  for (const mutate of mutations) {
    const candidate = structuredClone(report)
    const workload = candidate.workloads[0]
    mutate(workload)
    candidate.report_digest = portableFaultProtocolReportDigest(candidate)
    const result = await verifyPortableFaultProtocolBenchmark(
      candidate,
      corpus,
      { graph },
    )
    assert.equal(result.ok, false)
  }
})

function resignRequest(workload) {
  workload.request.request_digest =
    portableFaultProtocolRequestDigest(workload.request)
  workload.result.request_digest = workload.request.request_digest
  resignResult(workload)
}

function resignResult(workload) {
  workload.result.result_digest =
    portableFaultProtocolResultDigest(workload.result)
}
