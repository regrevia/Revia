import { createHash } from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const AGENT_RELEASE_LOCK_SCHEMA = 're.agent-project-release-lock@0.1.0'

export function backendMatrixDigest(matrix) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(matrix))
    .digest('hex')}`
}

export function validateBackendContractEvidence(evidence, matrix) {
  const diagnostics = []
  if (!validMatrix(matrix)) {
    return rejected({ code: 'unsupported-backend-matrix' })
  }
  if (!plainObject(evidence) || evidence.schema !== 're.backend-contract-evidence@0.1.0') {
    return rejected({ code: 'unsupported-backend-contract-evidence' })
  }
  recordUnknownFields(evidence, [
    'artifact_digest',
    'candidate',
    'graph_revision',
    'hard_gates',
    'memory_contract',
    'probes',
    'release_lock_digest',
    'schema',
    'target_profile_digest',
  ], diagnostics, { code: 'unexpected-backend-contract-field' })

  if (!matrix.candidates.some(({ id }) => id === evidence.candidate)) {
    diagnostics.push({
      actual: evidence.candidate,
      code: 'unknown-backend-candidate',
    })
  }
  for (const field of [
    'artifact_digest',
    'graph_revision',
    'release_lock_digest',
    'target_profile_digest',
  ]) {
    if (!DIGEST.test(evidence[field])) {
      diagnostics.push({ code: 'invalid-backend-contract-digest', field })
    }
  }
  if (!canonicalEqual(evidence.memory_contract, matrix.memory_contract)) {
    diagnostics.push({ code: 'backend-memory-contract-mismatch' })
  }
  validateNamedEvidence({
    actual: evidence.probes,
    diagnostics,
    expected: matrix.memory_probes,
    idOf: ({ id }) => id,
    mismatch: (actual, expected) =>
      actual.outcome !== expected.expected || actual.status !== 'pass',
    prefix: 'backend-memory-probe',
    fields: ['evidence_digest', 'id', 'outcome', 'status'],
  })
  validateNamedEvidence({
    actual: evidence.hard_gates,
    diagnostics,
    expected: matrix.hard_gates.map((id) => ({ id })),
    idOf: ({ id }) => id,
    mismatch: (actual) => actual.status !== 'pass',
    prefix: 'backend-hard-gate',
    fields: ['evidence_digest', 'id', 'status'],
  })
  return result(diagnostics)
}

export function validateBackendBakeoffReport(report, matrix) {
  const diagnostics = []
  if (!validMatrix(matrix)) {
    return rejected({ code: 'unsupported-backend-matrix' })
  }
  if (!plainObject(report) || report.schema !== 're.backend-bakeoff-report@0.1.0') {
    return rejected({ code: 'unsupported-backend-bakeoff-report' })
  }
  recordUnknownFields(report, [
    'benchmark_profile_digest',
    'environment',
    'matrix_digest',
    'release_lock_digest',
    'runs',
    'schema',
  ], diagnostics, { code: 'unexpected-bakeoff-report-field' })
  if (report.matrix_digest !== backendMatrixDigest(matrix)) {
    diagnostics.push({ code: 'backend-matrix-digest-mismatch' })
  }
  for (const field of ['benchmark_profile_digest', 'release_lock_digest']) {
    if (!DIGEST.test(report[field])) {
      diagnostics.push({ code: 'invalid-bakeoff-report-digest', field })
    }
  }
  for (const field of ['hardware_digest', 'operating_system_digest', 'toolchain_digest']) {
    if (!DIGEST.test(report.environment?.[field])) {
      diagnostics.push({ code: 'invalid-bakeoff-environment-digest', field })
    }
  }
  if (plainObject(report.environment)) {
    recordUnknownFields(report.environment, [
      'hardware_digest',
      'operating_system_digest',
      'toolchain_digest',
    ], diagnostics, { code: 'unexpected-bakeoff-environment-field' })
  }

  const runs = indexed(report.runs, ({ candidate }) => candidate)
  if (!runs.ok) {
    diagnostics.push({ code: 'invalid-backend-run-set' })
    return result(diagnostics)
  }
  const expectedCandidates = new Set(matrix.candidates.map(({ id }) => id))
  for (const id of runs.values.keys()) {
    if (!expectedCandidates.has(id)) {
      diagnostics.push({ code: 'unknown-backend-run', candidate: id })
    }
  }
  for (const candidate of matrix.candidates) {
    const run = runs.values.get(candidate.id)
    if (run === undefined) {
      diagnostics.push({ code: 'missing-backend-run', candidate: candidate.id })
      continue
    }
    validateBackendRun(run, candidate, matrix, diagnostics)
  }
  return result(diagnostics)
}

export function agentProjectReleaseLockDigest(lock) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(lock))
    .digest('hex')}`
}

