import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  executePortableBytecode,
  validatePortableBytecodeArtifact,
} from './portable-bytecode.js'

export const PORTABLE_BYTECODE_PROCESS_REQUEST_SCHEMA =
  're.portable-bytecode-process-request@0.1.0'
export const PORTABLE_BYTECODE_PROCESS_RESULT_SCHEMA =
  're.portable-bytecode-process-result@0.1.0'

const DEFAULT_TIMEOUT_MS = 2_000
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_LINE_BYTES = 1_048_576
const REQUEST_FIELDS = [
  'artifact',
  'artifact_digest',
  'checked_graph',
  'graph_revision',
  'invocations',
  'request_digest',
  'schema',
]
const INVOCATION_FIELDS = [
  'arguments',
  'instance',
  'invocation_id',
  'member',
  'response',
]
const WORKER_PATH = new URL(
  './portable-bytecode-process-worker.js',
  import.meta.url,
)

export function createPortableBytecodeProcessRequest({
  artifact,
  checkedGraph,
  invocations,
} = {}) {
  const request = {
    artifact: snapshotJson(artifact),
    artifact_digest: artifact?.artifact_digest,
    checked_graph: snapshotJson(checkedGraph),
    graph_revision: checkedGraph?.graph_revision,
    invocations: snapshotJson(invocations),
    schema: PORTABLE_BYTECODE_PROCESS_REQUEST_SCHEMA,
  }
  request.request_digest = portableBytecodeProcessRequestDigest(request)
  const validated = validatePortableBytecodeProcessRequest(request)
  return validated.ok ? { ok: true, value: request } : validated
}

export function portableBytecodeProcessRequestDigest(request) {
  if (!plainObject(request)) {
    throw new TypeError('invalid portable bytecode process request')
  }
  const { request_digest: ignored, ...content } = request
  return digest(content)
}

export function validatePortableBytecodeProcessRequest(request) {
  const diagnostics = []
  if (!plainObject(request)
    || request.schema !== PORTABLE_BYTECODE_PROCESS_REQUEST_SCHEMA) {
    return rejected('portable-bytecode-process-request-schema-mismatch')
  }
  exactFields(
    request,
    REQUEST_FIELDS,
    'portable-bytecode-process-request',
    diagnostics,
  )
  if (!plainObject(request.checked_graph)
    || !DIGEST.test(request.graph_revision)
    || request.checked_graph.graph_revision !== request.graph_revision
    || request.artifact?.graph_revision !== request.graph_revision) {
    diagnostics.push({
      code: 'portable-bytecode-process-graph-revision-mismatch',
    })
  }
  const artifact = validatePortableBytecodeArtifact(request.artifact)
  if (!artifact.ok) diagnostics.push(...artifact.diagnostics)
  if (!DIGEST.test(request.artifact_digest)
    || request.artifact?.artifact_digest !== request.artifact_digest) {
    diagnostics.push({
      code: 'portable-bytecode-process-artifact-digest-mismatch',
    })
  }
  validateInvocations(request.invocations, diagnostics)
  if (!DIGEST.test(request.request_digest)
    || request.request_digest !== portableBytecodeProcessRequestDigest(request)) {
    diagnostics.push({
      code: 'portable-bytecode-process-request-digest-mismatch',
    })
  }
  return verificationResult(diagnostics)
}

export function parsePortableBytecodeProcessRequestLine(line) {
  if (typeof line !== 'string') {
    return rejected('portable-bytecode-process-request-line-invalid')
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return rejected('portable-bytecode-process-request-too-large')
  }
  const withoutTerminator = line.endsWith('\n') ? line.slice(0, -1) : line
  if (withoutTerminator.includes('\n') || withoutTerminator.includes('\r')) {
    return rejected('portable-bytecode-process-request-line-invalid')
  }
  let request
  try {
    request = JSON.parse(withoutTerminator)
  } catch {
    return rejected('portable-bytecode-process-request-json-invalid')
  }
  const validated = validatePortableBytecodeProcessRequest(request)
  return validated.ok ? { ok: true, value: request } : validated
}

