import { createHash } from 'node:crypto'

import {
  benchmarkMatrixDigest,
  benchmarkReportDigest,
  validateDigestPinnedBenchmarkReport,
} from './benchmark-matrix.js'
import {
  nativeBackendCandidateDigest,
  validateNativeBackendCandidate,
} from './native-backend-candidate.js'
import {
  releaseSignatureDigest,
  verifyReleaseSignatureWithPolicy,
} from './release-signature.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MANIFEST_SCHEMA = 're.multienvironment-benchmark-manifest@0.1.0'
const AGGREGATE_SCHEMA = 're.multienvironment-release-evidence@0.1.0'

export function createMultiEnvironmentBenchmarkManifest({
  budget_policy_digest,
  candidate,
  environments,
  envelope,
  lock,
  matrix,
}) {
  if (!DIGEST.test(budget_policy_digest)) {
    throw new TypeError('invalid benchmark budget policy digest')
  }
  const normalizedEnvironments = normalizeEnvironments(environments)
  const releaseLockDigest = envelope?.payload?.lock_digest
  const candidateValidation = validateNativeBackendCandidate(candidate, {
    graph_revision: lock?.graph_revision,
    release_lock_digest: releaseLockDigest,
  })
  if (!candidateValidation.ok
    || candidate.artifact_digest !== envelope?.payload?.artifact_digest
    || candidate.toolchain_digest !== lock?.toolchain?.digest
    || envelope?.payload?.graph_revision !== lock?.graph_revision
    || envelope?.payload?.toolchain_digest !== lock?.toolchain?.digest) {
    throw new TypeError('invalid signed native benchmark identity')
  }
  return {
    budget_policy_digest,
    environments: normalizedEnvironments,
    graph_revision: lock.graph_revision,
    matrix_digest: benchmarkMatrixDigest(matrix),
    native_candidate_digest: nativeBackendCandidateDigest(candidate),
    release_lock_digest: releaseLockDigest,
    release_signature_digest: releaseSignatureDigest(envelope),
    schema: MANIFEST_SCHEMA,
  }
}

export function aggregateMultiEnvironmentBenchmarkReports({
  artifact,
  candidate,
  envelope,
  keyPolicy,
  lock,
  manifest,
  matrix,
  now,
  reports,
}) {
  try {
    validateManifest(manifest)
    const signature = verifyReleaseSignatureWithPolicy({
      artifact,
      envelope,
      keyPolicy,
      lock,
      now,
    })
    if (!signature.ok) return rejected('invalid-multienvironment-release-signature')

    const candidateValidation = validateNativeBackendCandidate(candidate, {
      graph_revision: lock.graph_revision,
      release_lock_digest: envelope.payload.lock_digest,
    })
    if (!candidateValidation.ok
      || artifact.artifact_digest !== candidate.artifact_digest
      || manifest.graph_revision !== lock.graph_revision
      || manifest.release_lock_digest !== envelope.payload.lock_digest
      || manifest.matrix_digest !== benchmarkMatrixDigest(matrix)
      || manifest.native_candidate_digest !== nativeBackendCandidateDigest(candidate)
      || manifest.release_signature_digest !== releaseSignatureDigest(envelope)
      || manifest.budget_policy_digest === undefined) {
      return rejected('multienvironment-release-identity-mismatch')
    }

    const declared = new Map(manifest.environments.map(({ id, ...environment }) =>
      [id, environment]))
    const indexed = indexReports(reports)
    if (!indexed.ok) return rejected(indexed.code)
    const diagnostics = []
    for (const environmentId of declared.keys()) {
      if (!indexed.values.has(environmentId)) {
        diagnostics.push({
          code: 'missing-multienvironment-report',
          environment_id: environmentId,
        })
      }
    }
    for (const environmentId of indexed.values.keys()) {
      if (!declared.has(environmentId)) {
        diagnostics.push({
          code: 'unknown-multienvironment-report',
          environment_id: environmentId,
        })
      }
    }
    if (diagnostics.length > 0) return { diagnostics, ok: false }

    const evidence = []
    const failedEnvironments = []
    for (const [environmentId, environment] of declared) {
      const report = indexed.values.get(environmentId)
      const validated = validateDigestPinnedBenchmarkReport(report, matrix, {
        budget_policy_digest: manifest.budget_policy_digest,
        environment,
        graph_revision: manifest.graph_revision,
        release_lock_digest: manifest.release_lock_digest,
      })
      if (!validated.ok) {
        for (const diagnostic of validated.diagnostics) {
          diagnostics.push({ ...diagnostic, environment_id: environmentId })
        }
        continue
      }
      const selected = report.runs.find(({ candidate: id }) => id === candidate.backend_id)
      if (selected?.artifact_digest !== candidate.artifact_digest) {
        diagnostics.push({
          code: 'benchmark-native-artifact-mismatch',
          environment_id: environmentId,
        })
        continue
      }
      if (!selected.eligible) failedEnvironments.push(environmentId)
      evidence.push({
        environment_id: environmentId,
        report_digest: benchmarkReportDigest(report),
      })
    }
    if (diagnostics.length > 0) return { diagnostics, ok: false }

    evidence.sort((left, right) =>
      Buffer.compare(Buffer.from(left.environment_id), Buffer.from(right.environment_id)))
    failedEnvironments.sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const aggregate = {
      eligible: failedEnvironments.length === 0,
      failed_environments: failedEnvironments,
      manifest_digest: multiEnvironmentBenchmarkManifestDigest(manifest),
      native_candidate_digest: manifest.native_candidate_digest,
      release_signature_digest: manifest.release_signature_digest,
      reports: evidence,
      schema: AGGREGATE_SCHEMA,
    }
    return {
      ok: true,
      value: {
        ...aggregate,
        aggregate_digest: canonicalDigest(aggregate),
      },
    }
  } catch {
    return rejected('invalid-multienvironment-release-evidence')
  }
}