export function validateAgentProjectReleaseLock(lock, {
  backend,
  graph_revision,
  module_interfaces,
  profile,
  toolchain,
} = {}) {
  const diagnostics = []
  if (!plainObject(lock) || lock.schema !== AGENT_RELEASE_LOCK_SCHEMA) {
    return rejected({ code: 'unsupported-agent-project-release-lock' })
  }
  recordUnknownFields(lock, [
    'artifacts',
    'backend',
    'build_artifact',
    'graph_revision',
    'independent_review',
    'module_interfaces',
    'package_digest',
    'profile',
    'release',
    'rollback',
    'schema',
    'stage',
    'toolchain',
  ], diagnostics, { code: 'unexpected-agent-release-lock-field' })
  if (!['Preview', 'Agent-project candidate', 'Stable V1.0'].includes(lock.stage)) {
    diagnostics.push({ code: 'invalid-agent-release-stage' })
  }
  validatePinnedDigest(lock.graph_revision, graph_revision, 'agent-release-graph-revision', diagnostics)
  if (!DIGEST.test(lock.package_digest)) {
    diagnostics.push({ code: 'invalid-agent-release-package-digest' })
  }
  validateIdentity(lock.backend, backend, 'backend', diagnostics)
  validateIdentity(lock.profile, profile, 'profile', diagnostics)
  validateIdentity(lock.toolchain, toolchain, 'toolchain', diagnostics)
  validateModuleInterfaces(lock.module_interfaces, module_interfaces, diagnostics)
  validateArtifacts(lock.artifacts, diagnostics)
  if (!plainObject(lock.build_artifact)
    || lock.build_artifact.schema !== 're.backend-artifact@0.1.0'
    || lock.build_artifact.backend !== 'production'
    || lock.build_artifact.graph_revision !== lock.graph_revision
    || !DIGEST.test(lock.build_artifact.artifact_digest)) {
    diagnostics.push({ code: 'invalid-agent-release-build-artifact' })
  }
  if (!plainObject(lock.rollback)
    || !['copy-on-write', 'immutable-lock'].includes(lock.rollback.strategy)
    || (lock.rollback.previous_lock_digest !== null
      && !DIGEST.test(lock.rollback.previous_lock_digest))) {
    diagnostics.push({ code: 'invalid-agent-release-rollback' })
  }
  if (!plainObject(lock.independent_review)
    || !['pending', 'pass', 'fail'].includes(lock.independent_review.status)) {
    diagnostics.push({ code: 'invalid-agent-release-review-status' })
  }
  return result(diagnostics)
}

function validatePinnedDigest(actual, expected, code, diagnostics) {
  if (!DIGEST.test(actual) || (expected !== undefined && actual !== expected)) {
    diagnostics.push({ code })
  }
}

function validateIdentity(actual, expected, kind, diagnostics) {
  if (!plainObject(actual)
    || typeof actual.id !== 'string'
    || !DIGEST.test(actual.digest)
    || typeof actual.version !== 'string') {
    diagnostics.push({ code: `invalid-agent-release-${kind}` })
    return
  }
  if (expected !== undefined && (
    actual.id !== expected.id
    || actual.version !== expected.version
    || actual.digest !== expected.digest
  )) {
    diagnostics.push({ code: `agent-release-${kind}-mismatch` })
  }
}

