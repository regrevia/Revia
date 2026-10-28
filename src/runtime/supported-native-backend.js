import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'

import { compileNativeBackendCandidate } from './native-backend-candidate.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCHEMA = 're.supported-native-backend@0.1.0'

export function createSupportedNativeBackendDescriptor({
  compiler_digest,
  compiler_path,
  target_triple,
  toolchain_digest,
}) {
  const descriptor = {
    architecture: 'arm64',
    backend_id: 'aot-clang-macos-arm64',
    compiler_digest,
    compiler_path,
    operating_system: 'darwin',
    schema: SCHEMA,
    target_triple,
    toolchain_digest,
  }
  const validated = validateSupportedNativeBackendDescriptor(descriptor)
  if (!validated.ok) throw new TypeError(validated.diagnostics[0].code)
  return descriptor
}

export async function compileSupportedNativeBackendCandidate({
  descriptor,
  graph_revision,
  release_lock_digest,
  source,
  work_root = null,
}) {
  try {
    const validated = validateSupportedNativeBackendDescriptor(descriptor)
    if (!validated.ok
      || process.platform !== descriptor.operating_system
      || process.arch !== descriptor.architecture
      || digest(await readFile(descriptor.compiler_path)) !== descriptor.compiler_digest) {
      throw new TypeError('supported native backend environment mismatch')
    }
    if (work_root !== null) await mkdir(work_root, { recursive: true })
    return compileNativeBackendCandidate({
      backend_id: descriptor.backend_id,
      compiler_digest: descriptor.compiler_digest,
      compiler_path: descriptor.compiler_path,
      graph_revision,
      release_lock_digest,
      source,
      target_triple: descriptor.target_triple,
      toolchain_digest: descriptor.toolchain_digest,
      work_root,
    })
  } catch (error) {
    return {
      diagnostics: [{
        code: 'supported-native-backend-build-failed',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export function validateSupportedNativeBackendDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || descriptor.schema !== SCHEMA
    || Object.keys(descriptor).sort().join(',') !== [
      'architecture',
      'backend_id',
      'compiler_digest',
      'compiler_path',
      'operating_system',
      'schema',
      'target_triple',
      'toolchain_digest',
    ].join(',')
    || descriptor.architecture !== 'arm64'
    || descriptor.backend_id !== 'aot-clang-macos-arm64'
    || descriptor.compiler_path !== '/usr/bin/cc'
    || descriptor.operating_system !== 'darwin'
    || descriptor.target_triple !== 'arm64-apple-darwin'
    || !DIGEST.test(descriptor.compiler_digest)
    || !DIGEST.test(descriptor.toolchain_digest)) {
    return {
      diagnostics: [{ code: 'unsupported-native-backend-descriptor' }],
      ok: false,
    }
  }
  return { ok: true }
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
