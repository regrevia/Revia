import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  backendMatrixDigest,
  validateBackendBakeoffReport,
  validateBackendContractEvidence,
} from '../src/runtime/backend-contract.js'

const matrix = JSON.parse(await readFile(
  new URL('./fixtures/backend-bakeoff-matrix.json', import.meta.url),
  'utf8',
))
const digest = (character) => `sha256:${character.repeat(64)}`

test('backend contract accepts complete memory probes and hard-gate evidence', () => {
  assert.deepEqual(validateBackendContractEvidence(contractEvidence(), matrix), {
    ok: true,
  })
})

test('backend contract rejects copied-memory semantics and missing evidence', () => {
  const evidence = contractEvidence()
  evidence.memory_contract.immutable_aliasing = 'copy-required'
  evidence.probes = evidence.probes.slice(1)
  evidence.hard_gates.find(({ id }) => id === 'memory-safety-contract').status = 'fail'

  const result = validateBackendContractEvidence(evidence, matrix)

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    [
      'backend-memory-contract-mismatch',
      'missing-backend-memory-probe',
      'backend-hard-gate-failed',
    ],
  )
})

test('backend contract fails closed on extra claims and cyclic memory evidence', () => {
  const evidence = contractEvidence()
  evidence.unversioned_claim = true
  evidence.memory_contract.cycle = evidence.memory_contract

  const result = validateBackendContractEvidence(evidence, matrix)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(
    ({ code, field }) =>
      code === 'unexpected-backend-contract-field' && field === 'unversioned_claim',
  ))
  assert.ok(result.diagnostics.some(
    ({ code }) => code === 'backend-memory-contract-mismatch',
  ))
})

test('bake-off report covers every candidate and workload without cherry-picking', () => {
  assert.deepEqual(validateBackendBakeoffReport(bakeoffReport(), matrix), {
    ok: true,
  })
})

test('bake-off report rejects missing candidates, missing metrics, and false eligibility', () => {
  const report = bakeoffReport()
  report.runs = report.runs.filter(({ candidate }) => candidate !== 'cranelift')
  delete report.runs[0].workloads[0].metrics.p99_ms
  report.runs.find(({ candidate }) => candidate === 'node-reference').eligible = true

  const result = validateBackendBakeoffReport(report, matrix)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(({ code }) => code === 'missing-backend-run'))
  assert.ok(result.diagnostics.some(({ code }) => code === 'missing-backend-metric'))
  assert.ok(result.diagnostics.some(({ code }) => code === 'backend-eligibility-mismatch'))
})

test('bake-off report rejects unversioned result fields', () => {
  const report = bakeoffReport()
  report.runs[0].workloads[0].marketing_score = 100

  const result = validateBackendBakeoffReport(report, matrix)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(
    ({ code, field }) =>
      code === 'unexpected-backend-workload-field' && field === 'marketing_score',
  ))
})

test('failed hard gate makes a production candidate ineligible but keeps its data valid', () => {
  const report = bakeoffReport()
  const run = report.runs.find(({ candidate }) => candidate === 'aot-llvm')
  run.hard_gates.find(({ id }) => id === 'structured-cancellation').status = 'fail'
  run.eligible = false

  assert.deepEqual(validateBackendBakeoffReport(report, matrix), { ok: true })
})

test('matrix digest is independent of JSON object key insertion order', () => {
  const reordered = Object.fromEntries(Object.entries(matrix).reverse())

  assert.equal(backendMatrixDigest(reordered), backendMatrixDigest(matrix))
})

function contractEvidence() {
  return {
    artifact_digest: digest('a'),
    candidate: 'aot-llvm',
    graph_revision: digest('b'),
    hard_gates: matrix.hard_gates.map((id) => ({
      evidence_digest: digest('c'),
      id,
      status: 'pass',
    })),
    memory_contract: structuredClone(matrix.memory_contract),
    probes: matrix.memory_probes.map(({ expected, id }) => ({
      evidence_digest: digest('d'),
      id,
      outcome: expected,
      status: 'pass',
    })),
    release_lock_digest: digest('e'),
    schema: 're.backend-contract-evidence@0.1.0',
    target_profile_digest: digest('f'),
  }
}

function bakeoffReport() {
  return {
    benchmark_profile_digest: digest('a'),
    environment: {
      hardware_digest: digest('b'),
      operating_system_digest: digest('c'),
      toolchain_digest: digest('d'),
    },
    matrix_digest: backendMatrixDigest(matrix),
    release_lock_digest: digest('e'),
    runs: matrix.candidates.map((candidate) => ({
      artifact_digest: digest('f'),
      candidate: candidate.id,
      candidate_metrics: metrics(matrix.candidate_axes),
      eligible: candidate.role === 'production-candidate',
      hard_gates: matrix.hard_gates.map((id) => ({
        evidence_digest: digest('2'),
        id,
        status: 'pass',
      })),
      workloads: matrix.workload_profiles.map((profile) => ({
        fixture_digest: digest('3'),
        id: profile.id,
        metrics: metrics(profile.required_axes),
        sample_count: 30,
      })),
    })),
    schema: 're.backend-bakeoff-report@0.1.0',
  }
}

function metrics(axes) {
  return Object.fromEntries(axes.map((axis, index) => [axis, index + 1]))
}
