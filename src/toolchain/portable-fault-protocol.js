import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  executePortableBytecode,
} from './portable-bytecode.js'
import {
  createPortableBytecodeProcessRequest,
  executePortableBytecodeProcess,
  portableBytecodeProcessRequestDigest,
} from './portable-bytecode-process.js'
import {
  executePortableProgram,
} from './portable-executor.js'

export const PORTABLE_FAULT_CORPUS_SCHEMA =
  're.portable-fault-protocol-corpus@0.1.0'
export const PORTABLE_FAULT_REQUEST_SCHEMA =
  're.portable-fault-protocol-request@0.1.0'
export const PORTABLE_FAULT_ERROR_SCHEMA =
  're.portable-fault-error@0.1.0'
export const PORTABLE_FAULT_RESULT_SCHEMA =
  're.portable-fault-protocol-result@0.1.0'
export const PORTABLE_FAULT_REPORT_SCHEMA =
  're.portable-fault-protocol-report@0.1.0'
export const PORTABLE_FAULT_PROFILE =
  're.portable-fault-protocol@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCENARIO_FIELDS = ['id', 'kind']
const SCENARIO_KINDS = new Set([
  'core-check-failure',
  'core-capability-fault',
  'bytecode-check-failure',
  'bytecode-capability-fault',
  'process-preflight-check-failure',
  'process-spawn-fault',
  'process-timeout',
  'process-early-exit',
  'process-malformed-output',
  'process-multiline-output',
  'process-oversized-stdout',
  'process-oversized-stderr',
  'process-forged-output',
])
const REQUEST_FIELDS = [
  'corpus_digest',
  'graph_revision',
  'profile',
  'scenario_digest',
  'scenario_id',
  'request_digest',
  'schema',
]
const ERROR_FIELDS = ['candidate', 'code', 'phase', 'schema']
const RESULT_FIELDS = [
  'candidate',
  'diagnostic',
  'error',
  'request_digest',
  'result_digest',
  'schema',
  'terminal',
  'trace',
  'trace_digest',
]
const REPORT_FIELDS = [
  'bundle_digest',
  'graph_revision',
  'profile',
  'report_digest',
  'schema',
  'workloads',
]
const DEFAULT_TIMEOUT_MS = 25

