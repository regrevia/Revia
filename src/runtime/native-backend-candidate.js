import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const NATIVE_SCHEMA = 're.native-backend-candidate@0.1.0'

export function nativeBackendCandidateDigest(candidate) {
  return digest(Buffer.from(canonicalJson(candidate), 'utf8'))
}

export async function compileNativeBackendCandidate({
  backend_id = 'aot-llvm',
  compiler_digest,
  compiler_path,
  graph_revision,
  release_lock_digest,
  source,
  target_triple,
  toolchain_digest,
  work_root = null,
}) {
  try {
    validateCompileInput({
      compiler_digest,
      compiler_path,
      graph_revision,
      release_lock_digest,
      source,
      target_triple,
      toolchain_digest,
    })
    const root = work_root === null
      ? await mkdtemp(join(tmpdir(), 're-native-backend-'))
      : work_root
    const sourcePath = join(root, 'program.c')
    const executablePath = join(root, 'program')
    await writeFile(sourcePath, source, 'utf8')
    const result = spawnSync(
      compiler_path,
      ['-O2', '-target', target_triple, sourcePath, '-o', executablePath],
      { cwd: root, encoding: 'utf8', shell: false },
    )
    if (result.error || result.status !== 0) {
      throw new Error('native backend compiler failed')
    }
    const metadata = await stat(executablePath)
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error('native backend executable missing')
    }
    const candidate = {
      artifact_digest: digest(await readFile(executablePath)),
      artifact_kind: 'native-aot',
      backend_id,
      compiler_digest,
      graph_revision,
      release_lock_digest,
      schema: NATIVE_SCHEMA,
      target_triple,
      toolchain_digest,
      verifier: 're.native-backend-verifier@0.1.0',
    }
    const validated = validateNativeBackendCandidate(candidate, {
      graph_revision,
      release_lock_digest,
    })
    if (!validated.ok) throw new Error(validated.diagnostics[0].code)
    return {
      ok: true,
      value: {
        candidate,
        executable_path: executablePath,
        schema: 're.native-build-result@0.1.0',
      },
    }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'native-backend-build-failed',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export async function executeNativeBackendCandidate({
  args = [],
  candidate,
  executable_path,
  expected,
}) {
  try {
    if (!isAbsolute(executable_path)
      || !Array.isArray(args)
      || !args.every((value) => typeof value === 'string')
      || expected === null
      || typeof expected !== 'object') {
      throw new TypeError('invalid native backend execution input')
    }
    const validated = validateNativeBackendCandidate(candidate, {
      graph_revision: expected.graph_revision,
      release_lock_digest: expected.release_lock_digest,
    })
    if (!validated.ok
      || candidate.compiler_digest !== expected.compiler_digest
      || candidate.toolchain_digest !== expected.toolchain_digest
      || candidate.target_triple !== expected.target_triple
      || digest(await readFile(executable_path)) !== candidate.artifact_digest) {
      throw new Error('native backend executable identity mismatch')
    }
    const result = spawnSync(executable_path, args, {
      encoding: 'utf8',
      shell: false,
    })
    if (result.error || result.status === null) {
      throw new Error('native backend execution failed')
    }
    return {
      ok: true,
      value: {
        exit_status: result.status,
        schema: 're.native-execution-result@0.1.0',
        stderr: result.stderr,
        stdout: result.stdout,
      },
    }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'native-backend-execution-rejected',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

export function validateNativeBackendCandidate(candidate, {
  graph_revision,
  release_lock_digest,
} = {}) {
  const diagnostics = []
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
    || candidate.schema !== NATIVE_SCHEMA) {
    return rejected('unsupported-native-backend-candidate')
  }
  const fields = [
    'artifact_digest',
    'artifact_kind',
    'backend_id',
    'compiler_digest',
    'graph_revision',
    'release_lock_digest',
    'schema',
    'target_triple',
    'toolchain_digest',
    'verifier',
  ]
  if (Object.keys(candidate).sort().join(',') !== fields.join(',')) {
    diagnostics.push({ code: 'unexpected-native-backend-field' })
  }
  for (const field of ['artifact_digest', 'compiler_digest', 'graph_revision',
    'release_lock_digest', 'toolchain_digest']) {
    if (!DIGEST.test(candidate[field])) diagnostics.push({
      code: 'invalid-native-backend-digest',
      field,
    })
  }
  if (candidate.artifact_kind !== 'native-aot') {
    diagnostics.push({ code: 'native-backend-artifact-kind' })
  }
  if (candidate.backend_id === 'node-reference') {
    diagnostics.push({ code: 'native-backend-reference-not-native' })
  }
  if (typeof candidate.backend_id !== 'string' || candidate.backend_id.length === 0
    || typeof candidate.target_triple !== 'string' || candidate.target_triple.length === 0
    || candidate.verifier !== 're.native-backend-verifier@0.1.0') {
    diagnostics.push({ code: 'invalid-native-backend-identity' })
  }
  if (graph_revision !== undefined && candidate.graph_revision !== graph_revision) {
    diagnostics.push({ code: 'native-backend-graph-mismatch' })
  }
  if (release_lock_digest !== undefined
    && candidate.release_lock_digest !== release_lock_digest) {
    diagnostics.push({ code: 'native-backend-release-lock-mismatch' })
  }
  return diagnostics.length === 0 ? { ok: true } : { diagnostics, ok: false }
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function validateCompileInput({
  compiler_digest,
  compiler_path,
  graph_revision,
  release_lock_digest,
  source,
  target_triple,
  toolchain_digest,
}) {
  if (!isAbsolute(compiler_path)
    || typeof source !== 'string'
    || source.length === 0
    || typeof target_triple !== 'string'
    || target_triple.length === 0
    || !DIGEST.test(compiler_digest)
    || !DIGEST.test(graph_revision)
    || !DIGEST.test(release_lock_digest)
    || !DIGEST.test(toolchain_digest)) {
    throw new TypeError('invalid native backend compiler input')
  }
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic native backend candidate')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic native backend candidate')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
