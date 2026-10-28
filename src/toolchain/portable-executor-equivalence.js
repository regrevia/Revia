import { createHash } from 'node:crypto'

import { demoSchemaDefinitions } from '../host/demo-schema.js'
import { HostEnvironment } from '../host/host-environment.js'
import { MemoryAdapter } from '../host/memory-adapter.js'
import { SchemaRegistry } from '../host/schema-registry.js'
import {
  createPortableBytecodeProcessRequest,
  executePortableBytecodeProcess,
} from './portable-bytecode-process.js'
import {
  compilePortableBytecode,
  executePortableBytecode,
} from './portable-bytecode.js'
import {
  validatePortableConformanceBundle,
} from './portable-conformance.js'
import {
  executePortableProgram,
  executePortableProgramContract,
} from './portable-executor.js'

export const PORTABLE_EQUIVALENCE_WORKLOAD_SCHEMA =
  're.portable-equivalence-workload@0.1.0'
export const PORTABLE_EQUIVALENCE_REQUEST_SCHEMA =
  're.portable-equivalence-request@0.1.0'
export const PORTABLE_EQUIVALENCE_RESULT_SCHEMA =
  're.portable-equivalence-result@0.1.0'
export const PORTABLE_EQUIVALENCE_RECEIPT_SCHEMA =
  're.portable-equivalence-receipt@0.1.0'
export const PORTABLE_EQUIVALENCE_ERROR_SCHEMA =
  're.portable-equivalence-error@0.1.0'
export const PORTABLE_EXECUTOR_BENCHMARK_SCHEMA =
  're.portable-executor-benchmark@0.1.0'
export const PORTABLE_EQUIVALENCE_PROFILE =
  're.portable-equivalence@0.1.0'

const CANDIDATES = Object.freeze([
  'node-reference',
  'portable-core',
  'portable-process',
  'llvm-aot',
  'cranelift',
])
const MEASURED_CANDIDATES = CANDIDATES.slice(0, 3)
const PENDING_CANDIDATES = CANDIDATES.slice(3)
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REPORT_FIELDS = [
  'bundle_digest',
  'candidates',
  'profile',
  'report_digest',
  'schema',
]
const REQUEST_FIELDS = [
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
const RESULT_FIELDS = [
  'error',
  'outcome',
  'receipt',
  'request_digest',
  'result_digest',
  'schema',
  'trace_digest',
]
const RECEIPT_FIELDS = [
  'artifact_digest',
  'graph_revision',
  'input_digest',
  'invocations',
  'outcome',
  'schema',
  'transcript_digest',
]

export async function runPortableExecutorBenchmark(
  bundle,
  { loadGraph } = {},
) {
  const bundleValidation = validatePortableConformanceBundle(bundle)
  if (!bundleValidation.ok) return bundleValidation
  if (typeof loadGraph !== 'function') {
    return rejected('portable-benchmark-graph-loader-missing')
  }

  const workloads = new Map(
    MEASURED_CANDIDATES.map((candidate) => [candidate, []]),
  )
  for (const entry of bundle.cases) {
    const prepared = await prepareWorkload(entry, { loadGraph })
    if (!prepared.ok) return prepared
    const results = []
    for (const candidate of MEASURED_CANDIDATES) {
      const executed = await executeCandidate(candidate, prepared.value, entry)
      if (!executed.ok) return withCandidate(executed, candidate, entry.id)
      workloads.get(candidate).push({
        id: entry.id,
        request: snapshotJson(prepared.value.request),
        result: executed.value,
        schema: PORTABLE_EQUIVALENCE_WORKLOAD_SCHEMA,
      })
      results.push(executed.value)
    }
    if (!results.every((result) => canonicalEqual(result, results[0]))) {
      return rejected('portable-benchmark-candidate-result-mismatch', {
        workload: entry.id,
      })
    }
  }

  const report = {
    bundle_digest: digest(bundle),
    candidates: [
      ...MEASURED_CANDIDATES.map((candidate) => ({
        candidate,
        status: 'measured',
        workloads: workloads.get(candidate),
      })),
      ...PENDING_CANDIDATES.map((candidate) => ({
        candidate,
        reason: 'implementation-unavailable',
        status: 'pending',
        workloads: [],
      })),
    ],
    profile: PORTABLE_EQUIVALENCE_PROFILE,
    schema: PORTABLE_EXECUTOR_BENCHMARK_SCHEMA,
  }
  report.report_digest = portableExecutorBenchmarkReportDigest(report)
  return { ok: true, value: report }
}

export async function verifyPortableExecutorBenchmark(
  report,
  bundle,
  { loadGraph } = {},
) {
  const structural = validateReportStructure(report, bundle)
  if (!structural.ok) return structural
  const expected = await runPortableExecutorBenchmark(bundle, { loadGraph })
  if (!expected.ok) return expected

  for (let candidateIndex = 0;
    candidateIndex < MEASURED_CANDIDATES.length;
    candidateIndex += 1) {
    const actualRun = report.candidates[candidateIndex]
    const expectedRun = expected.value.candidates[candidateIndex]
    for (let workloadIndex = 0;
      workloadIndex < bundle.cases.length;
      workloadIndex += 1) {
      const actual = actualRun.workloads[workloadIndex]
      const authority = expectedRun.workloads[workloadIndex]
      if (!canonicalEqual(actual.request, authority.request)) {
        return rejected('portable-benchmark-request-authority-mismatch', {
          candidate: actualRun.candidate,
          workload: actual.id,
        })
      }
      if (!canonicalEqual(actual.result, authority.result)) {
        return rejected('portable-benchmark-result-authority-mismatch', {
          candidate: actualRun.candidate,
          workload: actual.id,
        })
      }
    }
  }
  return { ok: true }
}

export function portableEquivalenceRequestDigest(request) {
  if (!plainObject(request)) {
    throw new TypeError('invalid portable equivalence request')
  }
  const { request_digest: ignored, ...content } = request
  return digest(content)
}

export function portableEquivalenceResultDigest(result) {
  if (!plainObject(result)) {
    throw new TypeError('invalid portable equivalence result')
  }
  const { result_digest: ignored, ...content } = result
  return digest(content)
}

export function portableExecutorBenchmarkReportDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid portable executor benchmark report')
  }
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

