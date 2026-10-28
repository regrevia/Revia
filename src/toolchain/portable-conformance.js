import {
  executePortableProgramContract,
  validatePortableExecutorContract,
  verifyPortableExecutionResult,
} from './portable-executor.js'
import {
  compilePortableBytecode,
  executePortableBytecode,
} from './portable-bytecode.js'
import {
  createPortableBytecodeProcessRequest,
  executePortableBytecodeProcess,
} from './portable-bytecode-process.js'

export const PORTABLE_CONFORMANCE_BUNDLE_SCHEMA =
  're.portable-conformance-bundle@0.1.0'
export const PORTABLE_CONFORMANCE_RESULT_SCHEMA =
  're.portable-conformance-result@0.1.0'

const CASE_FIELDS = [
  'contract',
  'expected',
  'graph',
  'graph_revision',
  'id',
  'invocations',
]
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function validatePortableConformanceBundle(bundle) {
  const diagnostics = []
  if (!plainObject(bundle)
    || bundle.schema !== PORTABLE_CONFORMANCE_BUNDLE_SCHEMA) {
    return rejected('portable-conformance-bundle-schema-mismatch')
  }
  exactFields(bundle, [
    'cases',
    'required_coverage',
    'schema',
    'status',
  ], 'portable-conformance-bundle', diagnostics)
  if (bundle.status !== 'backend-neutral-semantic-oracle') {
    diagnostics.push({ code: 'portable-conformance-bundle-status-mismatch' })
  }
  if (!Array.isArray(bundle.required_coverage)
    || bundle.required_coverage.some((value) => typeof value !== 'string')
    || new Set(bundle.required_coverage).size !== bundle.required_coverage.length) {
    diagnostics.push({ code: 'portable-conformance-coverage-invalid' })
  }
  if (!Array.isArray(bundle.cases) || bundle.cases.length === 0) {
    diagnostics.push({ code: 'portable-conformance-cases-invalid' })
    return verificationResult(diagnostics)
  }
  const ids = new Set()
  for (const entry of bundle.cases) {
    validateCase(entry, diagnostics)
    if (typeof entry?.id === 'string') {
      if (ids.has(entry.id)) {
        diagnostics.push({
          case: entry.id,
          code: 'portable-conformance-duplicate-case',
        })
      }
      ids.add(entry.id)
    }
  }
  return verificationResult(diagnostics)
}

export async function runPortableConformanceBundle(
  bundle,
  { loadGraph } = {},
) {
  const validated = validatePortableConformanceBundle(bundle)
  if (!validated.ok) return validated
  if (typeof loadGraph !== 'function') {
    return rejected('portable-conformance-graph-loader-missing')
  }
  const cases = []
  for (const entry of bundle.cases) {
    let graph
    try {
      graph = await loadGraph(entry)
    } catch {
      return rejected('portable-conformance-graph-load-failed', {
        case: entry.id,
      })
    }
    if (!plainObject(graph)
      || graph.graph_revision !== entry.graph_revision) {
      return rejected('portable-conformance-loaded-graph-mismatch', {
        case: entry.id,
      })
    }
    let index = 0
    let invocationMismatch = null
    const execution = executePortableProgramContract({
      contract: entry.contract,
      graph,
      invokeCapability(instance, member, args, invocationId) {
        const expected = entry.invocations[index]
        index += 1
        if (expected === undefined
          || expected.instance !== instance
          || expected.member !== member
          || expected.invocation_id !== invocationId) {
          invocationMismatch = 'portable-conformance-invocation-mismatch'
          return checkFailure(invocationMismatch)
        }
        if (!canonicalEqual(decodeValue(expected.arguments), args)) {
          invocationMismatch =
            'portable-conformance-invocation-arguments-mismatch'
          return checkFailure(invocationMismatch)
        }
        return decodeValue(expected.response)
      },
    })
    if (invocationMismatch !== null) {
      return rejected(invocationMismatch, { case: entry.id })
    }
    if (index !== entry.invocations.length) {
      return rejected('portable-conformance-invocation-mismatch', {
        case: entry.id,
      })
    }
    if (!execution.ok) {
      return {
        diagnostics: execution.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          case: entry.id,
        })),
        ok: false,
      }
    }
    const verified = verifyPortableExecutionResult(
      execution.value,
      entry.contract,
      {
        evidence: execution.verification_evidence,
        graph,
      },
    )
    if (!verified.ok) {
      return {
        diagnostics: verified.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          case: entry.id,
        })),
        ok: false,
      }
    }
    if (!canonicalEqual(execution.value.outcome, decodeValue(entry.expected.outcome))) {
      return rejected('portable-conformance-expected-outcome-mismatch', {
        case: entry.id,
      })
    }
    if (!canonicalEqual(execution.value.receipt, decodeValue(entry.expected.receipt))) {
      return rejected('portable-conformance-expected-receipt-mismatch', {
        case: entry.id,
      })
    }
    const bytecode = compilePortableBytecode(graph)
    if (!bytecode.ok) {
      return withCase(bytecode, entry.id)
    }
    let bytecodeIndex = 0
    let bytecodeMismatch = null
    const interpreted = executePortableBytecode({
      artifact: bytecode.value,
      checkedGraph: graph,
      expectedArtifactDigest: bytecode.value.artifact_digest,
      expectedGraphRevision: entry.graph_revision,
      invokeCapability(instance, member, args, invocationId) {
        const expected = entry.invocations[bytecodeIndex]
        bytecodeIndex += 1
        if (expected === undefined
          || expected.instance !== instance
          || expected.member !== member
          || expected.invocation_id !== invocationId) {
          bytecodeMismatch = 'portable-conformance-bytecode-invocation-mismatch'
          return checkFailure(bytecodeMismatch)
        }
        if (!canonicalEqual(decodeValue(expected.arguments), args)) {
          bytecodeMismatch =
            'portable-conformance-bytecode-invocation-arguments-mismatch'
          return checkFailure(bytecodeMismatch)
        }
        return decodeValue(expected.response)
      },
    })
    if (bytecodeMismatch !== null
      || bytecodeIndex !== entry.invocations.length) {
      return rejected(
        bytecodeMismatch
          ?? 'portable-conformance-bytecode-invocation-mismatch',
        { case: entry.id },
      )
    }
    if (!interpreted.ok) {
      return withCase(interpreted, entry.id)
    }
    if (!canonicalEqual(interpreted.value.outcome, execution.value.outcome)) {
      return rejected('portable-conformance-bytecode-outcome-mismatch', {
        case: entry.id,
      })
    }
    if (!canonicalEqual(
      interpreted.value.invocations,
      execution.value.receipt.invocations,
    )) {
      return rejected('portable-conformance-bytecode-receipt-mismatch', {
        case: entry.id,
      })
    }
    const processRequest = createPortableBytecodeProcessRequest({
      artifact: bytecode.value,
      checkedGraph: graph,
      invocations: entry.invocations,
    })
    if (!processRequest.ok) {
      return withCase(processRequest, entry.id)
    }
    const processExecution = await executePortableBytecodeProcess({
      request: processRequest.value,
    })
    if (!processExecution.ok) {
      return withCase(processExecution, entry.id)
    }
    if (!canonicalEqual(
      processExecution.value.execution,
      interpreted.value,
    )) {
      return rejected('portable-conformance-process-result-mismatch', {
        case: entry.id,
      })
    }
    cases.push({
      bytecode_artifact_digest: bytecode.value.artifact_digest,
      id: entry.id,
      outcome: encodeValue(execution.value.outcome),
      process_request_digest: processRequest.value.request_digest,
      receipt: encodeValue(execution.value.receipt),
    })
  }
  return {
    ok: true,
    value: {
      cases,
      schema: PORTABLE_CONFORMANCE_RESULT_SCHEMA,
    },
  }
}

