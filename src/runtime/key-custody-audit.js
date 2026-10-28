import {
  createHash,
  verify,
} from 'node:crypto'

import {
  releaseKeyLifecycleDigest,
  resolveReleaseKey,
} from './release-key-lifecycle.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const SCHEMA = 're.key-custody-audit@0.1.0'
const SIGNATURE_FIELDS = ['algorithm', 'key_id', 'signature_base64']
const OPERATION_FIELDS = [
  'actor_id',
  'after_lifecycle_digest',
  'before_lifecycle_digest',
  'key_id',
  'occurred_at',
  'operation',
  'sequence',
  'successor_key_id',
]

export function createKeyCustodyAudit({
  lifecycle,
  operations,
  signer,
}) {
  const lifecycle_digest = releaseKeyLifecycleDigest(lifecycle)
  validateOperations(operations)
  const keyIds = new Set(lifecycle.keys.map(({ key_id }) => key_id))
  if (signer === null || typeof signer !== 'object'
    || typeof signer.key_id !== 'string'
    || typeof signer.sign !== 'function'
    || !keyIds.has(signer.key_id)
    || operations.some(({ key_id, successor_key_id }) =>
      !keyIds.has(key_id)
      || (successor_key_id !== null && !keyIds.has(successor_key_id)))) {
    throw new TypeError('invalid key custody signer')
  }
  if (operations.at(-1).after_lifecycle_digest !== lifecycle_digest) {
    throw new TypeError('key custody final lifecycle mismatch')
  }
  const payload = {
    lifecycle_digest,
    operations: structuredClone(operations),
    schema: SCHEMA,
  }
  const signature = signer.sign(Buffer.from(canonicalJson(payload)))
  if (!Buffer.isBuffer(signature) && !(signature instanceof Uint8Array)) {
    throw new TypeError('invalid key custody signature')
  }
  const audit = {
    audit_digest: digest(canonicalJson(payload)),
    lifecycle_digest,
    operations: payload.operations,
    schema: SCHEMA,
    signature: {
      algorithm: 'ed25519',
      key_id: signer.key_id,
      signature_base64: Buffer.from(signature).toString('base64'),
    },
  }
  validateAuditShape(audit)
  return audit
}

export function verifyKeyCustodyAudit({
  audit,
  lifecycle,
  now,
}) {
  try {
    validateAuditShape(audit)
    const lifecycle_digest = releaseKeyLifecycleDigest(lifecycle)
    if (audit.lifecycle_digest !== lifecycle_digest
      || audit.operations.at(-1).after_lifecycle_digest !== lifecycle_digest
      || audit.audit_digest !== digest(canonicalJson({
        lifecycle_digest,
        operations: audit.operations,
        schema: SCHEMA,
      }))
      || audit.signature.algorithm !== lifecycle.algorithm) {
      throw new TypeError('key custody audit identity mismatch')
    }
    const resolved = resolveReleaseKey(lifecycle, {
      algorithm: audit.signature.algorithm,
      key_id: audit.signature.key_id,
      now,
    })
    if (!resolved.ok) throw new TypeError(resolved.code)
    const payload = {
      lifecycle_digest,
      operations: audit.operations,
      schema: SCHEMA,
    }
    const valid = verify(
      null,
      Buffer.from(canonicalJson(payload)),
      resolved.publicKey,
      Buffer.from(audit.signature.signature_base64, 'base64'),
    )
    if (!valid) throw new TypeError('invalid key custody signature')
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-key-custody-audit',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

function validateAuditShape(audit) {
  if (audit === null || typeof audit !== 'object' || Array.isArray(audit)
    || audit.schema !== SCHEMA
    || Object.keys(audit).sort().join(',') !== [
      'audit_digest',
      'lifecycle_digest',
      'operations',
      'schema',
      'signature',
    ].join(',')
    || !DIGEST.test(audit.audit_digest)
    || !DIGEST.test(audit.lifecycle_digest)) {
    throw new TypeError('invalid key custody audit')
  }
  validateOperations(audit.operations)
  if (audit.signature === null
    || typeof audit.signature !== 'object'
    || Array.isArray(audit.signature)
    || Object.keys(audit.signature).sort().join(',') !== SIGNATURE_FIELDS.join(',')
    || audit.signature.algorithm !== 'ed25519'
    || typeof audit.signature.key_id !== 'string'
    || !/^[A-Za-z0-9._:-]+$/u.test(audit.signature.key_id)
    || typeof audit.signature.signature_base64 !== 'string'
    || audit.signature.signature_base64.length === 0) {
    throw new TypeError('invalid key custody signature')
  }
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError('invalid key custody operations')
  }
  let previousAfter = null
  operations.forEach((operation, index) => {
    if (operation === null || typeof operation !== 'object'
      || Array.isArray(operation)
      || Object.keys(operation).sort().join(',') !== OPERATION_FIELDS.join(',')
      || operation.sequence !== index + 1
      || typeof operation.actor_id !== 'string'
      || operation.actor_id.length === 0
      || !DIGEST.test(operation.before_lifecycle_digest)
      || !DIGEST.test(operation.after_lifecycle_digest)
      || typeof operation.key_id !== 'string'
      || !TIME.test(operation.occurred_at)
      || !['confirm', 'create', 'expire', 'revoke', 'rotate'].includes(operation.operation)
      || (operation.operation === 'rotate'
        ? typeof operation.successor_key_id !== 'string'
        : operation.successor_key_id !== null)) {
      throw new TypeError('invalid key custody operation')
    }
    if (previousAfter !== null && operation.before_lifecycle_digest !== previousAfter) {
      throw new TypeError('key custody operation chain mismatch')
    }
    previousAfter = operation.after_lifecycle_digest
  })
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic key custody audit')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic key custody audit')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
