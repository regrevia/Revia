import { createHash } from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REPORT_SCHEMA = 're.digest-pinned-benchmark-report@0.1.0'

export function benchmarkMatrixDigest(matrix) {
  return digest(matrix)
}

export function benchmarkReportDigest(report) {
  return digest(report)
}

export function validateDigestPinnedBenchmarkReport(report, matrix, {
  budget_policy_digest,
  environment,
  graph_revision,
  release_lock_digest,
} = {}) {
  const diagnostics = []
  if (!validMatrix(matrix)) return rejected('unsupported-benchmark-matrix')
  if (report === null || typeof report !== 'object' || Array.isArray(report)
    || report.schema !== REPORT_SCHEMA) {
    return rejected('unsupported-digest-pinned-benchmark-report')
  }
  if (Object.keys(report).sort().join(',') !== [
    'environment',
    'graph_revision',
    'matrix_digest',
    'release_lock_digest',
    'runs',
    'schema',
  ].join(',')) {
    diagnostics.push({ code: 'unexpected-benchmark-report-field' })
  }
  if (report.matrix_digest !== benchmarkMatrixDigest(matrix)) {
    diagnostics.push({ code: 'benchmark-matrix-digest-mismatch' })
  }
  for (const [field, expected] of [
    ['graph_revision', graph_revision],
    ['release_lock_digest', release_lock_digest],
  ]) {
    if (!DIGEST.test(report[field]) || (expected !== undefined && report[field] !== expected)) {
      diagnostics.push({ code: `benchmark-${field.replaceAll('_', '-')}-mismatch` })
    }
  }
  validateEnvironment(report.environment, diagnostics)
  if (environment !== undefined
    && canonicalJson(report.environment) !== canonicalJson(environment)) {
    diagnostics.push({ code: 'benchmark-environment-mismatch' })
  }
  const runs = index(report.runs, ({ candidate }) => candidate)
  if (!runs.ok) diagnostics.push({ code: 'invalid-benchmark-candidate-set' })
  else {
    for (const candidate of matrix.candidates) {
      const run = runs.values.get(candidate.id)
      if (run === undefined) {
        diagnostics.push({ code: 'missing-benchmark-candidate', candidate: candidate.id })
        continue
      }
      validateCandidateRun(run, candidate, matrix, diagnostics, budget_policy_digest)
    }
    for (const candidate of runs.values.keys()) {
      if (!matrix.candidates.some(({ id }) => id === candidate)) {
        diagnostics.push({ code: 'unknown-benchmark-candidate', candidate })
      }
    }
  }
  return diagnostics.length === 0 ? { ok: true } : { diagnostics, ok: false }
}

function validateCandidateRun(run, candidate, matrix, diagnostics, budgetPolicyDigest) {
  const expected = [
    'artifact_digest',
    'candidate',
    'eligible',
    'workloads',
  ]
  if (Object.keys(run).sort().join(',') !== expected.join(',')) {
    diagnostics.push({ code: 'unexpected-benchmark-run-field', candidate: candidate.id })
  }
  if (!DIGEST.test(run.artifact_digest)
    || typeof run.eligible !== 'boolean') {
    diagnostics.push({ code: 'invalid-benchmark-candidate-identity', candidate: candidate.id })
  }
  const workloads = index(run.workloads, ({ id }) => id)
  if (!workloads.ok) {
    diagnostics.push({ code: 'invalid-benchmark-workload-set', candidate: candidate.id })
    return
  }
  for (const workload of matrix.workload_profiles) {
    const actual = workloads.values.get(workload.id)
    if (actual === undefined) {
      diagnostics.push({
        code: 'missing-benchmark-workload',
        candidate: candidate.id,
        workload: workload.id,
      })
      continue
    }
    validateWorkload(actual, workload, candidate.id, diagnostics, budgetPolicyDigest)
  }
  const expectedEligible = candidate.role === 'production-candidate'
    && matrix.workload_profiles.every(({ id }) =>
      workloads.values.get(id)?.budget?.status === 'pass')
  if (run.eligible !== expectedEligible) {
    diagnostics.push({ code: 'backend-eligibility-mismatch', candidate: candidate.id })
  }
}

function validateWorkload(actual, expected, candidate, diagnostics, budgetPolicyDigest) {
  const fields = ['budget', 'fixture_digest', 'id', 'metrics', 'sample_count', 'status']
  if (Object.keys(actual).sort().join(',') !== fields.join(',')) {
    diagnostics.push({ code: 'unexpected-benchmark-workload-field', candidate, workload: expected.id })
  }
  if (!DIGEST.test(actual.fixture_digest)
    || actual.status !== 'measured'
    || !Number.isSafeInteger(actual.sample_count)
    || actual.sample_count <= 0) {
    diagnostics.push({ code: 'invalid-benchmark-workload', candidate, workload: expected.id })
  }
  if (actual.budget === null || typeof actual.budget !== 'object'
    || Array.isArray(actual.budget)
    || Object.keys(actual.budget).sort().join(',') !== 'policy_digest,status'
    || !DIGEST.test(actual.budget.policy_digest)
    || !['pass', 'fail'].includes(actual.budget.status)) {
    diagnostics.push({ code: 'invalid-benchmark-budget', candidate, workload: expected.id })
  } else if (budgetPolicyDigest !== undefined
    && actual.budget.policy_digest !== budgetPolicyDigest) {
    diagnostics.push({ code: 'benchmark-budget-policy-mismatch', candidate, workload: expected.id })
  }
  const required = new Set(expected.required_axes)
  for (const key of Object.keys(actual.metrics ?? {})) {
    if (!required.has(key)) diagnostics.push({
      code: 'unexpected-benchmark-metric',
      candidate,
      metric: key,
      workload: expected.id,
    })
  }
  for (const axis of expected.required_axes) {
    if (!Number.isFinite(actual.metrics?.[axis]) || actual.metrics[axis] < 0) {
      diagnostics.push({
        code: 'missing-benchmark-metric',
        axis,
        candidate,
        workload: expected.id,
      })
    }
  }
}

function validateEnvironment(environment, diagnostics) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).sort().join(',') !== 'hardware_digest,operating_system_digest,toolchain_digest') {
    diagnostics.push({ code: 'invalid-benchmark-environment' })
    return
  }
  for (const field of Object.keys(environment)) {
    if (!DIGEST.test(environment[field])) {
      diagnostics.push({ code: 'invalid-benchmark-environment-digest', field })
    }
  }
}

function validMatrix(matrix) {
  return matrix !== null && typeof matrix === 'object'
    && Array.isArray(matrix.candidates) && matrix.candidates.length > 0
    && Array.isArray(matrix.workload_profiles) && matrix.workload_profiles.length > 0
    && matrix.workload_profiles.every((workload) =>
      Array.isArray(workload.required_axes) && workload.required_axes.length > 0)
}

function index(values, keyOf) {
  if (!Array.isArray(values)) return { ok: false }
  const map = new Map()
  for (const value of values) {
    const key = keyOf(value)
    if (typeof key !== 'string' || map.has(key)) return { ok: false }
    map.set(key, value)
  }
  return { ok: true, values: map }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic benchmark value')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic benchmark value')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
