import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import {
  llvmAotFeasibilityObservations,
  llvmAotExternalEvidenceDigest,
  llvmAotExternalStableDigest,
  runLlvmAotExternalEvidence,
  verifyLlvmAotExternalEvidence,
} from '../src/toolchain/llvm-aot-external-evidence.js'
import {
  BACKEND_FEASIBILITY_PROBES,
  createBackendFeasibilityReport,
} from '../src/toolchain/backend-feasibility.js'

const repository = new URL('../', import.meta.url)
const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))
const identity = {
  release_lock_digest: digest('release-lock'),
  toolchain_digest: digest('toolchain'),
}

let available = process.platform === 'darwin' && process.arch === 'arm64'
try {
  await access('/usr/bin/clang')
} catch {
  available = false
}

const generated = available
  ? runLlvmAotExternalEvidence({
      ...identity,
      bundle,
      compiler_path: '/usr/bin/clang',
      loadGraph,
      samples: 2,
      target_triple: 'arm64-apple-darwin',
    })
  : null

test('LLVM AOT external runner compiles and executes the frozen portable oracle', {
  skip: !available,
}, async () => {
  const result = await generated

  assert.equal(result.ok, true)
  assert.equal(result.value.schema, 're.llvm-aot-external-evidence@0.1.0')
  assert.equal(result.value.candidate, 'aot-llvm')
  assert.equal(result.value.status, 'measured')
  assert.equal(result.value.provenance.synthetic, false)
  assert.equal(result.value.provenance.measurement_source, 'runner')
  assert.equal(result.value.workloads.length, bundle.cases.length)
  assert.ok(result.value.workloads.every(({ build, execution, run }) => (
    build.samples_ns.length === 2
      && run.samples_ns.length === 2
      && execution.invocations.length === 1
  )))
  assert.deepEqual(
    await verifyLlvmAotExternalEvidence(result.value, {
      ...identity,
      bundle,
      loadGraph,
    }),
    { ok: true },
  )
})

test('LLVM AOT evidence stable digest excludes clock samples but evidence digest binds them', {
  skip: !available,
}, async () => {
  const result = await generated
  assert.equal(result.ok, true)

  const changed = structuredClone(result.value)
  changed.workloads[0].run.samples_ns[0] = (
    BigInt(changed.workloads[0].run.samples_ns[0]) + 1n
  ).toString()
  resignEvidence(changed)

  assert.equal(
    llvmAotExternalStableDigest(changed),
    result.value.stable_digest,
  )
  assert.notEqual(
    llvmAotExternalEvidenceDigest(changed),
    result.value.evidence_digest,
  )
  assert.deepEqual(
    await verifyLlvmAotExternalEvidence(changed, {
      ...identity,
      bundle,
      loadGraph,
    }),
    { ok: true },
  )
})

test('LLVM AOT verifier rejects synchronized authority, result, provenance, and metric drift', {
  skip: !available,
}, async () => {
  const result = await generated
  assert.equal(result.ok, true)

  for (const [label, mutate, code] of [
    [
      'artifact authority',
      (report) => { report.workloads[0].artifact_digest = digest('artifact') },
      'llvm-aot-workload-authority-mismatch',
    ],
    [
      'request authority',
      (report) => { report.workloads[0].request_digest = digest('request') },
      'llvm-aot-workload-authority-mismatch',
    ],
    [
      'source authority',
      (report) => { report.workloads[0].source_digest = digest('source') },
      'llvm-aot-source-authority-mismatch',
    ],
    [
      'semantic result',
      (report) => { report.workloads[0].execution.outcome.code = 255 },
      'llvm-aot-semantic-oracle-mismatch',
    ],
    [
      'synthetic provenance',
      (report) => { report.provenance.synthetic = true },
      'llvm-aot-provenance-invalid',
    ],
    [
      'compiler identity',
      (report) => { report.provenance.compiler_digest = digest('compiler') },
      'llvm-aot-compiler-identity-mismatch',
    ],
    [
      'invalid metric',
      (report) => { report.workloads[0].build.samples_ns[0] = '-1' },
      'llvm-aot-metric-invalid',
    ],
  ]) {
    const changed = structuredClone(result.value)
    mutate(changed)
    resignEvidence(changed)
    const verified = await verifyLlvmAotExternalEvidence(changed, {
      ...identity,
      bundle,
      loadGraph,
    })
    assert.equal(verified.ok, false, label)
    assert.equal(verified.diagnostics[0].code, code, label)
  }
})

test('LLVM AOT runner does not accept a forged expected outcome as executable authority', {
  skip: !available,
}, async () => {
  const changed = structuredClone(bundle)
  changed.cases[0].expected.outcome.code = 9
  changed.cases[0].expected.receipt.outcome.code = 9

  const result = await runLlvmAotExternalEvidence({
    ...identity,
    bundle: changed,
    compiler_path: '/usr/bin/clang',
    loadGraph,
    samples: 1,
    target_triple: 'arm64-apple-darwin',
  })

  assert.equal(result.ok, false)
  assert.equal(
    result.diagnostics[0].code,
    'portable-benchmark-oracle-outcome-mismatch',
  )
})

test('LLVM AOT evidence reports every feasibility probe without widening eligibility', {
  skip: !available,
}, async () => {
  const result = await generated
  assert.equal(result.ok, true)

  const observations = llvmAotFeasibilityObservations(result.value)
  assert.deepEqual(
    observations.map(({ candidate, probe, status }) => ({
      candidate,
      probe,
      status,
    })),
    BACKEND_FEASIBILITY_PROBES.map(({ id }) => ({
      candidate: 'aot-llvm',
      probe: id,
      status: 'reported',
    })),
  )
  const feasibility = createBackendFeasibilityReport({
    graph_revision: digest('graph'),
    observations,
    release_lock_digest: identity.release_lock_digest,
    toolchain_digest: identity.toolchain_digest,
  })
  assert.equal(feasibility.ok, true)
  assert.equal(feasibility.value.candidates[0].status, 'pending')
  assert.equal(feasibility.value.candidates[1].status, 'reported')
  assert.equal(feasibility.value.candidates[2].status, 'pending')
  assert.equal(Object.hasOwn(feasibility.value.candidates[1], 'eligible'), false)
})

async function loadGraph(entry) {
  const source = await readFile(new URL(entry.graph, repository), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function resignEvidence(report) {
  report.stable_digest = llvmAotExternalStableDigest(report)
  report.evidence_digest = llvmAotExternalEvidenceDigest(report)
}

function digest(value) {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`
}