async function prepareWorkload(entry, { loadGraph }) {
  let graph
  try {
    graph = await loadGraph(entry)
  } catch {
    return rejected('portable-benchmark-graph-load-failed', {
      workload: entry.id,
    })
  }
  if (!plainObject(graph)
    || graph.graph_revision !== entry.graph_revision) {
    return rejected('portable-benchmark-graph-authority-mismatch', {
      workload: entry.id,
    })
  }
  const compiled = compilePortableBytecode(graph)
  if (!compiled.ok) return withWorkload(compiled, entry.id)
  const request = {
    artifact_digest: compiled.value.artifact_digest,
    graph_revision: entry.graph_revision,
    input_digest: entry.contract.input_digest,
    profile: PORTABLE_EQUIVALENCE_PROFILE,
    schema: PORTABLE_EQUIVALENCE_REQUEST_SCHEMA,
    transcript_digest: digest(entry.invocations),
    workload_digest: digest({
      expected: entry.expected,
      graph: entry.graph,
      graph_revision: entry.graph_revision,
      id: entry.id,
      input_digest: entry.contract.input_digest,
      invocations: entry.invocations,
    }),
    workload_id: entry.id,
  }
  request.request_digest = portableEquivalenceRequestDigest(request)
  return {
    ok: true,
    value: {
      artifact: compiled.value,
      graph,
      request,
    },
  }
}

