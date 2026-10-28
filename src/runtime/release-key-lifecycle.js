import {
  createHash,
  createPublicKey,
} from 'node:crypto'

import {
  nativeBackendCandidateDigest,
  validateNativeBackendCandidate,
} from './native-backend-candidate.js'
import {
  releaseSignatureDigest,
  verifyReleaseSignatureWithPolicy,
} from './release-signature.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const LIFECYCLE_SCHEMA = 're.release-key-lifecycle@0.1.0'
const DISTRIBUTION_SCHEMA = 're.signed-release-distribution@0.1.0'

export function createReleaseKeyLifecycle({
  algorithm,
  current_key_id,
  keys,
}) {
  const lifecycle = {
    algorithm,
    current_key_id,
    keys: structuredClone(keys),
    schema: LIFECYCLE_SCHEMA,
  }
  validateLifecycle(lifecycle)
  return lifecycle
}

export function createReleaseKeyPolicy(lifecycle) {
  validateLifecycle(lifecycle)
  return Object.freeze({
    resolve(request) {
      return resolveReleaseKey(lifecycle, request)
    },
  })
}

export function resolveReleaseKey(lifecycle, {
  algorithm,
  key_id,
  now,
}) {
  try {
    validateLifecycle(lifecycle)
    if (algorithm !== lifecycle.algorithm) throw new TypeError('release-key-algorithm')
    const key = lifecycle.keys.find((entry) => entry.key_id === key_id)
    if (key === undefined) throw new TypeError('release-key-unknown')
    if (key.status === 'revoked') throw new TypeError('release-key-revoked')
    if (key.status === 'expired') throw new TypeError('release-key-expired')
    const instant = parseTime(now)
    if (instant < parseTime(key.valid_from)
      || (key.valid_until !== null && instant > parseTime(key.valid_until))) {
      throw new TypeError('release-key-outside-validity')
    }
    if (key.status === 'rotated') {
      const successor = lifecycle.keys.find(({ key_id: successorKeyId }) =>
        successorKeyId === key.successor_key_id)
      const successorResult = resolveReleaseKey(lifecycle, {
        algorithm,
        key_id: successor.key_id,
        now,
      })
      if (!successorResult.ok) throw new TypeError('release-key-successor-unresolvable')
    }
    return {
      ok: true,
      publicKey: createPublicKey({
        format: 'der',
        key: Buffer.from(key.public_key_base64, 'base64'),
        type: 'spki',
      }),
    }
  } catch (error) {
    return { code: error.message, ok: false }
  }
}

export function createSignedDistributionManifest({
  aggregate_evidence_digest,
  artifact,
  candidate,
  envelope,
  lifecycle,
  lock,
}) {
  validateDistributionInputs({
    aggregate_evidence_digest,
    artifact,
    candidate,
    envelope,
    lifecycle,
    lock,
  })
  if (envelope.payload.key_id !== lifecycle.current_key_id) {
    throw new TypeError('distribution signer is not current')
  }
  return {
    aggregate_evidence_digest,
    artifact_digest: artifact.artifact_digest,
    candidate_digest: nativeBackendCandidateDigest(candidate),
    key_id: envelope.payload.key_id,
    key_lifecycle_digest: releaseKeyLifecycleDigest(lifecycle),
    release_lock_digest: envelope.payload.lock_digest,
    schema: DISTRIBUTION_SCHEMA,
    signature_digest: releaseSignatureDigest(envelope),
  }
}

export function verifySignedDistributionManifest({
  aggregate_evidence_digest,
  artifact,
  candidate,
  envelope,
  keyPolicy,
  lifecycle,
  lock,
  manifest,
  now,
}) {
  try {
    validateDistributionInputs({
      aggregate_evidence_digest,
      artifact,
      candidate,
      envelope,
      lifecycle,
      lock,
    })
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schema !== DISTRIBUTION_SCHEMA
      || Object.keys(manifest).sort().join(',') !== [
        'aggregate_evidence_digest',
        'artifact_digest',
        'candidate_digest',
        'key_id',
        'key_lifecycle_digest',
        'release_lock_digest',
        'schema',
        'signature_digest',
      ].join(',')
      || manifest.aggregate_evidence_digest !== aggregate_evidence_digest
      || manifest.artifact_digest !== artifact.artifact_digest
      || manifest.candidate_digest !== nativeBackendCandidateDigest(candidate)
      || manifest.key_id !== envelope.payload.key_id
      || manifest.key_lifecycle_digest !== releaseKeyLifecycleDigest(lifecycle)
      || manifest.release_lock_digest !== envelope.payload.lock_digest
      || manifest.signature_digest !== releaseSignatureDigest(envelope)) {
      throw new TypeError('signed distribution identity mismatch')
    }
    const signature = verifyReleaseSignatureWithPolicy({
      artifact,
      envelope,
      keyPolicy,
      lock,
      now,
    })
    if (!signature.ok) throw new TypeError('signed distribution signature rejected')
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-signed-release-distribution',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export function releaseKeyLifecycleDigest(lifecycle) {
  validateLifecycle(lifecycle)
  return digest(canonicalJson(lifecycle))
}