export async function runPortableFaultProtocolBenchmark(
  corpus,
  { graph } = {},
) {
  const corpusResult = validatePortableFaultCorpus(corpus)
  if (!corpusResult.ok) return corpusResult
  if (!plainObject(graph) || !DIGEST.test(graph.graph_revision)) {
    return rejected('portable-fault-graph-invalid')
  }
  const root = await mkdtemp(join(tmpdir(), 're-portable-fault-'))
  try {
    const workers = await createFaultWorkers(root)
    const workloads = []
    for (const scenario of corpus.scenarios) {
      const request = createRequest(scenario, graph.graph_revision, corpus)
      const result = await executeScenario(
        scenario,
        graph,
        request,
        workers,
      )
      if (!result.ok) return result
      workloads.push({
        id: scenario.id,
        request: request,
        result: result.value,
        schema: 're.portable-fault-protocol-workload@0.1.0',
      })
    }
    const report = {
      bundle_digest: digest(corpus),
      graph_revision: graph.graph_revision,
      profile: PORTABLE_FAULT_PROFILE,
      schema: PORTABLE_FAULT_REPORT_SCHEMA,
      workloads,
    }
    report.report_digest = portableFaultProtocolReportDigest(report)
    return { ok: true, value: report }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

export async function verifyPortableFaultProtocolBenchmark(
  report,
  corpus,
  { graph } = {},
) {
  const structural = validateReport(report, corpus, graph)
  if (!structural.ok) return structural
  const expected = await runPortableFaultProtocolBenchmark(corpus, { graph })
  if (!expected.ok) return expected
  if (canonicalJson(report) === canonicalJson(expected.value)) return { ok: true }
  for (let index = 0; index < report.workloads.length; index += 1) {
    const actual = report.workloads[index]
    const authority = expected.value.workloads[index]
    if (!canonicalEqual(actual.request, authority.request)) {
      return rejected('portable-fault-request-authority-mismatch', {
        workload: actual.id,
      })
    }
    if (!canonicalEqual(actual.result, authority.result)) {
      return rejected('portable-fault-result-authority-mismatch', {
        workload: actual.id,
      })
    }
  }
  return rejected('portable-fault-report-authority-mismatch')
}

export function portableFaultProtocolRequestDigest(request) {
  if (!plainObject(request)) throw new TypeError('invalid fault request')
  const { request_digest: ignored, ...content } = request
  return digest(content)
}

export function portableFaultProtocolResultDigest(result) {
  if (!plainObject(result)) throw new TypeError('invalid fault result')
  const { result_digest: ignored, ...content } = result
  return digest(content)
}

export function portableFaultProtocolReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid fault report')
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

function createRequest(scenario, graphRevision, corpus) {
  const request = {
    corpus_digest: digest(corpus),
    graph_revision: graphRevision,
    profile: PORTABLE_FAULT_PROFILE,
    scenario_digest: digest(scenario),
    scenario_id: scenario.id,
    schema: PORTABLE_FAULT_REQUEST_SCHEMA,
  }
  request.request_digest = portableFaultProtocolRequestDigest(request)
  return request
}

async function executeScenario(scenario, graph, request, workers) {
  const trace = []
  let candidate
  let observed
  if (scenario.kind === 'core-check-failure') {
    candidate = 'portable-core'
    trace.push(...['preflight-start', 'preflight-rejected'])
    observed = executePortableProgram({ functions: [] }, {
      invokeCapability: () => {
        throw new Error('must not invoke')
      },
    })
  } else if (scenario.kind === 'core-capability-fault') {
    candidate = 'portable-core'
    trace.push(...[
      'preflight-start',
      'preflight-accepted',
      'capability-invoke',
    ])
    observed = executePortableProgram(graph, {
      invokeCapability: () => {
        throw new Error('fault')
      },
    })
    trace.push('capability-fault')
  } else if (scenario.kind === 'bytecode-check-failure'
    || scenario.kind === 'bytecode-capability-fault') {
    candidate = 'portable-bytecode'
    const artifact = await compileArtifact(graph)
    if (!artifact.ok) return artifact
    trace.push('preflight-start')
    if (scenario.kind === 'bytecode-check-failure') {
      observed = executePortableBytecode({
        artifact: artifact.value,
        checkedGraph: graph,
        expectedArtifactDigest: artifact.value.artifact_digest,
        expectedGraphRevision: `sha256:${'f'.repeat(64)}`,
        invokeCapability: () => {
          throw new Error('must not invoke')
        },
      })
      trace.push('preflight-rejected')
    } else {
      trace.push('preflight-accepted', 'capability-invoke')
      observed = executePortableBytecode({
        artifact: artifact.value,
        checkedGraph: graph,
        expectedArtifactDigest: artifact.value.artifact_digest,
        expectedGraphRevision: graph.graph_revision,
        invokeCapability: () => {
          throw new Error('fault')
        },
      })
      trace.push('capability-fault')
    }
  } else {
    return executeProcessScenario(scenario, graph, request, workers)
  }
  trace.push('terminal')
  return faultResult({
    candidate,
    observed,
    request,
    trace,
  })
}

async function executeProcessScenario(scenario, graph, request, workers) {
  const trace = []
  let processRequest = await createProcessRequest(graph)
  if (scenario.kind === 'process-preflight-check-failure') {
    processRequest = structuredClone(processRequest)
    processRequest.artifact_digest = `sha256:${'a'.repeat(64)}`
    processRequest.request_digest =
      portableBytecodeProcessRequestDigest(processRequest)
  }
  const workerPath = workers[scenario.kind]
  const result = await executePortableBytecodeProcess({
    request: processRequest,
    timeoutMs: scenario.kind === 'process-timeout'
      ? DEFAULT_TIMEOUT_MS
      : 2_000,
    workerPath,
    onEvent: ({ kind }) => trace.push(kind),
    spawnProcess: scenario.kind === 'process-spawn-fault'
      ? () => {
        throw new Error('spawn fault')
      }
      : undefined,
  })
  return faultResult({
    candidate: 'portable-process',
    observed: result,
    request,
    trace,
  })
}

async function createProcessRequest(graph) {
  const artifact = await compileArtifact(graph)
  if (!artifact.ok) return artifact
  const created = createPortableBytecodeProcessRequest({
    artifact: artifact.value,
    checkedGraph: graph,
    invocations: [{
      arguments: { data: 'Hello, World!\n' },
      instance: '@stdout',
      invocation_id: 'aaaaaacaaaaaaaaaaaaaaaaaaa',
      member: 'write',
      response: {
        kind: 'value',
        value: { kind: 'ok', value: null },
      },
    }],
  })
  return created.ok ? created.value : created
}

async function compileArtifact(graph) {
  const { compilePortableBytecode } = await import('./portable-bytecode.js')
  return compilePortableBytecode(graph)
}

function faultResult({ candidate, observed, request, trace }) {
  const diagnostic = observed?.diagnostics?.[0] ?? {
    code: 'portable-fault-observation-invalid',
  }
  const result = {
    candidate,
    diagnostic: snapshotJson(diagnostic),
    error: {
      candidate,
      code: diagnostic.code,
      phase: phaseFor(candidate, diagnostic.code),
      schema: PORTABLE_FAULT_ERROR_SCHEMA,
    },
    request_digest: request.request_digest,
    schema: PORTABLE_FAULT_RESULT_SCHEMA,
    terminal: 'error',
    trace: trace.map((kind) => ({ kind })),
  }
  result.trace_digest = digest(result.trace)
  result.result_digest = portableFaultProtocolResultDigest(result)
  return { ok: true, value: result }
}

function phaseFor(candidate, code) {
  if (candidate === 'portable-process') {
    if (code.includes('request') || code.includes('artifact')
      || code.includes('graph') || code.includes('invocation')) {
      return 'preflight'
    }
    if (code.includes('timeout') || code.includes('child')
      || code.includes('spawn')
      || code.includes('result')) {
      return 'process'
    }
  }
  if (code.includes('capability')) return 'capability'
  return 'check'
}

async function createFaultWorkers(root) {
  const workers = {
    'process-early-exit': await writeWorker(root, 'early-exit', `
      process.stdin.resume()
      process.exit(17)
    `),
    'process-forged-output': await writeWorker(root, 'forged-output', `
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => { input += chunk })
      process.stdin.on('end', () => {
        const request = JSON.parse(input)
        process.stdout.write(JSON.stringify({
          diagnostics: [{ code: 'forged' }],
          ok: false
        }) + '\\n')
      })
    `),
    'process-malformed-output': await writeWorker(root, 'malformed', `
      process.stdin.resume()
      process.stdin.on('end', () => process.stdout.write('{\\n'))
    `),
    'process-multiline-output': await writeWorker(root, 'multiline', `
      process.stdin.resume()
      process.stdin.on('end', () => process.stdout.write('{}\\n{}\\n'))
    `),
    'process-oversized-stdout': await writeWorker(root, 'oversized-stdout', `
      process.stdin.resume()
      process.stdin.on('end', () => process.stdout.write('x'.repeat(1048577)))
    `),
    'process-oversized-stderr': await writeWorker(root, 'oversized-stderr', `
      process.stdin.resume()
      process.stderr.write('x'.repeat(1048577))
    `),
    'process-timeout': await writeWorker(root, 'timeout', `
      setInterval(() => {}, 1000)
    `),
    'process-spawn-fault': Symbol('invalid-worker-path'),
  }
  return workers
}

async function writeWorker(root, name, body) {
  const path = join(root, `${name}.mjs`)
  await writeFile(path, `${body.trim()}\n`, 'utf8')
  return path
}

function validatePortableFaultCorpus(corpus) {
  if (!plainObject(corpus)
    || corpus.schema !== PORTABLE_FAULT_CORPUS_SCHEMA
    || !Array.isArray(corpus.scenarios)) {
    return rejected('portable-fault-corpus-invalid')
  }
  const diagnostics = []
  const ids = new Set()
  const kinds = new Set()
  for (const scenario of corpus.scenarios) {
    if (!plainObject(scenario)) {
      diagnostics.push({ code: 'portable-fault-scenario-invalid' })
      continue
    }
    exactFields(scenario, SCENARIO_FIELDS, 'portable-fault-scenario', diagnostics)
    if (typeof scenario.id !== 'string'
      || !SCENARIO_KINDS.has(scenario.kind)
      || ids.has(scenario.id)
      || kinds.has(scenario.kind)) {
      diagnostics.push({ code: 'portable-fault-scenario-invalid', id: scenario.id })
    }
    ids.add(scenario.id)
    kinds.add(scenario.kind)
  }
  if (ids.size !== SCENARIO_KINDS.size
    || [...SCENARIO_KINDS].some((kind) => !kinds.has(kind))) {
    diagnostics.push({ code: 'portable-fault-scenario-set-mismatch' })
  }
  return verificationResult(diagnostics)
}

function validateReport(report, corpus, graph) {
  if (!plainObject(report)) return rejected('portable-fault-report-invalid')
  const reportDiagnostics = []
  exactFields(report, REPORT_FIELDS, 'portable-fault-report', reportDiagnostics)
  if (reportDiagnostics.length > 0) {
    return { diagnostics: reportDiagnostics, ok: false }
  }
  if (report.schema !== PORTABLE_FAULT_REPORT_SCHEMA
    || report.profile !== PORTABLE_FAULT_PROFILE
    || report.bundle_digest !== digest(corpus)
    || report.graph_revision !== graph.graph_revision
    || report.report_digest !== portableFaultProtocolReportDigest(report)) {
    return rejected('portable-fault-report-authority-mismatch')
  }
  if (!Array.isArray(report.workloads)
    || report.workloads.length !== corpus.scenarios.length) {
    return rejected('portable-fault-workload-set-mismatch')
  }
  for (let index = 0; index < report.workloads.length; index += 1) {
    const workload = report.workloads[index]
    const scenario = corpus.scenarios[index]
    if (!plainObject(workload)
      || workload.id !== scenario.id
      || workload.request?.scenario_id !== scenario.id
      || workload.schema !== 're.portable-fault-protocol-workload@0.1.0') {
      return rejected('portable-fault-workload-set-mismatch')
    }
    const requestDiagnostics = []
    exactFields(
      workload.request,
      REQUEST_FIELDS,
      'portable-fault-request',
      requestDiagnostics,
    )
    const resultDiagnostics = []
    exactFields(
      workload.result,
      RESULT_FIELDS,
      'portable-fault-result',
      resultDiagnostics,
    )
    const errorDiagnostics = []
    exactFields(
      workload.result?.error,
      ERROR_FIELDS,
      'portable-fault-error',
      errorDiagnostics,
    )
    if (requestDiagnostics.length > 0
      || resultDiagnostics.length > 0
      || errorDiagnostics.length > 0) {
      return {
        diagnostics: [
          ...requestDiagnostics,
          ...resultDiagnostics,
          ...errorDiagnostics,
        ],
        ok: false,
      }
    }
    if (workload.request.schema !== PORTABLE_FAULT_REQUEST_SCHEMA
      || workload.request.profile !== PORTABLE_FAULT_PROFILE
      || workload.request.corpus_digest !== digest(corpus)
      || workload.request.graph_revision !== graph.graph_revision
      || workload.result.schema !== PORTABLE_FAULT_RESULT_SCHEMA
      || workload.result.candidate !== workload.result.error?.candidate
      || workload.result.error?.schema !== PORTABLE_FAULT_ERROR_SCHEMA
      || workload.result.terminal !== 'error'
      || !Array.isArray(workload.result.trace)
      || workload.result.trace.some((event) => (
        !plainObject(event)
        || Object.keys(event).length !== 1
        || typeof event.kind !== 'string'
      ))) {
      return rejected('portable-fault-result-schema-mismatch')
    }
    if (workload.request.request_digest
      !== portableFaultProtocolRequestDigest(workload.request)
      || workload.result.result_digest
      !== portableFaultProtocolResultDigest(workload.result)
      || workload.result.request_digest !== workload.request.request_digest
      || workload.result.trace_digest !== digest(workload.result.trace)) {
      return rejected('portable-fault-workload-authority-mismatch')
    }
  }
  return { ok: true }
}

function exactFields(value, expected, prefix, diagnostics) {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) diagnostics.push({ code: `${prefix}-unexpected-field`, field: key })
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) diagnostics.push({ code: `${prefix}-missing-field`, field: key })
  }
}

function verificationResult(diagnostics) {
  return diagnostics.length === 0 ? { ok: true } : { diagnostics, ok: false }
}

function rejected(code, extra = {}) {
  return { diagnostics: [{ code, ...extra }], ok: false }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
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

function snapshotJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
