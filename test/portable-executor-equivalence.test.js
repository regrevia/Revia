import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'

let equivalenceApi
try {
  equivalenceApi = await import(
    '../src/toolchain/portable-executor-equivalence.js'
  )
} catch {
  equivalenceApi = null
}

const repository = new URL('../', import.meta.url)
const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))

test('portable executor benchmark produces exact three-way semantic equivalence', async () => {
  assert.notEqual(equivalenceApi, null)

  const first = await equivalenceApi.runPortableExecutorBenchmark(bundle, {
    loadGraph,
  })
  const second = await equivalenceApi.runPortableExecutorBenchmark(bundle, {
    loadGraph,
  })

  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  assert.deepEqual(
    await equivalenceApi.verifyPortableExecutorBenchmark(first.value, bundle, {
      loadGraph,
    }),
    { ok: true },
  )
  assert.equal(first.value.schema, 're.portable-executor-benchmark@0.1.0')
  assert.deepEqual(first.value.candidates.map(({ candidate, status }) => ({
    candidate,
    status,
  })), [
    { candidate: 'node-reference', status: 'measured' },
    { candidate: 'portable-core', status: 'measured' },
    { candidate: 'portable-process', status: 'measured' },
    { candidate: 'llvm-aot', status: 'pending' },
    { candidate: 'cranelift', status: 'pending' },
  ])

  const measured = first.value.candidates.slice(0, 3)
  assert.ok(measured.every(({ workloads }) => workloads.length === 9))
  for (let index = 0; index < bundle.cases.length; index += 1) {
    const summaries = measured.map(({ workloads }) => workloads[index])
    assert.deepEqual(summaries[1].request, summaries[0].request)
    assert.deepEqual(summaries[2].request, summaries[0].request)
    assert.deepEqual(summaries[1].result, summaries[0].result)
    assert.deepEqual(summaries[2].result, summaries[0].result)
  }
})

test('portable executor benchmark rejects candidate and workload set drift', async () => {
  assert.notEqual(equivalenceApi, null)
  const generated = await generate()

  for (const [label, mutate, code] of [
    [
      'missing candidate',
      (report) => { report.candidates.splice(2, 1) },
      'portable-benchmark-candidate-set-mismatch',
    ],
    [
      'extra candidate',
      (report) => {
        report.candidates.push({
          candidate: 'synthetic',
          reason: 'implementation-unavailable',
          status: 'pending',
          workloads: [],
        })
      },
      'portable-benchmark-candidate-set-mismatch',
    ],
    [
      'candidate reorder',
      (report) => { report.candidates.reverse() },
      'portable-benchmark-candidate-set-mismatch',
    ],
    [
      'llvm measured',
      (report) => {
        report.candidates[3] = structuredClone(report.candidates[0])
        report.candidates[3].candidate = 'llvm-aot'
      },
      'portable-benchmark-pending-candidate-invalid',
    ],
    [
      'cranelift pass',
      (report) => { report.candidates[4].status = 'pass' },
      'portable-benchmark-pending-candidate-invalid',
    ],
    [
      'missing workload',
      (report) => { report.candidates[0].workloads.pop() },
      'portable-benchmark-workload-set-mismatch',
    ],
    [
      'duplicate workload',
      (report) => {
        report.candidates[0].workloads[1] =
          structuredClone(report.candidates[0].workloads[0])
      },
      'portable-benchmark-workload-set-mismatch',
    ],
  ]) {
    const changed = structuredClone(generated)
    mutate(changed)
    resignReport(changed)
    const result = await equivalenceApi.verifyPortableExecutorBenchmark(
      changed,
      bundle,
      { loadGraph },
    )
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some(
      (diagnostic) => diagnostic.code === code,
    ), label)
  }
})

