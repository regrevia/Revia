import {
  createHash,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SIGNATURE_SCHEMA = 're.release-signature@0.1.0'
const PAYLOAD_SCHEMA = 're.release-signature-payload@0.1.0'

export function releaseSignatureDigest(envelope) {
  return digest(canonicalJson(envelope))
}

export function createReleaseSignature({
  artifact,
  expires_at,
  issued_at,
  key_id,
  lock,
  privateKey,
  publicKey,
}) {
  const payload = signaturePayload({
    artifact,
    expires_at,
    issued_at,
    key_id,
    lock,
    publicKey,
  })
  const bytes = Buffer.from(canonicalJson(payload), 'utf8')
  const signature = sign(null, bytes, privateKey)
  return {
    payload,
    schema: SIGNATURE_SCHEMA,
    signature_base64: signature.toString('base64'),
  }
}

export async function createReleaseSignatureWithSigner({
  artifact,
  expires_at,
  issued_at,
  lock,
  signer,
}) {
  if (signer === null || typeof signer !== 'object'
    || signer.algorithm !== 'ed25519'
    || typeof signer.key_id !== 'string'
    || typeof signer.sign !== 'function'
    || signer.publicKey === undefined) {
    throw new TypeError('invalid release signer')
  }
  const payload = signaturePayload({
    artifact,
    expires_at,
    issued_at,
    key_id: signer.key_id,
    lock,
    publicKey: signer.publicKey,
  })
  const signature = await signer.sign(Buffer.from(canonicalJson(payload), 'utf8'))
  if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
    throw new TypeError('invalid release signer output')
  }
  return {
    payload,
    schema: SIGNATURE_SCHEMA,
    signature_base64: Buffer.from(signature).toString('base64'),
  }
}

export function verifyReleaseSignature({
  artifact,
  envelope,
  lock,
  now = new Date().toISOString(),
  publicKey,
}) {
  try {
    validateEnvelope(envelope)
    validateArtifactBinding(envelope.payload, artifact, lock)
    const key = normalizePublicKey(publicKey)
    const exported = key.export({ format: 'der', type: 'spki' })
    if (digest(exported) !== envelope.payload.public_key_digest) {
      throw new TypeError('release signature public key mismatch')
    }
    const instant = parseTime(now, 'now')
    const issued = parseTime(envelope.payload.issued_at, 'issued_at')
    const expires = parseTime(envelope.payload.expires_at, 'expires_at')
    if (issued > expires || instant < issued || instant > expires) {
      throw new TypeError('release signature outside validity window')
    }
    const valid = verify(
      null,
      Buffer.from(canonicalJson(envelope.payload), 'utf8'),
      key,
      Buffer.from(envelope.signature_base64, 'base64'),
    )
    if (!valid) throw new TypeError('release signature verification failed')
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-release-signature',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export function verifyReleaseSignatureWithPolicy({
  artifact,
  envelope,
  keyPolicy,
  lock,
  now = new Date().toISOString(),
}) {
  try {
    if (keyPolicy === null || typeof keyPolicy !== 'object'
      || typeof keyPolicy.resolve !== 'function') {
      throw new TypeError('invalid release key policy')
    }
    validateEnvelope(envelope)
    const resolved = keyPolicy.resolve({
      algorithm: envelope.payload.signature_algorithm,
      key_id: envelope.payload.key_id,
      now,
    })
    if (resolved === null || typeof resolved !== 'object'
      || resolved.ok !== true || resolved.publicKey === undefined) {
      throw new TypeError(resolved?.code ?? 'release key unavailable')
    }
    return verifyReleaseSignature({
      artifact,
      envelope,
      lock,
      now,
      publicKey: resolved.publicKey,
    })
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-release-key-policy',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

function signaturePayload({
  artifact,
  expires_at,
  issued_at,
  key_id,
  lock,
  publicKey,
}) {
  if (lock === null || typeof lock !== 'object'
    || artifact === null || typeof artifact !== 'object'
    || typeof key_id !== 'string' || key_id.length === 0) {
    throw new TypeError('invalid release signature input')
  }
  const key = normalizePublicKey(publicKey)
  parseTime(issued_at, 'issued_at')
  parseTime(expires_at, 'expires_at')
  return {
    artifact_digest: artifact.artifact_digest,
    backend: lock.build_artifact.backend,
    expires_at,
    graph_revision: lock.graph_revision,
    issued_at,
    key_id,
    lock_digest: digest(canonicalJson(lock)),
    payload_schema: PAYLOAD_SCHEMA,
    profile_digest: lock.profile.digest,
    public_key_digest: digest(key.export({ format: 'der', type: 'spki' })),
    release: lock.release,
    signature_algorithm: 'ed25519',
    toolchain_digest: lock.toolchain.digest,
  }
}

function validateEnvelope(envelope) {
  if (envelope === null || typeof envelope !== 'object'
    || envelope.schema !== SIGNATURE_SCHEMA
    || !plainObject(envelope.payload)
    || typeof envelope.signature_base64 !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.signature_base64)) {
    throw new TypeError('invalid release signature envelope')
  }
  const fields = [
    'artifact_digest',
    'backend',
    'expires_at',
    'graph_revision',
    'issued_at',
    'key_id',
    'lock_digest',
    'payload_schema',
    'profile_digest',
    'public_key_digest',
    'release',
    'signature_algorithm',
    'toolchain_digest',
  ]
  if (Object.keys(envelope.payload).sort().join(',') !== fields.join(',')) {
    throw new TypeError('invalid release signature payload fields')
  }
  if (envelope.payload.payload_schema !== PAYLOAD_SCHEMA
    || envelope.payload.signature_algorithm !== 'ed25519'
    || !DIGEST.test(envelope.payload.artifact_digest)
    || !DIGEST.test(envelope.payload.graph_revision)
    || !DIGEST.test(envelope.payload.lock_digest)
    || !DIGEST.test(envelope.payload.profile_digest)
    || !DIGEST.test(envelope.payload.public_key_digest)
    || !DIGEST.test(envelope.payload.toolchain_digest)
    || typeof envelope.payload.backend !== 'string'
    || typeof envelope.payload.release !== 'string'
    || typeof envelope.payload.key_id !== 'string') {
    throw new TypeError('invalid release signature payload')
  }
}

function validateArtifactBinding(payload, artifact, lock) {
  if (artifact === null || typeof artifact !== 'object'
    || lock === null || typeof lock !== 'object'
    || artifact.artifact_digest !== payload.artifact_digest
    || artifact.artifact_digest !== lock.build_artifact.artifact_digest
    || payload.graph_revision !== lock.graph_revision
    || payload.backend !== lock.build_artifact.backend
    || payload.profile_digest !== lock.profile.digest
    || payload.toolchain_digest !== lock.toolchain.digest
    || payload.release !== lock.release
    || payload.lock_digest !== digest(canonicalJson(lock))) {
    throw new TypeError('release signature binding mismatch')
  }
}

function parseTime(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError(`invalid release signature ${field}`)
  }
  const time = Date.parse(value)
  if (!Number.isSafeInteger(time)) throw new TypeError(`invalid release signature ${field}`)
  return time
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic release signature value')
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

function normalizePublicKey(value) {
  return value?.type === 'public' ? value : createPublicKey(value)
}