function validateModuleInterfaces(actual, expected, diagnostics) {
  if (!Array.isArray(actual) || actual.length === 0) {
    diagnostics.push({ code: 'invalid-agent-release-module-interfaces' })
    return
  }
  const names = new Set()
  for (const entry of actual) {
    if (!plainObject(entry) || typeof entry.module !== 'string'
      || !DIGEST.test(entry.interface_digest) || names.has(entry.module)) {
      diagnostics.push({ code: 'invalid-agent-release-module-interface' })
      continue
    }
    names.add(entry.module)
  }
  if (expected !== undefined) {
    const expectedJson = canonicalJson(expected)
    const actualJson = canonicalJson(actual)
    if (expectedJson !== actualJson) {
      diagnostics.push({ code: 'agent-release-module-interfaces-mismatch' })
    }
  }
}

function validateArtifacts(artifacts, diagnostics) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    diagnostics.push({ code: 'invalid-agent-release-artifacts' })
    return
  }
  const paths = new Set()
  for (const artifact of artifacts) {
    if (!plainObject(artifact)
      || typeof artifact.path !== 'string'
      || artifact.path.length === 0
      || paths.has(artifact.path)
      || !DIGEST.test(artifact.digest)) {
      diagnostics.push({ code: 'invalid-agent-release-artifact' })
      continue
    }
    paths.add(artifact.path)
  }
}

function validateBackendRun(run, candidate, matrix, diagnostics) {
  recordUnknownFields(run, [
    'artifact_digest',
    'candidate',
    'candidate_metrics',
    'eligible',
    'hard_gates',
    'workloads',
  ], diagnostics, {
    candidate: candidate.id,
    code: 'unexpected-backend-run-field',
  })
  if (!DIGEST.test(run.artifact_digest)) {
    diagnostics.push({
      candidate: candidate.id,
      code: 'invalid-backend-artifact-digest',
    })
  }
  validateMetrics(
    run.candidate_metrics,
    matrix.candidate_axes,
    { candidate: candidate.id, scope: 'candidate' },
    diagnostics,
  )

  const gates = indexed(run.hard_gates, ({ id }) => id)
  let allGatesPass = gates.ok
  if (!gates.ok) {
    diagnostics.push({ candidate: candidate.id, code: 'invalid-backend-gate-set' })
  } else {
    for (const id of matrix.hard_gates) {
      const gate = gates.values.get(id)
      if (gate === undefined) {
        diagnostics.push({ candidate: candidate.id, code: 'missing-backend-gate', gate: id })
        allGatesPass = false
        continue
      }
      if (!['pass', 'fail'].includes(gate.status) || !DIGEST.test(gate.evidence_digest)) {
        diagnostics.push({ candidate: candidate.id, code: 'invalid-backend-gate', gate: id })
        allGatesPass = false
      } else if (gate.status !== 'pass') {
        allGatesPass = false
      }
      recordUnknownFields(gate, ['evidence_digest', 'id', 'status'], diagnostics, {
        candidate: candidate.id,
        code: 'unexpected-backend-gate-field',
        gate: id,
      })
    }
    for (const id of gates.values.keys()) {
      if (!matrix.hard_gates.includes(id)) {
        diagnostics.push({ candidate: candidate.id, code: 'unknown-backend-gate', gate: id })
        allGatesPass = false
      }
    }
  }
  const expectedEligibility = candidate.role === 'production-candidate' && allGatesPass
  if (run.eligible !== expectedEligibility) {
    diagnostics.push({
      actual: run.eligible,
      candidate: candidate.id,
      code: 'backend-eligibility-mismatch',
      expected: expectedEligibility,
    })
  }

  const workloads = indexed(run.workloads, ({ id }) => id)
  if (!workloads.ok) {
    diagnostics.push({ candidate: candidate.id, code: 'invalid-backend-workload-set' })
    return
  }
  const expectedWorkloads = new Set(matrix.workload_profiles.map(({ id }) => id))
  for (const id of workloads.values.keys()) {
    if (!expectedWorkloads.has(id)) {
      diagnostics.push({ candidate: candidate.id, code: 'unknown-backend-workload', workload: id })
    }
  }
  for (const profile of matrix.workload_profiles) {
    const workload = workloads.values.get(profile.id)
    if (workload === undefined) {
      diagnostics.push({ candidate: candidate.id, code: 'missing-backend-workload', workload: profile.id })
      continue
    }
    if (!DIGEST.test(workload.fixture_digest)) {
      diagnostics.push({ candidate: candidate.id, code: 'invalid-workload-fixture-digest', workload: profile.id })
    }
    if (!Number.isSafeInteger(workload.sample_count) || workload.sample_count <= 0) {
      diagnostics.push({ candidate: candidate.id, code: 'invalid-workload-sample-count', workload: profile.id })
    }
    recordUnknownFields(workload, [
      'fixture_digest',
      'id',
      'metrics',
      'sample_count',
    ], diagnostics, {
      candidate: candidate.id,
      code: 'unexpected-backend-workload-field',
      workload: profile.id,
    })
    validateMetrics(
      workload.metrics,
      profile.required_axes,
      { candidate: candidate.id, scope: profile.id },
      diagnostics,
    )
  }
}

