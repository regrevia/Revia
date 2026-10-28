import { createHash } from 'node:crypto'

import { validateAgentProjectReleaseLock } from './backend-contract.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function digestTrackedFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('release evidence requires tracked files')
  }
  const normalized = entries.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || entry.path.length === 0
      || !(typeof entry.bytes === 'string' || entry.bytes instanceof Uint8Array)) {
      throw new TypeError('invalid release evidence file')
    }
    return {
      bytes: typeof entry.bytes === 'string'
        ? Buffer.from(entry.bytes, 'utf8')
        : Buffer.from(entry.bytes),
      path: entry.path,
    }
  }).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  const paths = new Set()
  const hash = createHash('sha256')
  for (const entry of normalized) {
    if (paths.has(entry.path)) throw new TypeError('duplicate release evidence path')
    paths.add(entry.path)
    const path = Buffer.from(entry.path, 'utf8')
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(entry.bytes.length))
    hash.update(path)
    hash.update(Buffer.from([0]))
    hash.update(length)
    hash.update(entry.bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

export function verifyReleaseBuild(lock, backend, project) {
  const description = backend?.describe?.()
  if (description === undefined) return rejected('invalid-release-backend')
  const built = backend.build(project)
  if (!built.ok) return built
  const validated = validateAgentProjectReleaseLock(lock, {
    backend: {
      digest: description.artifact_digest,
      id: 'reference-plus-production',
      version: description.version,
    },
    graph_revision: project.graph_revision,
    module_interfaces: project.modules.map(({ interface_digest, name }) => ({
      interface_digest,
      module: name,
    })),
    profile: {
      digest: description.profile_digest,
      id: 'server-minimum',
      version: '0.1.0',
    },
    toolchain: {
      digest: description.toolchain_digest,
      id: 're-toolchain',
      version: '0.1.0',
    },
  })
  if (!validated.ok) return validated
  if (built.value.schema !== lock.build_artifact.schema
    || built.value.backend !== lock.build_artifact.backend
    || built.value.graph_revision !== lock.build_artifact.graph_revision
    || built.value.artifact_digest !== lock.build_artifact.artifact_digest
    || !DIGEST.test(built.value.artifact_digest)) {
    return rejected('agent-release-build-artifact-mismatch')
  }
  return {
    ok: true,
    value: {
      artifact: built.value,
      lock_digest: `sha256:${createHash('sha256')
        .update(canonicalJson(lock))
        .digest('hex')}`,
      schema: 're.release-build-verification@0.1.0',
    },
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