test('portable executor benchmark rejects synchronized authority and result forgery', async () => {
  assert.notEqual(equivalenceApi, null)
  const generated = await generate()

  for (const [label, mutate, code] of [
    [
      'graph authority',
      (workload) => { workload.request.graph_revision = digest('a') },
      'portable-benchmark-request-authority-mismatch',
    ],
    [
      'artifact authority',
      (workload) => { workload.request.artifact_digest = digest('b') },
      'portable-benchmark-request-authority-mismatch',
    ],
    [
      'input authority',
      (workload) => { workload.request.input_digest = digest('c') },
      'portable-benchmark-request-authority-mismatch',
    ],
    [
      'transcript authority',
      (workload) => { workload.request.transcript_digest = digest('d') },
      'portable-benchmark-request-authority-mismatch',
    ],
    [
      'outcome',
      (workload) => { workload.result.outcome.code = 255 },
      'portable-benchmark-result-authority-mismatch',
    ],
    [
      'receipt',
      (workload) => {
        workload.result.receipt.invocations[0].outcome = 'err'
      },
      'portable-benchmark-result-authority-mismatch',
    ],
    [
      'error',
      (workload) => {
        workload.result.error = {
          code: 'forged',
          schema: 're.portable-equivalence-error@0.1.0',
        }
      },
      'portable-benchmark-result-authority-mismatch',
    ],
    [
      'trace',
      (workload) => { workload.result.trace_digest = digest('e') },
      'portable-benchmark-result-authority-mismatch',
    ],
  ]) {
    const changed = structuredClone(generated)
    const workload = changed.candidates[0].workloads[0]
    mutate(workload)
    resignWorkload(workload)
    resignReport(changed)
    const result = await equivalenceApi.verifyPortableExecutorBenchmark(
      changed,
      bundle,
      { loadGraph },
    )
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some(
      (diagnostic) => diagnostic.code === code,
    ), label)
  }
})

test('portable executor benchmark digest excludes no semantic authority', async () => {
  assert.notEqual(equivalenceApi, null)
  const generated = await generate()
  assert.equal(
    generated.report_digest,
    equivalenceApi.portableExecutorBenchmarkReportDigest(generated),
  )

  const changed = structuredClone(generated)
  changed.report_digest = digest('f')
  const result = await equivalenceApi.verifyPortableExecutorBenchmark(
    changed,
    bundle,
    { loadGraph },
  )
  assert.deepEqual(result, {
    diagnostics: [{ code: 'portable-benchmark-report-digest-mismatch' }],
    ok: false,
  })
})

test('portable executor benchmark Node reference crosses the host contract front door', async () => {
  assert.notEqual(equivalenceApi, null)
  const source = await readFile(
    new URL(
      '../src/toolchain/portable-executor-equivalence.js',
      import.meta.url,
    ),
    'utf8',
  )
  assert.equal(source.includes("from '../host/host-environment.js'"), true)
  assert.equal(source.includes("from '../host/schema-registry.js'"), true)
  assert.equal(source.includes('HostEnvironment.bind({'), true)
})

async function generate() {
  const result = await equivalenceApi.runPortableExecutorBenchmark(bundle, {
    loadGraph,
  })
  assert.equal(result.ok, true)
  return result.value
}

async function loadGraph(entry) {
  const source = await readFile(new URL(entry.graph, repository), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true, entry.id)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function resignWorkload(workload) {
  workload.result.receipt.artifact_digest =
    workload.request.artifact_digest
  workload.result.receipt.graph_revision =
    workload.request.graph_revision
  workload.result.receipt.input_digest =
    workload.request.input_digest
  workload.result.receipt.transcript_digest =
    workload.request.transcript_digest
  workload.result.receipt.outcome =
    structuredClone(workload.result.outcome)
  workload.request.request_digest =
    equivalenceApi.portableEquivalenceRequestDigest(workload.request)
  workload.result.request_digest = workload.request.request_digest
  workload.result.result_digest =
    equivalenceApi.portableEquivalenceResultDigest(workload.result)
}

function resignReport(report) {
  report.report_digest =
    equivalenceApi.portableExecutorBenchmarkReportDigest(report)
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}
