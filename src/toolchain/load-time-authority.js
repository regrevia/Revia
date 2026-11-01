import { createHash } from 'node:crypto'

export const LOAD_TIME_AUTHORITY_SCHEMA =
  're.load-time-authority-pin@0.1.0'
export const LOAD_TIME_AUTHORITY_STATUS = 'REVIEWED'
export const LOAD_TIME_VERIFIED_STATUS = 'VERIFIED'
export const LOAD_TIME_DRIFT_STATUS = 'DRIFTED'

const HASH_ALGORITHM = 'sha256'
const CANONICALIZATION = 're.canonical-json@1'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const PIN_FIELDS = [
  'build_artifact',
  'canonical_bytes',
  'canonical_graph',
  'canonicalization',
  'command',
  'environment',
  'hash_algorithm',
  'load_process',
  'pin_digest',
  'reviewed_source',
  'runtime',
  'runtime_result',
  'schema',
  'status',
]

export function createLoadTimeAuthorityPin({
  reviewedSource,
  canonicalGraph,
  buildArtifact,
  runtime,
  command,
  environment,
  loadProcess,
  runtimeResult = null,
} = {}) {
  try {
    const reviewedSourceDigest = digestBytes(reviewedSource)
    const canonicalGraphDigest = digestCanonical(canonicalGraph)
    const buildArtifactDigest = digestBytes(buildArtifact)
    const loadedFrom = loadProcess?.loaded_from ?? 'reviewed_source'
    const loadedBytesDigest = loadedFrom === 'build_artifact'
      ? buildArtifactDigest
      : reviewedSourceDigest
    if (!['reviewed_source', 'build_artifact'].includes(loadedFrom)) {
      throw new TypeError('invalid load process source')
    }
    const content = {
      build_artifact: {
        digest: buildArtifactDigest,
        kind: 'bytes',
      },
      canonical_graph: {
        digest: canonicalGraphDigest,
        kind: 'canonical-value',
      },
      canonicalization: CANONICALIZATION,
      command: snapshot(command),
      environment: snapshot(environment),
      hash_algorithm: HASH_ALGORITHM,
      load_process: {
        ...snapshot(loadProcess),
        build_artifact_digest: buildArtifactDigest,
        canonical_graph_digest: canonicalGraphDigest,
        loaded_bytes_digest: loadedBytesDigest,
        loaded_from: loadedFrom,
        reviewed_source_digest: reviewedSourceDigest,
      },
      reviewed_source: {
        digest: reviewedSourceDigest,
        kind: 'bytes',
      },
      runtime: snapshot(runtime),
      runtime_result: runtimeResult === null
        ? null
        : snapshot(runtimeResult),
      schema: LOAD_TIME_AUTHORITY_SCHEMA,
      status: LOAD_TIME_AUTHORITY_STATUS,
    }
    const canonicalBytes = canonicalJson(content)
    return {
      ok: true,
      value: {
        ...content,
        canonical_bytes: canonicalBytes,
        pin_digest: digestBytes(Buffer.from(canonicalBytes, 'utf8')),
      },
    }
  } catch {
    return {
      code: 'load-time-authority-pin-invalid',
      ok: false,
    }
  }
}

export function verifyLoadTimeAuthority({ pin, actual } = {}) {
  try {
    const valid = validatePin(pin)
    if (!valid.ok) return valid
    if (actual === null || typeof actual !== 'object') {
      return invalid('load-time-authority-actual-invalid')
    }
    if (actual.canonicalization === undefined) {
      return invalid('load-time-authority-actual-incomplete')
    }
    if (actual.canonicalization !== pin.canonicalization) {
      return drift('canonicalization', 'load-time-canonicalization-drift')
    }
    for (const [field, expected] of [
      ['reviewed_source', pin.reviewed_source],
      ['build_artifact', pin.build_artifact],
      ['loaded_bytes', pin.load_process.loaded_bytes_digest],
    ]) {
      const value = field === 'reviewed_source'
        ? actual.reviewedSource
        : field === 'build_artifact'
          ? actual.buildArtifact
          : actual.loadedBytes
      if (value === undefined) {
        return invalid('load-time-authority-actual-incomplete')
      }
      const digest = digestBytes(value)
      const expectedDigest = typeof expected === 'string'
        ? expected
        : expected.digest
      if (digest !== expectedDigest) return drift(field)
    }
    if (actual.canonicalGraph === undefined
      || digestCanonical(actual.canonicalGraph) !== pin.canonical_graph.digest) {
      return drift('canonical_graph')
    }
    for (const [field, value, expected] of [
      ['runtime', actual.runtime, pin.runtime],
      ['command', actual.command, pin.command],
      ['environment', actual.environment, pin.environment],
    ]) {
      if (value === undefined || canonicalJson(value) !== canonicalJson(expected)) {
        return drift(field)
      }
    }
    if (!sameLoadProcess(actual.loadProcess, pin.load_process)) {
      return drift('load_process')
    }
    if (pin.runtime_result !== null
      && (actual.runtimeResult === undefined
        || canonicalJson(actual.runtimeResult)
          !== canonicalJson(pin.runtime_result))) {
      return drift('runtime_result')
    }
    return {
      ok: true,
      status: LOAD_TIME_VERIFIED_STATUS,
    }
  } catch {
    return invalid('load-time-authority-actual-invalid')
  }
}

