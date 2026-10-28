import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  BACKEND_FEASIBILITY_CANDIDATES,
  BACKEND_FEASIBILITY_PROBES,
  createBackendFeasibilityReport,
  verifyBackendFeasibilityReport,
} from '../src/toolchain/backend-feasibility.js'

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/backend-feasibility.json', import.meta.url),
  'utf8',
))

test('feasibility harness keeps WASM and AOT candidates pending without external evidence', () => {
  const result = createBackendFeasibilityReport(fixture)

  assert.equal(result.ok, true)
  assert.equal(result.value.status, 'pending')
  assert.deepEqual(result.value.candidates.map(({ candidate, status }) => ({
    candidate,
    status,
  })), BACKEND_FEASIBILITY_CANDIDATES.map(({ id }) => ({
    candidate: id,
    status: 'pending',
  })))
  assert.ok(result.value.candidates.every(({ probes }) => (
    probes.length === BACKEND_FEASIBILITY_PROBES.length
      && probes.every(({ status }) => status === 'pending')
  )))
  assert.deepEqual(
    verifyBackendFeasibilityReport(result.value, fixture),
    { ok: true },
  )
})

test('feasibility harness records reported runner observations without making eligibility claims', () => {
  const observation = {
    candidate: 'wasm',
    evidence_digest: digest('reported-wasm'),
    probe: 'target-toolchain',
    provenance: {
      environment_id: 'fixture-darwin-arm64',
      host_identity_digest: digest('fixture-host'),
      measurement_source: 'runner',
      runner_id: 'fixture-runner',
      synthetic: false,
      toolchain_digest: fixture.toolchain_digest,
    },
    status: 'reported',
  }
  const result = createBackendFeasibilityReport({
    ...fixture,
    observations: [observation],
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.status, 'reported')
  const wasm = result.value.candidates[0]
  assert.equal(wasm.status, 'reported')
  assert.deepEqual(wasm.probes.find(({ id }) => id === 'target-toolchain'), {
    evidence_digest: observation.evidence_digest,
    id: 'target-toolchain',
    provenance: observation.provenance,
    status: 'reported',
  })
  assert.equal(Object.hasOwn(wasm, 'eligible'), false)
  assert.equal(Object.hasOwn(wasm, 'artifact_digest'), false)
  assert.equal(Object.hasOwn(wasm, 'metrics'), false)
})

test('feasibility harness rejects forged provenance, status widening, identity drift, and observation duplicates', () => {
  const observation = {
    candidate: 'aot-llvm',
    evidence_digest: digest('reported-llvm'),
    probe: 'semantic-oracle',
    provenance: {
      environment_id: 'fixture-linux-x64',
      host_identity_digest: digest('fixture-host'),
      measurement_source: 'runner',
      runner_id: 'fixture-runner',
      synthetic: false,
      toolchain_digest: fixture.toolchain_digest,
    },
    status: 'reported',
  }
  const cases = [
    [
      'synthetic runner',
      { ...observation, provenance: { ...observation.provenance, synthetic: true } },
      'backend-feasibility-provenance-invalid',
    ],
    [
      'status widening',
      { ...observation, status: 'pass' },
      'backend-feasibility-observation-invalid',
    ],
    [
      'duplicate observation',
      observation,
      'backend-feasibility-observation-invalid',
    ],
  ]
  for (const [label, changed, code] of cases) {
    const observations = label === 'duplicate observation'
      ? [observation, changed]
      : [changed]
    const result = createBackendFeasibilityReport({
      ...fixture,
      observations,
    })
    assert.equal(result.ok, false, label)
    assert.equal(result.diagnostics[0].code, code, label)
  }

  const generated = createBackendFeasibilityReport({
    ...fixture,
    observations: [observation],
  })
  assert.equal(generated.ok, true)
  assert.deepEqual(
    verifyBackendFeasibilityReport(generated.value, {
      ...fixture,
      graph_revision: digest('different-graph'),
    }),
    {
      diagnostics: [{
        code: 'backend-feasibility-graph-revision-mismatch',
      }],
      ok: false,
    },
  )
})

test('feasibility verifier rejects synchronized report drift and extra production fields', () => {
  const generated = createBackendFeasibilityReport(fixture)
  assert.equal(generated.ok, true)

  const extra = structuredClone(generated.value)
  extra.candidates[0].eligible = false
  assert.equal(
    verifyBackendFeasibilityReport(extra, fixture).diagnostics[0].code,
    'backend-feasibility-candidate-fields-invalid',
  )

  const drifted = structuredClone(generated.value)
  drifted.graph_revision = digest('drifted-graph')
  drifted.report_digest = digest('resigned')
  assert.equal(
    verifyBackendFeasibilityReport(drifted, fixture).diagnostics[0].code,
    'backend-feasibility-graph-revision-mismatch',
  )
})

function digest(value) {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`
}