export function executePortableBytecodeProcessRequest(request) {
  const validated = validatePortableBytecodeProcessRequest(request)
  if (!validated.ok) return validated
  let index = 0
  let mismatch = null
  const execution = executePortableBytecode({
    artifact: request.artifact,
    checkedGraph: request.checked_graph,
    expectedArtifactDigest: request.artifact_digest,
    expectedGraphRevision: request.graph_revision,
    invokeCapability(instance, member, args, invocationId) {
      const expected = request.invocations[index]
      index += 1
      if (expected === undefined
        || expected.instance !== instance
        || expected.member !== member
        || expected.invocation_id !== invocationId) {
        mismatch = 'portable-bytecode-process-invocation-mismatch'
        return checkFailure(mismatch)
      }
      if (!canonicalEqual(decodeValue(expected.arguments), args)) {
        mismatch =
          'portable-bytecode-process-invocation-arguments-mismatch'
        return checkFailure(mismatch)
      }
      return decodeValue(expected.response)
    },
  })
  if (mismatch !== null || index !== request.invocations.length) {
    return rejected(
      mismatch ?? 'portable-bytecode-process-invocation-mismatch',
    )
  }
  if (!execution.ok) return execution
  return {
    ok: true,
    value: {
      execution: execution.value,
      request_digest: request.request_digest,
      schema: PORTABLE_BYTECODE_PROCESS_RESULT_SCHEMA,
    },
  }
}

export async function executePortableBytecodeProcess({
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerPath = WORKER_PATH,
  onEvent,
  spawnProcess = spawnChild,
} = {}) {
  const emit = eventEmitter(onEvent)
  emit('preflight-start')
  const expected = executePortableBytecodeProcessRequest(request)
  if (!expected.ok) {
    emit('preflight-rejected')
    emit('terminal')
    return expected
  }
  emit('preflight-accepted')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || timeoutMs > 60_000) {
    emit('preflight-rejected')
    emit('terminal')
    return rejected('portable-bytecode-process-timeout-invalid')
  }

  let child
  try {
    child = spawnProcess(process.execPath, [fileArgument(workerPath)], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    emit('child-spawn-fault')
    emit('terminal')
    return rejected('portable-bytecode-process-spawn-failed')
  }
  emit('child-spawn')
  return collectChildResult({
    child,
    expected,
    request,
    timeoutMs,
    emit,
  })
}

async function collectChildResult({
  child,
  expected,
  request,
  timeoutMs,
  emit,
}) {
  let stdout = ''
  let stderrBytes = 0
  let outputOverflow = false
  let settled = false
  let terminalDiagnostic = null
  const completion = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return
      terminalDiagnostic = 'portable-bytecode-process-timeout'
      emit('timeout')
      child.kill('SIGKILL')
      emit('child-kill')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_LINE_BYTES && !outputOverflow) {
        outputOverflow = true
        terminalDiagnostic = 'portable-bytecode-process-result-too-large'
        child.kill('SIGKILL')
        emit('child-kill')
      }
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > MAX_LINE_BYTES
        && !outputOverflow) {
        outputOverflow = true
        terminalDiagnostic = 'portable-bytecode-process-result-too-large'
        child.kill('SIGKILL')
        emit('child-kill')
      }
    })
    child.once('error', () => {
      terminalDiagnostic = 'portable-bytecode-process-spawn-failed'
      emit('child-error')
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      emit('child-close')
      if (terminalDiagnostic !== null || outputOverflow) {
        const result = rejected(
          terminalDiagnostic ?? 'portable-bytecode-process-result-too-large',
        )
        emit('terminal')
        resolve(result)
        return
      }
      if (code !== 0 || signal !== null || stdout.length === 0) {
        const result = rejected('portable-bytecode-process-child-exit')
        emit('terminal')
        resolve(result)
        return
      }
      const parsed = parseResultLine(stdout)
      if (!parsed.ok) {
        emit('result-rejected')
        emit('terminal')
        resolve(parsed)
        return
      }
      emit('result-parsed')
      if (canonicalJson(parsed.value) !== canonicalJson(expected)) {
        emit('result-rejected')
        emit('terminal')
        resolve(rejected('portable-bytecode-process-result-mismatch'))
        return
      }
      emit('terminal')
      resolve(parsed.value)
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(`${canonicalJson(request)}\n`)
  emit('stdin-end')
  const result = await completion
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  return result
}

function eventEmitter(onEvent) {
  return (kind) => {
    if (typeof onEvent !== 'function') return
    try {
      onEvent({ kind })
    } catch {
      // Observability must not alter process protocol semantics.
    }
  }
}

function parseResultLine(line) {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return rejected('portable-bytecode-process-result-too-large')
  }
  const withoutTerminator = line.endsWith('\n') ? line.slice(0, -1) : line
  if (withoutTerminator.includes('\n') || withoutTerminator.includes('\r')) {
    return rejected('portable-bytecode-process-result-line-invalid')
  }
  let result
  try {
    result = JSON.parse(withoutTerminator)
  } catch {
    return rejected('portable-bytecode-process-result-json-invalid')
  }
  return { ok: true, value: result }
}

