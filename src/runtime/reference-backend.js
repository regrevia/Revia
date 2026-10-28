import { createHash } from 'node:crypto'

import { translateProject } from '../toolchain/project-translator.js'

export const REFERENCE_BACKEND_SCHEMA = 're.reference-backend@0.1.0'
export const BACKEND_REQUEST_SCHEMA = 're.backend-request@0.1.0'
export const BACKEND_RESULT_SCHEMA = 're.backend-result@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function createReferenceBackend(identity) {
  const normalized = normalizeIdentity(identity, 'reference')
  return Object.freeze({
    backend: 'reference',
    describe() {
      return { ...normalized, schema: REFERENCE_BACKEND_SCHEMA }
    },
    check(project) {
      return checkProject(project)
    },
    build(project) {
      const checked = checkProject(project)
      if (!checked.ok) return checked
      return {
        ok: true,
        value: {
          artifact_digest: backendArtifactDigest(normalized, project.graph_revision),
          backend: 'reference',
          graph_revision: project.graph_revision,
          schema: 're.backend-artifact@0.1.0',
        },
      }
    },
    run(project, request) {
      return executeBackendRequest('reference', project, request)
    },
  })
}

export function executeBackendRequest(backend, project, request) {
  try {
    const checked = checkProject(project)
    if (!checked.ok) return checked
    validateRequest(request, project.graph_revision)
    let output
    if (request.operation === 'identity') {
      output = {
        graph_revision: project.graph_revision,
        modules: project.modules.map(({ interface_digest, name }) => ({
          interface_digest,
          name,
        })),
        package_digest: project.package_digest,
        project_digest: project.project_digest ?? project.graph_revision,
      }
    } else {
      const translated = translateProject(project, {
        locale: request.input.locale,
        media: request.input.media,
      })
      if (!translated.ok) return translated
      output = translated.value
    }
    return {
      ok: true,
      value: {
        backend,
        operation: request.operation,
        output,
        schema: BACKEND_RESULT_SCHEMA,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'backend-request-failed' }],
      ok: false,
    }
  }
}

export function backendArtifactDigest(identity, graphRevision) {
  return digest({
    backend: identity.backend,
    backend_digest: identity.artifact_digest,
    graph_revision: graphRevision,
    profile_digest: identity.profile_digest,
    toolchain_digest: identity.toolchain_digest,
    version: identity.version,
  })
}

function checkProject(project) {
  try {
    if (!plainObject(project) || project.schema !== 're.project-graph@0.1.0') {
      fail('backend-project-schema-mismatch')
    }
    if (!DIGEST.test(project.graph_revision)
      || !DIGEST.test(project.package_digest)
      || !Array.isArray(project.modules)
      || project.modules.length === 0) {
      fail('backend-project-identity-invalid')
    }
    const names = new Set()
    for (const module of project.modules) {
      if (!plainObject(module) || typeof module.name !== 'string'
        || names.has(module.name)
        || !DIGEST.test(module.interface_digest)
        || !DIGEST.test(module.implementation_digest)) {
        fail('backend-project-module-invalid')
      }
      names.add(module.name)
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'backend-project-invalid' }],
      ok: false,
    }
  }
}

function validateRequest(request, graphRevision) {
  if (!plainObject(request) || request.schema !== BACKEND_REQUEST_SCHEMA
    || !['identity', 'translate'].includes(request.operation)
    || request.graph_revision !== graphRevision) {
    fail('backend-request-identity-mismatch')
  }
  const expected = request.operation === 'identity'
    ? ['graph_revision', 'operation', 'schema']
    : ['graph_revision', 'input', 'operation', 'schema']
  exactFields(request, expected)
  if (request.operation === 'translate') {
    if (!plainObject(request.input)
      || !['zh-CN', 'en-US'].includes(request.input.locale)
      || !['all', 'json', 'html', 'svg', 'text'].includes(request.input.media)) {
      fail('backend-translation-request-invalid')
    }
  }
}

function normalizeIdentity(identity, backend) {
  if (!plainObject(identity)
    || !DIGEST.test(identity.toolchain_digest)
    || !DIGEST.test(identity.profile_digest)
    || !DIGEST.test(identity.artifact_digest)) {
    throw new TypeError('invalid backend identity')
  }
  return {
    artifact_digest: identity.artifact_digest,
    backend,
    profile_digest: identity.profile_digest,
    toolchain_digest: identity.toolchain_digest,
    version: '0.1.0',
  }
}

function exactFields(value, expected) {
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) fail('unexpected-backend-request-field', { field })
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) fail('missing-backend-request-field', { field })
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code, detail = {}) {
  throw Object.assign(new TypeError(code), { diagnostic: { code, ...detail } })
}