export function multiEnvironmentBenchmarkManifestDigest(manifest) {
  return canonicalDigest(manifest)
}

function normalizeEnvironments(environments) {
  if (!Array.isArray(environments) || environments.length < 2) {
    throw new TypeError('at least two benchmark environments are required')
  }
  const ids = new Set()
  const normalized = environments.map((environment) => {
    if (!plainObject(environment)
      || Object.keys(environment).sort().join(',') !== [
        'hardware_digest',
        'id',
        'operating_system_digest',
        'toolchain_digest',
      ].join(',')
      || typeof environment.id !== 'string'
      || environment.id.length === 0
      || !DIGEST.test(environment.hardware_digest)
      || !DIGEST.test(environment.operating_system_digest)
      || !DIGEST.test(environment.toolchain_digest)) {
      throw new TypeError('invalid benchmark environment')
    }
    if (ids.has(environment.id)) throw new TypeError('duplicate benchmark environment')
    ids.add(environment.id)
    return { ...environment }
  })
  return normalized.sort((left, right) =>
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
}

function validateManifest(manifest) {
  if (!plainObject(manifest)
    || manifest.schema !== MANIFEST_SCHEMA
    || Object.keys(manifest).sort().join(',') !== [
      'budget_policy_digest',
      'environments',
      'graph_revision',
      'matrix_digest',
      'native_candidate_digest',
      'release_lock_digest',
      'release_signature_digest',
      'schema',
    ].join(',')
    || !DIGEST.test(manifest.budget_policy_digest)
    || !DIGEST.test(manifest.graph_revision)
    || !DIGEST.test(manifest.matrix_digest)
    || !DIGEST.test(manifest.native_candidate_digest)
    || !DIGEST.test(manifest.release_lock_digest)
    || !DIGEST.test(manifest.release_signature_digest)) {
    throw new TypeError('invalid multi-environment benchmark manifest')
  }
  const normalized = normalizeEnvironments(manifest.environments)
  if (canonicalJson(normalized) !== canonicalJson(manifest.environments)) {
    throw new TypeError('non-canonical benchmark environment order')
  }
}

function indexReports(reports) {
  if (!Array.isArray(reports)) {
    return { code: 'invalid-multienvironment-report-set', ok: false }
  }
  const values = new Map()
  for (const entry of reports) {
    if (!plainObject(entry)
      || Object.keys(entry).sort().join(',') !== 'environment_id,report'
      || typeof entry.environment_id !== 'string'
      || values.has(entry.environment_id)) {
      return { code: 'duplicate-multienvironment-report', ok: false }
    }
    values.set(entry.environment_id, entry.report)
  }
  return { ok: true, values }
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic multi-environment evidence')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (plainObject(value)) {
    if (seen.has(value)) throw new TypeError('cyclic multi-environment evidence')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
