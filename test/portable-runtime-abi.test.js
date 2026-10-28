import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'

const abi = await import('../src/toolchain/portable-runtime-abi.js')
const repository = new URL('../', import.meta.url)
const corpus = JSON.parse(await readFile(
  new URL('./fixtures/portable-runtime-abi.json', import.meta.url),
  'utf8',
))
const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))
const faultCorpus = JSON.parse(await readFile(
  new URL('./fixtures/portable-fault-protocol.json', import.meta.url),
  'utf8',
))
const taskCorpus = JSON.parse(await readFile(
  new URL('./fixtures/task-runtime-lifecycle.json', import.meta.url),
  'utf8',
))

test('portable runtime ABI freezes execution, fault, and lifecycle requests', async () => {
  const first = await generate()
  const second = await generate()

  assert.deepEqual(first, second)
  assert.equal(first.schema, 're.portable-runtime-abi-report@0.1.0')
  assert.deepEqual(first.domains.map(({ id, workload_count }) => ({
    id,
    workload_count,
  })), [
    { id: 'execution', workload_count: 9 },
    { id: 'fault', workload_count: 13 },
    { id: 'task-lifecycle', workload_count: 14 },
  ])
  assert.equal(first.domains[0].report.candidates[0].candidate, 'node-reference')
  assert.equal(first.domains[0].report.candidates[1].candidate, 'portable-core')
  assert.equal(first.domains[0].report.candidates[2].candidate, 'portable-process')
  assert.equal(first.domains[1].report.workloads.length, 13)
  assert.equal(first.domains[2].report.workloads.length, 14)
  assert.equal(
    first.domains[2].report.workloads.find(({ id }) => id === 'timeout-late-effect')
      .result.receipt.cancel_reason,
    'timeout',
  )
  assert.equal(
    first.domains[2].report.workloads.find(({ id }) => id === 'parent-wins-timeout')
      .result.receipt.cancel_reason,
    'parent',
  )
  assert.deepEqual(await verify(first), { ok: true })
})

test('portable runtime ABI rejects missing fields and synchronized authority drift', async () => {
  const generated = await generate()
  const mutations = [
    [
      'missing domain',
      (value) => { value.domains.pop() },
      'portable-runtime-abi-domain-set-mismatch',
    ],
    [
      'extra report field',
      (value) => { value.extra = true },
      'portable-runtime-abi-report-fields-mismatch',
    ],
    [
      'execution request',
      (value) => {
        value.domains[0].report.candidates[0].workloads[0]
          .request.graph_revision = `sha256:${'a'.repeat(64)}`
      },
      'portable-runtime-abi-execution-authority-mismatch',
    ],
    [
      'fault result',
      (value) => {
        value.domains[1].report.workloads[0].result.error.code = 'forged'
      },
      'portable-runtime-abi-fault-authority-mismatch',
    ],
    [
      'replay receipt',
      (value) => {
        value.domains[2].report.workloads[3].result.receipt.replayed = false
      },
      'portable-runtime-abi-task-lifecycle-authority-mismatch',
    ],
    [
      'timeout receipt',
      (value) => {
        value.domains[2].report.workloads[6].result.receipt.cancel_reason = 'parent'
      },
      'portable-runtime-abi-task-lifecycle-authority-mismatch',
    ],
    [
      'resource close diagnostic',
      (value) => {
        value.domains[2].report.workloads[10].result.error.code = 'forged'
      },
      'portable-runtime-abi-task-lifecycle-authority-mismatch',
    ],
  ]

  for (const [label, mutate, code] of mutations) {
    const changed = structuredClone(generated)
    mutate(changed)
    changed.report_digest = abi.portableRuntimeAbiReportDigest(changed)
    const result = await verify(changed)
    assert.equal(result.ok, false, label)
    assert.equal(result.diagnostics[0].code, code, label)
  }
})

async function generate() {
  const result = await abi.runPortableRuntimeAbiCorpus({
    bundle,
    corpus,
    faultCorpus,
    loadGraph,
    taskCorpus,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}

function verify(report) {
  return abi.verifyPortableRuntimeAbiCorpus(report, {
    bundle,
    corpus,
    faultCorpus,
    loadGraph,
    taskCorpus,
  })
}

async function loadGraph(entry) {
  const source = await readFile(new URL(entry.graph, repository), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true, entry.id)
  return { ...checked.program, graph_revision: entry.graph_revision }
}