function validateInvocations(invocations, diagnostics) {
  if (!Array.isArray(invocations)) {
    diagnostics.push({
      code: 'portable-bytecode-process-invocations-invalid',
    })
    return
  }
  for (const invocation of invocations) {
    if (!plainObject(invocation)) {
      diagnostics.push({
        code: 'portable-bytecode-process-invocation-invalid',
      })
      continue
    }
    exactFields(
      invocation,
      INVOCATION_FIELDS,
      'portable-bytecode-process-invocation',
      diagnostics,
    )
    if (typeof invocation.instance !== 'string'
      || typeof invocation.member !== 'string'
      || typeof invocation.invocation_id !== 'string'
      || !plainObject(invocation.arguments)
      || !plainObject(invocation.response)) {
      diagnostics.push({
        code: 'portable-bytecode-process-invocation-invalid',
      })
    }
    try {
      decodeValue(invocation.arguments)
      decodeValue(invocation.response)
    } catch {
      diagnostics.push({
        code: 'portable-bytecode-process-invocation-value-invalid',
      })
    }
  }
}

function exactFields(value, expected, prefix, diagnostics) {
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      diagnostics.push({ code: `${prefix}-unexpected-field`, field })
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({ code: `${prefix}-missing-field`, field })
    }
  }
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (plainObject(value)) {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '$bytes')) {
      if (typeof value.$bytes !== 'string'
        || !/^hex:(?:[0-9a-f]{2})*$/u.test(value.$bytes)) {
        throw new TypeError('invalid portable bytecode process bytes')
      }
      const bytes = new Uint8Array((value.$bytes.length - 4) / 2)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(
          value.$bytes.slice(4 + index * 2, 6 + index * 2),
          16,
        )
      }
      return bytes
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeValue(child)]),
    )
  }
  return value
}

function snapshotJson(value) {
  return value === undefined
    ? value
    : JSON.parse(JSON.stringify(value))
}

function canonicalEqual(left, right) {
  return canonicalJson(encodeValue(left)) === canonicalJson(encodeValue(right))
}

function encodeValue(value) {
  if (value instanceof Uint8Array) {
    let hex = ''
    for (const byte of value) hex += byte.toString(16).padStart(2, '0')
    return { $bytes: `hex:${hex}` }
  }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeValue(child)]),
    )
  }
  return value
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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

function fileArgument(value) {
  return value instanceof URL ? value.pathname : value
}

function checkFailure(code) {
  return { diagnostics: [{ code }], kind: 'check-failure' }
}

function verificationResult(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
