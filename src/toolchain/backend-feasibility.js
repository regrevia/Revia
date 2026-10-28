import { createHash } from 'node:crypto'

export const BACKEND_FEASIBILITY_SCHEMA =
  're.backend-feasibility@0.1.0'
export const BACKEND_FEASIBILITY_PROFILE =
  're.backend-feasibility@0.1.0'

export const BACKEND_FEASIBILITY_CANDIDATES = Object.freeze([
  Object.freeze({
    artifact_kind: 'wasm-module',
    id: 'wasm',
    role: 'portable-candidate',
  }),
  Object.freeze({
    artifact_kind: 'native-aot',
    id: 'aot-llvm',
    role: 'production-candidate',
  }),
  Object.freeze({
    artifact_kind: 'native-aot',
    id: 'cranelift',
    role: 'production-candidate',
  }),
])

export const BACKEND_FEASIBILITY_PROBES = Object.freeze([
  Object.freeze({
    id: 'graph-identity',
    purpose: 'checked-graph and release identity can be carried to a future backend',
  }),
  Object.freeze({
    id: 'semantic-oracle',
    purpose: 'WP-222 execution ABI can be compared without changing semantics',
  }),
  Object.freeze({
    id: 'memory-contract',
    purpose: 'the frozen backend memory contract can be reported',
  }),
  Object.freeze({
    id: 'release-lock',
    purpose: 'future artifacts can bind the current release identity',
  }),
  Object.freeze({
    id: 'target-toolchain',
    purpose: 'a target toolchain is available on an external runner',
  }),
  Object.freeze({
    id: 'target-runtime',
    purpose: 'a target runtime can be invoked by an external runner',
  }),
])

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REPORT_FIELDS = [
  'candidates',
  'graph_revision',
  'profile',
  'release_lock_digest',
  'report_digest',
  'schema',
  'status',
  'toolchain_digest',
]
const CANDIDATE_FIELDS = [
  'artifact_kind',
  'candidate',
  'probes',
  'role',
  'status',
]
const PROBE_FIELDS = ['evidence_digest', 'id', 'provenance', 'status']
const PENDING_FIELDS = ['id', 'reason', 'status']
const PROVENANCE_FIELDS = [
  'environment_id',
  'host_identity_digest',
  'measurement_source',
  'runner_id',
  'synthetic',
  'toolchain_digest',
]
const PENDING_REASON = 'no external feasibility evidence supplied'

export function createBackendFeasibilityReport({
  graph_revision,
  release_lock_digest,
  toolchain_digest,
  observations = [],
} = {}) {
  const identity = validateIdentity({
    graph_revision,
    release_lock_digest,
    toolchain_digest,
  })
  if (!identity.ok) return identity
  const normalized = normalizeObservations(observations, toolchain_digest)
  if (!normalized.ok) return normalized

  const candidates = BACKEND_FEASIBILITY_CANDIDATES.map((candidate) => {
    const reported = new Map(
      normalized.value
        .filter((entry) => entry.candidate === candidate.id)
        .map((entry) => [entry.probe, entry]),
    )
    const probes = BACKEND_FEASIBILITY_PROBES.map((probe) => {
      const entry = reported.get(probe.id)
      if (entry === undefined) {
        return {
          id: probe.id,
          reason: PENDING_REASON,
          status: 'pending',
        }
      }
      return {
        evidence_digest: entry.evidence_digest,
        id: probe.id,
        provenance: entry.provenance,
        status: 'reported',
      }
    })
    return {
      artifact_kind: candidate.artifact_kind,
      candidate: candidate.id,
      probes,
      role: candidate.role,
      status: probes.some(({ status }) => status === 'reported')
        ? 'reported'
        : 'pending',
    }
  })
  const content = {
    candidates,
    graph_revision,
    profile: BACKEND_FEASIBILITY_PROFILE,
    release_lock_digest,
    schema: BACKEND_FEASIBILITY_SCHEMA,
    status: candidates.some(({ status }) => status === 'reported')
      ? 'reported'
      : 'pending',
    toolchain_digest,
  }
  const report = {
    ...content,
    report_digest: backendFeasibilityReportDigest(content),
  }
  const verified = verifyBackendFeasibilityReport(report, {
    graph_revision,
    release_lock_digest,
    toolchain_digest,
  })
  return verified.ok ? { ok: true, value: report } : verified
}

