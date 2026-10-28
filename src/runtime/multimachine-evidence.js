import { createHash } from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCHEMA = 're.multimachine-evidence@0.1.0'
const ENVIRONMENT_FIELDS = [
  'environment_id',
  'host_identity_digest',
  'measurement_source',
  'runner_id',
  'synthetic',
  'toolchain_digest',
]
const REPORT_FIELDS = ['environment_id', 'measurement_digest', 'report_digest']

export function createMultiMachineEvidenceManifest({
  candidate,
  environments,
  graph_revision,
  release_lock_digest,
  reports,
}) {
  const normalized = validateInputs({
    candidate,
    environments,
    graph_revision,
    release_lock_digest,
    reports,
  })
  const payload = {
    candidate_digest: candidate.candidate_digest,
    environments: normalized.environments,
    graph_revision,
    release_lock_digest,
    reports: normalized.reports,
    schema: SCHEMA,
  }
  return {
    ...payload,
    evidence_digest: digest(canonicalJson(payload)),
  }
}

export function verifyMultiMachineEvidenceManifest({
  candidate,
  manifest,
  reports,
}) {
  try {
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(',') !== [
        'candidate_digest',
        'environments',
        'evidence_digest',
        'graph_revision',
        'release_lock_digest',
        'reports',
        'schema',
      ].join(',')
      || manifest.schema !== SCHEMA) {
      throw new TypeError('invalid multimachine evidence manifest')
    }
    const normalized = validateInputs({
      candidate,
      environments: manifest.environments,
      graph_revision: manifest.graph_revision,
      release_lock_digest: manifest.release_lock_digest,
      reports,
    })
    const payload = {
      candidate_digest: candidate.candidate_digest,
      environments: normalized.environments,
      graph_revision: manifest.graph_revision,
      release_lock_digest: manifest.release_lock_digest,
      reports: normalized.reports,
      schema: SCHEMA,
    }
    if (manifest.candidate_digest !== candidate.candidate_digest
      || manifest.evidence_digest !== digest(canonicalJson(payload))
      || canonicalJson(manifest.reports) !== canonicalJson(normalized.reports)) {
      throw new TypeError('multimachine evidence identity mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-multimachine-evidence',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export function multiMachineEvidenceDigest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('invalid multimachine evidence manifest')
  }
  return digest(canonicalJson(manifest))
}

function validateInputs({
  candidate,
  environments,
  graph_revision,
  release_lock_digest,
  reports,
}) {
  if (candidate === null || typeof candidate !== 'object'
    || Object.keys(candidate).sort().join(',') !== [
      'artifact_digest',
      'candidate_digest',
      'graph_revision',
      'release_lock_digest',
    ].join(',')
    || !DIGEST.test(candidate.artifact_digest)
    || !DIGEST.test(candidate.candidate_digest)
    || candidate.graph_revision !== graph_revision
    || candidate.release_lock_digest !== release_lock_digest
    || !DIGEST.test(graph_revision)
    || !DIGEST.test(release_lock_digest)) {
    throw new TypeError('invalid multimachine candidate')
  }
  if (!Array.isArray(environments) || environments.length < 2) {
    throw new TypeError('at least two independent environments are required')
  }
  const environmentIds = new Set()
  const runnerIds = new Set()
  const hostDigests = new Set()
  const normalizedEnvironments = environments.map((environment) => {
    if (environment === null || typeof environment !== 'object'
      || Array.isArray(environment)
      || Object.keys(environment).sort().join(',') !== ENVIRONMENT_FIELDS.join(',')
      || typeof environment.environment_id !== 'string'
      || typeof environment.runner_id !== 'string'
      || environment.measurement_source !== 'runner'
      || environment.synthetic !== false
      || !DIGEST.test(environment.host_identity_digest)
      || !DIGEST.test(environment.toolchain_digest)
      || environmentIds.has(environment.environment_id)
      || runnerIds.has(environment.runner_id)
      || hostDigests.has(environment.host_identity_digest)) {
      throw new TypeError('invalid independent runner environment')
    }
    environmentIds.add(environment.environment_id)
    runnerIds.add(environment.runner_id)
    hostDigests.add(environment.host_identity_digest)
    return { ...environment }
  }).sort((left, right) => left.environment_id.localeCompare(right.environment_id))
  const reportIndex = indexReports(reports)
  if (!reportIndex.ok || reportIndex.values.size !== normalizedEnvironments.length) {
    throw new TypeError('invalid multimachine report set')
  }
  const normalizedReports = normalizedEnvironments.map(({ environment_id }) => {
    const report = reportIndex.values.get(environment_id)
    if (report === undefined) throw new TypeError('missing multimachine report')
    return report
  })
  return {
    environments: normalizedEnvironments,
    reports: normalizedReports,
  }
}

function indexReports(reports) {
  if (!Array.isArray(reports)) return { ok: false }
  const values = new Map()
  for (const report of reports) {
    if (report === null || typeof report !== 'object'
      || Array.isArray(report)
      || Object.keys(report).sort().join(',') !== REPORT_FIELDS.join(',')
      || typeof report.environment_id !== 'string'
      || !DIGEST.test(report.measurement_digest)
      || !DIGEST.test(report.report_digest)
      || values.has(report.environment_id)) {
      return { ok: false }
    }
    values.set(report.environment_id, report)
  }
  return { ok: true, values }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic multimachine evidence')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic multimachine evidence')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