async function executeCandidate(candidate, prepared, entry) {
  const trace = []
  let execution
  if (candidate === 'node-reference') {
    const scripted = nodeReferenceCapability(prepared.graph, entry, trace)
    if (!scripted.ok) return scripted
    const outcome = executePortableProgram(prepared.graph, {
      invokeCapability: scripted.value.invoke,
    })
    const checked = scripted.value.finish()
    if (!checked.ok) return checked
    if (outcome.kind === 'check-failure' || outcome.kind === 'host-fault') {
      return rejected('portable-benchmark-node-reference-failed')
    }
    execution = {
      invocations: trace.map(({ instance, invocation_id, member, outcome }) => ({
        instance,
        invocation_id,
        member,
        outcome,
      })),
      outcome,
    }
  } else if (candidate === 'portable-core') {
    const scripted = scriptedCapability(entry, trace)
    const portable = executePortableProgramContract({
      contract: entry.contract,
      graph: prepared.graph,
      invokeCapability: scripted.invoke,
    })
    const checked = scripted.finish()
    if (!checked.ok) return checked
    if (!portable.ok) return portable
    execution = {
      invocations: portable.value.receipt.invocations,
      outcome: portable.value.outcome,
    }
  } else if (candidate === 'portable-process') {
    const processRequest = createPortableBytecodeProcessRequest({
      artifact: prepared.artifact,
      checkedGraph: prepared.graph,
      invocations: entry.invocations,
    })
    if (!processRequest.ok) return processRequest
    const processExecution = await executePortableBytecodeProcess({
      request: processRequest.value,
    })
    if (!processExecution.ok) return processExecution
    execution = {
      invocations: processExecution.value.execution.invocations,
      outcome: processExecution.value.execution.outcome,
    }
    trace.push(...entry.invocations.map((invocation) => ({
      arguments: snapshotJson(invocation.arguments),
      instance: invocation.instance,
      invocation_id: invocation.invocation_id,
      member: invocation.member,
      outcome: invocationOutcome(decodeValue(invocation.response)),
      response: snapshotJson(invocation.response),
    })))
  } else {
    return rejected('portable-benchmark-candidate-unsupported')
  }

  const oracle = validateOracleResult(execution, entry)
  if (!oracle.ok) return oracle
  const receipt = {
    artifact_digest: prepared.request.artifact_digest,
    graph_revision: prepared.request.graph_revision,
    input_digest: prepared.request.input_digest,
    invocations: snapshotJson(execution.invocations),
    outcome: snapshotJson(execution.outcome),
    schema: PORTABLE_EQUIVALENCE_RECEIPT_SCHEMA,
    transcript_digest: prepared.request.transcript_digest,
  }
  const result = {
    error: null,
    outcome: snapshotJson(execution.outcome),
    receipt,
    request_digest: prepared.request.request_digest,
    schema: PORTABLE_EQUIVALENCE_RESULT_SCHEMA,
    trace_digest: digest({
      invocations: trace,
      outcome: execution.outcome,
      transcript_digest: prepared.request.transcript_digest,
    }),
  }
  result.result_digest = portableEquivalenceResultDigest(result)
  return { ok: true, value: result }
}

function nodeReferenceCapability(graph, entry, trace) {
  const scripted = scriptedCapability(entry, trace)
  const metadata = new MemoryAdapter()
  const adapterMetadata = {
    resourceCatalog() {
      return metadata.resourceCatalog()
    },
    resourceParents() {
      return metadata.resourceParents()
    },
    supportedInterfaces() {
      return metadata.supportedInterfaces()
    },
  }
  const registry = SchemaRegistry.load(demoSchemaDefinitions())
  if (!registry.ok) return registry
  const instances = new Map()
  for (const capability of graph.capabilities) {
    const boundAdapter = {
      ...adapterMetadata,
      invoke(operation, args, invocationId) {
        return scripted.invoke(
          capability.instance,
          operation.member,
          args,
          invocationId,
          capability.reference,
        )
      },
    }
    instances.set(capability.instance, boundAdapter)
  }
  const bound = HostEnvironment.bind({
    bindings: graph.capabilities.map(({ instance }) => ({
      adapter: instances.get(instance),
      instance,
    })),
    capabilities: graph.capabilities,
    registry: registry.value,
  })
  if (!bound.ok) return bound
  return {
    ok: true,
    value: {
      finish: scripted.finish,
      invoke(instance, member, args, invocationId) {
        return bound.value.invoke(instance, member, args, invocationId)
      },
    },
  }
}