export function verifyBackendFeasibilityReport(report, {
  graph_revision,
  release_lock_digest,
  toolchain_digest,
} = {}) {
  try {
    exactFields(report, REPORT_FIELDS, 'report')
    if (report.schema !== BACKEND_FEASIBILITY_SCHEMA
      || report.profile !== BACKEND_FEASIBILITY_PROFILE
      || !['pending', 'reported'].includes(report.status)) {
      fail('backend-feasibility-schema-mismatch')
    }
    const identity = validateIdentity({
      graph_revision: report.graph_revision,
      release_lock_digest: report.release_lock_digest,
      toolchain_digest: report.toolchain_digest,
    })
    if (!identity.ok) fail(identity.diagnostics[0].code)
    for (const [field, expected] of [
      ['graph_revision', graph_revision],
      ['release_lock_digest', release_lock_digest],
      ['toolchain_digest', toolchain_digest],
    ]) {
      if (expected !== undefined && report[field] !== expected) {
        fail(`backend-feasibility-${field.replaceAll('_', '-')}-mismatch`)
      }
    }

    if (!Array.isArray(report.candidates)
      || report.candidates.length !== BACKEND_FEASIBILITY_CANDIDATES.length) {
      fail('backend-feasibility-candidate-set-mismatch')
    }
    let anyReported = false
    for (let index = 0; index < BACKEND_FEASIBILITY_CANDIDATES.length; index += 1) {
      const expected = BACKEND_FEASIBILITY_CANDIDATES[index]
      const actual = report.candidates[index]
      exactFields(actual, CANDIDATE_FIELDS, 'candidate')
      if (actual.candidate !== expected.id
        || actual.artifact_kind !== expected.artifact_kind
        || actual.role !== expected.role
        || !['pending', 'reported'].includes(actual.status)) {
        fail('backend-feasibility-candidate-invalid')
      }
      if (!Array.isArray(actual.probes)
        || actual.probes.length !== BACKEND_FEASIBILITY_PROBES.length) {
        fail('backend-feasibility-probe-set-mismatch')
      }
      let candidateReported = false
      for (let probeIndex = 0;
        probeIndex < BACKEND_FEASIBILITY_PROBES.length;
        probeIndex += 1) {
        const probe = BACKEND_FEASIBILITY_PROBES[probeIndex]
        const entry = actual.probes[probeIndex]
        if (entry?.status === 'pending') {
          exactFields(entry, PENDING_FIELDS, 'pending')
          if (entry.id !== probe.id || entry.reason !== PENDING_REASON) {
            fail('backend-feasibility-pending-invalid')
          }
          continue
        }
        exactFields(entry, PROBE_FIELDS, 'reported')
        if (entry.id !== probe.id
          || entry.status !== 'reported'
          || !DIGEST.test(entry.evidence_digest)) {
          fail('backend-feasibility-reported-invalid')
        }
        validateProvenance(entry.provenance, report.toolchain_digest)
        candidateReported = true
      }
      if ((actual.status === 'reported') !== candidateReported) {
        fail('backend-feasibility-candidate-status-mismatch')
      }
      anyReported ||= candidateReported
    }
    if ((report.status === 'reported') !== anyReported) {
      fail('backend-feasibility-status-mismatch')
    }
    if (report.report_digest !== backendFeasibilityReportDigest(report)) {
      fail('backend-feasibility-report-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{ code: error?.code ?? 'invalid-backend-feasibility-report' }],
      ok: false,
    }
  }
}

export function backendFeasibilityReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid backend feasibility report')
  const { report_digest: ignored, ...content } = report
  return digest(canonicalJson(content))
}

function validateIdentity(identity) {
  if (!plainObject(identity)
    || !DIGEST.test(identity.graph_revision)
    || !DIGEST.test(identity.release_lock_digest)
    || !DIGEST.test(identity.toolchain_digest)) {
    return rejected('backend-feasibility-identity-invalid')
  }
  return { ok: true }
}

function normalizeObservations(observations, toolchain_digest) {
  if (!Array.isArray(observations)) {
    return rejected('backend-feasibility-observations-invalid')
  }
  const seen = new Set()
  const normalized = []
  for (const entry of observations) {
    try {
      exactFields(entry, [
        'candidate',
        'evidence_digest',
        'probe',
        'provenance',
        'status',
      ], 'observation')
      if (!BACKEND_FEASIBILITY_CANDIDATES.some(
        ({ id }) => id === entry.candidate,
      ) || !BACKEND_FEASIBILITY_PROBES.some(
        ({ id }) => id === entry.probe,
      ) || entry.status !== 'reported'
        || !DIGEST.test(entry.evidence_digest)
        || seen.has(`${entry.candidate}:${entry.probe}`)) {
        fail('backend-feasibility-observation-invalid')
      }
      validateProvenance(entry.provenance, toolchain_digest)
      seen.add(`${entry.candidate}:${entry.probe}`)
      normalized.push({
        candidate: entry.candidate,
        evidence_digest: entry.evidence_digest,
        probe: entry.probe,
        provenance: structuredClone(entry.provenance),
        status: 'reported',
      })
    } catch (error) {
      return {
        diagnostics: [{
          code: error?.code ?? 'invalid-backend-feasibility-observation',
        }],
        ok: false,
      }
    }
  }
  return { ok: true, value: normalized }
}

function validateProvenance(value, toolchain_digest) {
  exactFields(value, PROVENANCE_FIELDS, 'provenance')
  if (typeof value.environment_id !== 'string'
    || value.environment_id.length === 0
    || typeof value.runner_id !== 'string'
    || value.runner_id.length === 0
    || !DIGEST.test(value.host_identity_digest)
    || value.measurement_source !== 'runner'
    || value.synthetic !== false
    || !DIGEST.test(value.toolchain_digest)
    || value.toolchain_digest !== toolchain_digest) {
    fail('backend-feasibility-provenance-invalid')
  }
}

function exactFields(value, fields, scope) {
  if (!plainObject(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    fail(`backend-feasibility-${scope}-fields-invalid`)
  }
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
