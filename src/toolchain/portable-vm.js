import {
  compilePortableBytecode,
  portableBytecodeArtifactDigest,
  validatePortableBytecodeArtifact,
} from './portable-bytecode.js'
import {
  admitPortableVmCore,
  executePortableVmCore,
} from './portable-vm-core.js'
import {
  portableEquivalenceRequestDigest,
} from './portable-executor-equivalence.js'

export const PORTABLE_VM_PROFILE = 're.portable-vm@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function executePortableVm({
  artifact,
  checkedGraph,
  expectedArtifactDigest,
  expectedGraphRevision,
  invokeCapability,
  request,
} = {}) {
  const requestResult = validatePortableVmRequest(request)
  if (!requestResult.ok) return requestResult
  const artifactResult = validatePortableBytecodeArtifact(artifact)
  if (!artifactResult.ok) return artifactResult
  if (!plainObject(checkedGraph)) {
    return rejected('portable-vm-checked-graph-missing')
  }
  if (!DIGEST.test(expectedGraphRevision)
    || expectedGraphRevision !== request.graph_revision
    || checkedGraph.graph_revision !== expectedGraphRevision
    || artifact.graph_revision !== expectedGraphRevision) {
    return rejected('portable-vm-graph-revision-mismatch')
  }
  if (!DIGEST.test(expectedArtifactDigest)
    || expectedArtifactDigest !== request.artifact_digest
    || artifact.artifact_digest !== expectedArtifactDigest) {
    return rejected('portable-vm-artifact-identity-mismatch')
  }
  const canonical = compilePortableBytecode(checkedGraph)
  if (!canonical.ok) return rejected('portable-vm-checked-graph-invalid')
  if (canonicalJson(artifact) !== canonicalJson(canonical.value)
    || portableBytecodeArtifactDigest(artifact) !== artifact.artifact_digest) {
    return rejected('portable-vm-checked-graph-artifact-mismatch')
  }
  const admission = admitPortableVmCore({ artifact: canonical.value, request })
  if (!admission.ok) return admission
  return executePortableVmCore({
    admission: admission.value,
    invokeCapability,
  })
}

export function validatePortableVmRequest(request) {
  const fields = [
    'artifact_digest',
    'graph_revision',
    'input_digest',
    'profile',
    'request_digest',
    'schema',
    'transcript_digest',
    'workload_digest',
    'workload_id',
  ]
  if (!plainObject(request)
    || Object.keys(request).length !== fields.length
    || !fields.every((field) => Object.hasOwn(request, field))
    || request.schema !== 're.portable-equivalence-request@0.1.0'
    || request.profile !== 're.portable-equivalence@0.1.0'
    || typeof request.workload_id !== 'string'
    || !['artifact_digest', 'graph_revision', 'input_digest', 'request_digest',
      'transcript_digest', 'workload_digest'].every((field) => DIGEST.test(request[field]))
    || request.request_digest !== portableEquivalenceRequestDigest(request)) {
    return rejected('portable-vm-request-authority-mismatch')
  }
  return { ok: true }
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
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