function scriptedCapability(entry, trace) {
  let index = 0
  let mismatch = null
  return {
    finish() {
      return mismatch === null && index === entry.invocations.length
        ? { ok: true }
        : rejected(
          mismatch ?? 'portable-benchmark-invocation-count-mismatch',
        )
    },
    invoke(instance, member, args, invocationId, reference) {
      const expected = entry.invocations[index]
      index += 1
      if (expected === undefined
        || expected.instance !== instance
        || expected.member !== member
        || expected.invocation_id !== invocationId) {
        mismatch = 'portable-benchmark-invocation-mismatch'
        return checkFailure(mismatch)
      }
      const declared = reference === undefined
        ? true
        : reference === capabilityReference(instance, member)
      if (!declared) {
        mismatch = 'portable-benchmark-capability-reference-mismatch'
        return checkFailure(mismatch)
      }
      if (!canonicalEqual(
        encodeValue(args),
        expectedInvocationArguments(expected.arguments, reference, member),
      )) {
        mismatch = 'portable-benchmark-invocation-arguments-mismatch'
        return checkFailure(mismatch)
      }
      const response = decodeValue(expected.response)
      trace.push({
        arguments: snapshotJson(expected.arguments),
        instance,
        invocation_id: invocationId,
        member,
        outcome: invocationOutcome(response),
        response: snapshotJson(expected.response),
      })
      return response
    },
  }
}

function expectedInvocationArguments(arguments_, reference, member) {
  if (reference === 'fs.read@0.1.0'
    && member === 'read_file'
    && !Object.hasOwn(arguments_, 'encoding')) {
    return {
      ...arguments_,
      encoding: 'text.encoding.utf8',
    }
  }
  return arguments_
}

function capabilityReference(instance, member) {
  if (instance === '@args' && member === 'read') {
    return 'process.args@0.1.0'
  }
  if (instance === '@stdout' && member === 'write') {
    return 'process.stdout@0.1.0'
  }
  if (member === 'read_file') return 'fs.read@0.1.0'
  if (member === 'write_file') return 'fs.write@0.1.0'
  return null
}

function validateOracleResult(execution, entry) {
  if (!canonicalEqual(execution.outcome, decodeValue(entry.expected.outcome))) {
    return rejected('portable-benchmark-oracle-outcome-mismatch', {
      workload: entry.id,
    })
  }
  if (!canonicalEqual(
    execution.invocations,
    decodeValue(entry.expected.receipt.invocations),
  )) {
    return rejected('portable-benchmark-oracle-receipt-mismatch', {
      workload: entry.id,
    })
  }
  return { ok: true }
}

function validateReportStructure(report, bundle) {
  if (!plainObject(report)
    || report.schema !== PORTABLE_EXECUTOR_BENCHMARK_SCHEMA) {
    return rejected('portable-benchmark-report-schema-mismatch')
  }
  if (!exactShape(report, REPORT_FIELDS)) {
    return rejected('portable-benchmark-report-fields-mismatch')
  }
  if (!DIGEST.test(report.report_digest)
    || report.report_digest !== portableExecutorBenchmarkReportDigest(report)) {
    return rejected('portable-benchmark-report-digest-mismatch')
  }
  if (report.profile !== PORTABLE_EQUIVALENCE_PROFILE
    || report.bundle_digest !== digest(bundle)) {
    return rejected('portable-benchmark-bundle-authority-mismatch')
  }
  if (!Array.isArray(report.candidates)
    || !canonicalEqual(
      report.candidates.map(({ candidate }) => candidate),
      CANDIDATES,
    )) {
    return rejected('portable-benchmark-candidate-set-mismatch')
  }

  const workloadIds = bundle.cases.map(({ id }) => id)
  for (let index = 0; index < report.candidates.length; index += 1) {
    const run = report.candidates[index]
    const candidate = CANDIDATES[index]
    if (!plainObject(run) || run.candidate !== candidate) {
      return rejected('portable-benchmark-candidate-set-mismatch')
    }
    if (MEASURED_CANDIDATES.includes(candidate)) {
      if (!exactShape(run, ['candidate', 'status', 'workloads'])
        || run.status !== 'measured'
        || !Array.isArray(run.workloads)
        || !canonicalEqual(
          run.workloads.map(({ id }) => id),
          workloadIds,
        )) {
        return rejected('portable-benchmark-workload-set-mismatch', {
          candidate,
        })
      }
      for (const workload of run.workloads) {
        const validated = validateMeasuredWorkload(workload)
        if (!validated.ok) return withCandidate(validated, candidate, workload?.id)
      }
    } else if (!exactShape(
      run,
      ['candidate', 'reason', 'status', 'workloads'],
    )
      || run.status !== 'pending'
      || run.reason !== 'implementation-unavailable'
      || !Array.isArray(run.workloads)
      || run.workloads.length !== 0) {
      return rejected('portable-benchmark-pending-candidate-invalid', {
        candidate,
      })
    }
  }
  return { ok: true }
}

