import {
  BACKEND_REQUEST_SCHEMA,
  backendArtifactDigest,
  executeBackendRequest,
} from './reference-backend.js'

export const PRODUCTION_BACKEND_SCHEMA = 're.production-backend@0.1.0'

export function createProductionBackend(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('invalid production backend identity')
  }
  const normalized = {
    artifact_digest: identity.artifact_digest,
    backend: 'production',
    profile_digest: identity.profile_digest,
    toolchain_digest: identity.toolchain_digest,
    version: '0.1.0',
  }
  for (const field of ['artifact_digest', 'profile_digest', 'toolchain_digest']) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(normalized[field])) {
      throw new TypeError('invalid production backend identity')
    }
  }
  return Object.freeze({
    backend: 'production',
    describe() {
      return { ...normalized, schema: PRODUCTION_BACKEND_SCHEMA }
    },
    check(project) {
      const result = executeBackendRequest('production', project, {
        graph_revision: project?.graph_revision,
        operation: 'identity',
        schema: BACKEND_REQUEST_SCHEMA,
      })
      return result.ok ? { ok: true } : result
    },
    build(project) {
      const checked = this.check(project)
      if (!checked.ok) return checked
      return {
        ok: true,
        value: {
          artifact_digest: backendArtifactDigest(normalized, project.graph_revision),
          backend: 'production',
          graph_revision: project.graph_revision,
          schema: 're.backend-artifact@0.1.0',
        },
      }
    },
    run(project, request) {
      return executeBackendRequest('production', project, request)
    },
  })
}