function withCase(result, caseId) {
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      case: caseId,
    })),
    ok: false,
  }
}

function validateCase(entry, diagnostics) {
  if (!plainObject(entry)) {
    diagnostics.push({ code: 'portable-conformance-case-invalid' })
    return
  }
  exactFields(entry, CASE_FIELDS, 'portable-conformance-case', diagnostics)
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    diagnostics.push({ code: 'portable-conformance-case-id-invalid' })
  }
  if (typeof entry.graph !== 'string' || entry.graph.length === 0) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-case-graph-invalid',
    })
  }
  if (!DIGEST.test(entry.graph_revision)) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-case-graph-revision-invalid',
    })
  }
  const contract = validatePortableExecutorContract(entry.contract)
  if (!contract.ok) {
    diagnostics.push(...contract.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      case: entry.id,
    })))
  } else if (entry.contract.graph_revision !== entry.graph_revision) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-contract-graph-mismatch',
    })
  } else if (entry.contract.input_digest !== entry.graph_revision) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-contract-input-mismatch',
    })
  }
  if (!Array.isArray(entry.invocations)) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-invocations-invalid',
    })
  } else {
    for (const invocation of entry.invocations) {
      validateInvocation(entry.id, invocation, diagnostics)
    }
  }
  if (!plainObject(entry.expected)) {
    diagnostics.push({
      case: entry.id,
      code: 'portable-conformance-expected-invalid',
    })
  } else {
    exactFields(entry.expected, [
      'outcome',
      'receipt',
    ], 'portable-conformance-expected', diagnostics, entry.id)
  }
}

function validateInvocation(caseId, invocation, diagnostics) {
  if (!plainObject(invocation)) {
    diagnostics.push({
      case: caseId,
      code: 'portable-conformance-invocation-invalid',
    })
    return
  }
  exactFields(invocation, [
    'arguments',
    'instance',
    'invocation_id',
    'member',
    'response',
  ], 'portable-conformance-invocation', diagnostics, caseId)
  for (const field of ['instance', 'invocation_id', 'member']) {
    if (typeof invocation[field] !== 'string' || invocation[field].length === 0) {
      diagnostics.push({
        case: caseId,
        code: 'portable-conformance-invocation-field-invalid',
        field,
      })
    }
  }
  if (!plainObject(invocation.arguments) || !plainObject(invocation.response)) {
    diagnostics.push({
      case: caseId,
      code: 'portable-conformance-invocation-payload-invalid',
    })
  }
  try {
    decodeValue(invocation.arguments)
    decodeValue(invocation.response)
  } catch {
    diagnostics.push({
      case: caseId,
      code: 'portable-conformance-value-invalid',
    })
  }
}

function exactFields(
  value,
  expected,
  prefix,
  diagnostics,
  caseId,
) {
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      diagnostics.push({
        ...(caseId === undefined ? {} : { case: caseId }),
        code: `${prefix}-unexpected-field`,
        field,
      })
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({
        ...(caseId === undefined ? {} : { case: caseId }),
        code: `${prefix}-missing-field`,
        field,
      })
    }
  }
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (plainObject(value)) {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '$bytes')) {
      if (typeof value.$bytes !== 'string'
        || !/^hex:(?:[0-9a-f]{2})*$/u.test(value.$bytes)) {
        throw new TypeError('invalid portable conformance bytes')
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

function canonicalEqual(left, right) {
  return canonicalJson(encodeValue(left)) === canonicalJson(encodeValue(right))
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

function checkFailure(code) {
  return { diagnostics: [{ code }], kind: 'check-failure' }
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}

function verificationResult(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