function validateMeasuredWorkload(workload) {
  if (!plainObject(workload)
    || !exactShape(workload, ['id', 'request', 'result', 'schema'])
    || workload.schema !== PORTABLE_EQUIVALENCE_WORKLOAD_SCHEMA
    || typeof workload.id !== 'string') {
    return rejected('portable-benchmark-workload-invalid')
  }
  const request = workload.request
  if (!plainObject(request)
    || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== PORTABLE_EQUIVALENCE_REQUEST_SCHEMA
    || request.profile !== PORTABLE_EQUIVALENCE_PROFILE
    || request.workload_id !== workload.id
    || !REQUEST_FIELDS.filter((field) => field.endsWith('_digest'))
      .every((field) => DIGEST.test(request[field]))
    || request.request_digest !== portableEquivalenceRequestDigest(request)) {
    return rejected('portable-benchmark-request-invalid')
  }
  const result = workload.result
  if (!plainObject(result)
    || !exactShape(result, RESULT_FIELDS)
    || result.schema !== PORTABLE_EQUIVALENCE_RESULT_SCHEMA
    || !validError(result.error)
    || result.request_digest !== request.request_digest
    || !DIGEST.test(result.trace_digest)
    || !DIGEST.test(result.result_digest)
    || result.result_digest !== portableEquivalenceResultDigest(result)) {
    return rejected('portable-benchmark-result-invalid')
  }
  const receipt = result.receipt
  if (!plainObject(receipt)
    || !exactShape(receipt, RECEIPT_FIELDS)
    || receipt.schema !== PORTABLE_EQUIVALENCE_RECEIPT_SCHEMA
    || receipt.graph_revision !== request.graph_revision
    || receipt.artifact_digest !== request.artifact_digest
    || receipt.input_digest !== request.input_digest
    || receipt.transcript_digest !== request.transcript_digest
    || !canonicalEqual(receipt.outcome, result.outcome)
    || !Array.isArray(receipt.invocations)) {
    return rejected('portable-benchmark-receipt-invalid')
  }
  return { ok: true }
}

function validError(error) {
  return error === null
    || (plainObject(error)
      && exactShape(error, ['code', 'schema'])
      && error.schema === PORTABLE_EQUIVALENCE_ERROR_SCHEMA
      && typeof error.code === 'string'
      && error.code.length > 0)
}

function invocationOutcome(value) {
  if (value?.kind === 'value' && value.value?.kind === 'ok') return 'ok'
  if (value?.kind === 'value' && value.value?.kind === 'err') return 'err'
  if (value?.kind === 'host-fault') return 'host-fault'
  if (value?.kind === 'check-failure') return 'check-failure'
  return 'invalid'
}

function exactShape(value, fields) {
  return canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function withCandidate(result, candidate, workload) {
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      candidate,
      ...(workload === undefined ? {} : { workload }),
    })),
    ok: false,
  }
}

function withWorkload(result, workload) {
  return {
    diagnostics: result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      workload,
    })),
    ok: false,
  }
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (plainObject(value)) {
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '$bytes')) {
      if (typeof value.$bytes !== 'string'
        || !/^hex:(?:[0-9a-f]{2})*$/u.test(value.$bytes)) {
        throw new TypeError('invalid portable equivalence bytes')
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

function snapshotJson(value) {
  return value === undefined
    ? value
    : JSON.parse(JSON.stringify(encodeValue(value)))
}

function canonicalEqual(left, right) {
  return canonicalJson(encodeValue(left)) === canonicalJson(encodeValue(right))
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(encodeValue(value)))
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

function checkFailure(code) {
  return { diagnostics: [{ code }], kind: 'check-failure' }
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