export function executeWithLoadTimeAuthority({
  pin,
  actual,
  effect,
} = {}) {
  if (typeof effect !== 'function') {
    return invalid('load-time-authority-effect-invalid')
  }
  const verification = verifyLoadTimeAuthority({ pin, actual })
  if (!verification.ok) return verification
  return {
    ok: true,
    status: LOAD_TIME_VERIFIED_STATUS,
    value: effect(),
  }
}

function validatePin(pin) {
  if (!plainObject(pin)
    || !exactFields(pin, PIN_FIELDS)
    || pin.schema !== LOAD_TIME_AUTHORITY_SCHEMA
    || pin.status !== LOAD_TIME_AUTHORITY_STATUS
    || pin.hash_algorithm !== HASH_ALGORITHM
    || pin.canonicalization !== CANONICALIZATION
    || !DIGEST.test(pin.pin_digest)
    || typeof pin.canonical_bytes !== 'string'
    || digestBytes(Buffer.from(pin.canonical_bytes, 'utf8')) !== pin.pin_digest) {
    return invalid('load-time-authority-pin-invalid')
  }
  const { canonical_bytes: ignoredBytes, pin_digest: ignoredDigest, ...content } = pin
  if (canonicalJson(content) !== pin.canonical_bytes
    || !validIdentity(pin.reviewed_source)
    || !validIdentity(pin.build_artifact)
    || !validIdentity(pin.canonical_graph)
    || !plainObject(pin.runtime)
    || !plainObject(pin.command)
    || !plainObject(pin.environment)
    || !plainObject(pin.load_process)
    || (pin.runtime_result !== null && !plainObject(pin.runtime_result))) {
    return invalid('load-time-authority-pin-invalid')
  }
  const process = pin.load_process
  if (!['reviewed_source', 'build_artifact'].includes(process.loaded_from)
    || process.reviewed_source_digest !== pin.reviewed_source.digest
    || process.build_artifact_digest !== pin.build_artifact.digest
    || process.canonical_graph_digest !== pin.canonical_graph.digest
    || process.loaded_bytes_digest !== (
      process.loaded_from === 'build_artifact'
        ? pin.build_artifact.digest
        : pin.reviewed_source.digest
    )) {
    return invalid('load-time-authority-load-process-invalid')
  }
  return { ok: true }
}

function sameLoadProcess(actual, expected) {
  return actual !== undefined
    && plainObject(actual)
    && canonicalJson(actual) === canonicalJson(expected)
}

function validIdentity(value) {
  return plainObject(value)
    && exactFields(value, ['digest', 'kind'])
    && DIGEST.test(value.digest)
    && typeof value.kind === 'string'
}

function snapshot(value) {
  if (value === undefined) throw new TypeError('missing authority value')
  return JSON.parse(canonicalJson(value))
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function digestCanonical(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function exactFields(value, expected) {
  if (!plainObject(value)) return false
  const actual = Object.keys(value).sort(compareUtf8)
  const wanted = [...expected].sort(compareUtf8)
  return actual.length === wanted.length
    && actual.every((field, index) => field === wanted[index])
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
}

function drift(field, code = 'DRIFTED') {
  return {
    code,
    field,
    ok: false,
    status: LOAD_TIME_DRIFT_STATUS,
  }
}

function invalid(code) {
  return { code, ok: false }
}