function validateDistributionInputs({
  aggregate_evidence_digest,
  artifact,
  candidate,
  envelope,
  lifecycle,
  lock,
}) {
  validateLifecycle(lifecycle)
  const candidateValidation = validateNativeBackendCandidate(candidate, {
    graph_revision: lock?.graph_revision,
    release_lock_digest: envelope?.payload?.lock_digest,
  })
  if (!DIGEST.test(aggregate_evidence_digest)
    || !candidateValidation.ok
    || artifact?.artifact_digest !== candidate.artifact_digest
    || artifact?.artifact_digest !== envelope?.payload?.artifact_digest
    || artifact?.artifact_digest !== lock?.build_artifact?.artifact_digest
    || envelope?.payload?.graph_revision !== lock?.graph_revision
    || envelope?.payload?.toolchain_digest !== lock?.toolchain?.digest) {
    throw new TypeError('invalid signed distribution input')
  }
}

function validateLifecycle(lifecycle) {
  if (lifecycle === null || typeof lifecycle !== 'object' || Array.isArray(lifecycle)
    || lifecycle.schema !== LIFECYCLE_SCHEMA
    || lifecycle.algorithm !== 'ed25519'
    || typeof lifecycle.current_key_id !== 'string'
    || !Array.isArray(lifecycle.keys)
    || lifecycle.keys.length === 0
    || Object.keys(lifecycle).sort().join(',') !== 'algorithm,current_key_id,keys,schema') {
    throw new TypeError('invalid release key lifecycle')
  }
  const ids = new Set()
  let activeCount = 0
  for (const key of lifecycle.keys) {
    if (key === null || typeof key !== 'object' || Array.isArray(key)
      || Object.keys(key).sort().join(',') !== [
        'key_id',
        'public_key_base64',
        'public_key_digest',
        'status',
        'successor_key_id',
        'valid_from',
        'valid_until',
      ].join(',')
      || typeof key.key_id !== 'string'
      || key.key_id.length === 0
      || ids.has(key.key_id)
      || !['active', 'expired', 'revoked', 'rotated'].includes(key.status)
      || (key.successor_key_id !== null && typeof key.successor_key_id !== 'string')
      || !TIME.test(key.valid_from)
      || (key.valid_until !== null && !TIME.test(key.valid_until))) {
      throw new TypeError('invalid release key lifecycle entry')
    }
    const bytes = Buffer.from(key.public_key_base64, 'base64')
    createPublicKey({ format: 'der', key: bytes, type: 'spki' })
    if (digest(bytes) !== key.public_key_digest) {
      throw new TypeError('release key public digest mismatch')
    }
    if (key.status === 'active') activeCount += 1
    if (key.valid_until !== null
      && parseTime(key.valid_until) < parseTime(key.valid_from)) {
      throw new TypeError('invalid release key validity window')
    }
    ids.add(key.key_id)
  }
  const current = lifecycle.keys.find(({ key_id }) => key_id === lifecycle.current_key_id)
  if (activeCount !== 1 || current?.status !== 'active') {
    throw new TypeError('invalid current release key')
  }
  for (const key of lifecycle.keys) {
    if (key.status === 'rotated'
      && (key.successor_key_id === null
        || key.successor_key_id === key.key_id
        || !ids.has(key.successor_key_id)
        || lifecycle.keys.find(({ key_id }) => key_id === key.successor_key_id)?.status !== 'active'
        || key.valid_until === null)) {
      throw new TypeError('invalid release key successor')
    }
    if (key.status !== 'rotated' && key.successor_key_id !== null) {
      throw new TypeError('unexpected release key successor')
    }
  }
}

function parseTime(value) {
  if (!TIME.test(value)) throw new TypeError('invalid release key time')
  const time = Date.parse(value)
  if (!Number.isSafeInteger(time)) throw new TypeError('invalid release key time')
  return time
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic release key lifecycle')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic release key lifecycle')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