function validateMetrics(metrics, expectedAxes, context, diagnostics) {
  if (!plainObject(metrics)) {
    diagnostics.push({ ...context, code: 'invalid-backend-metrics' })
    return
  }
  const actualAxes = Object.keys(metrics)
  for (const axis of expectedAxes) {
    if (!actualAxes.includes(axis)) {
      diagnostics.push({ ...context, axis, code: 'missing-backend-metric' })
      continue
    }
    if (!Number.isFinite(metrics[axis]) || metrics[axis] < 0) {
      diagnostics.push({ ...context, axis, code: 'invalid-backend-metric' })
    }
  }
  for (const axis of actualAxes) {
    if (!expectedAxes.includes(axis)) {
      diagnostics.push({ ...context, axis, code: 'unexpected-backend-metric' })
    }
  }
}

function validateNamedEvidence({ actual, diagnostics, expected, fields, idOf, mismatch, prefix }) {
  const entries = indexed(actual, idOf)
  if (!entries.ok) {
    diagnostics.push({ code: `invalid-${prefix}-set` })
    return
  }
  const expectedIds = new Set(expected.map(idOf))
  for (const id of entries.values.keys()) {
    if (!expectedIds.has(id)) diagnostics.push({ code: `unknown-${prefix}`, id })
  }
  for (const expectedEntry of expected) {
    const id = idOf(expectedEntry)
    const actualEntry = entries.values.get(id)
    if (actualEntry === undefined) {
      diagnostics.push({ code: `missing-${prefix}`, id })
      continue
    }
    recordUnknownFields(actualEntry, fields, diagnostics, {
      code: `unexpected-${prefix}-field`,
      id,
    })
    if (mismatch(actualEntry, expectedEntry) || !DIGEST.test(actualEntry.evidence_digest)) {
      diagnostics.push({ code: `${prefix}-failed`, id })
    }
  }
}

function indexed(values, idOf) {
  if (!Array.isArray(values)) return { ok: false }
  const result = new Map()
  for (const value of values) {
    if (!plainObject(value)) return { ok: false }
    const id = idOf(value)
    if (typeof id !== 'string' || result.has(id)) return { ok: false }
    result.set(id, value)
  }
  return { ok: true, values: result }
}

function validMatrix(matrix) {
  return (
    plainObject(matrix) &&
    matrix.schema === 're.backend-bakeoff@0.2.0' &&
    Array.isArray(matrix.candidates) &&
    Array.isArray(matrix.memory_probes) &&
    Array.isArray(matrix.workload_profiles) &&
    Array.isArray(matrix.hard_gates)
  )
}

function rejected(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function result(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalEqual(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function recordUnknownFields(value, expected, diagnostics, context) {
  if (!plainObject(value)) return
  for (const field of Object.keys(value).sort()) {
    if (!expected.includes(field)) diagnostics.push({ ...context, field })
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}
