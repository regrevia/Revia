import { createHash } from 'node:crypto'

import {
  taskContractDigest,
  taskIdentity,
} from './task-contract.js'
import { executeTask } from './task-runtime.js'

export const TASK_RUNTIME_LIFECYCLE_CORPUS_SCHEMA =
  're.task-runtime-lifecycle-corpus@0.1.0'
export const TASK_RUNTIME_LIFECYCLE_REQUEST_SCHEMA =
  're.task-runtime-lifecycle-request@0.1.0'
export const TASK_RUNTIME_LIFECYCLE_RESULT_SCHEMA =
  're.task-runtime-lifecycle-result@0.1.0'
export const TASK_RUNTIME_LIFECYCLE_RECEIPT_SCHEMA =
  're.task-runtime-lifecycle-receipt@0.1.0'
export const TASK_RUNTIME_LIFECYCLE_REPORT_SCHEMA =
  're.task-runtime-lifecycle-report@0.1.0'
export const TASK_RUNTIME_LIFECYCLE_PROFILE =
  're.task-runtime-lifecycle@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCENARIO_KINDS = Object.freeze([
  'success-resource-close',
  'retry-transient-success',
  'permanent-error',
  'replay-existing-effect',
  'cancel-before-start',
  'parent-already-aborted',
  'timeout-late-effect',
  'parent-wins-timeout',
  'performer-host-fault',
  'stale-checkpoint',
  'resource-close-fault',
  'cleanup-first-fault',
  'listener-setup-fault',
  'timer-setup-fault',
])
const REPORT_FIELDS = [
  'corpus_digest',
  'profile',
  'report_digest',
  'runtime',
  'schema',
  'workloads',
]
const WORKLOAD_FIELDS = ['id', 'request', 'result']
const REQUEST_FIELDS = [
  'contract_digest',
  'corpus_digest',
  'request_digest',
  'scenario_digest',
  'scenario_id',
  'schema',
  'task_request_digest',
]
const RESULT_FIELDS = [
  'error',
  'receipt',
  'request_digest',
  'result_digest',
  'schema',
  'terminal',
  'trace_digest',
]
const RECEIPT_FIELDS = [
  'attempts',
  'cancel_reason',
  'cleanup_events',
  'effect_count',
  'effects_digest',
  'output_digest',
  'performer_calls',
  'replayed',
  'schema',
  'task_id',
  'trace',
]

export async function runTaskRuntimeLifecycleBenchmark(corpus) {
  const validated = validateCorpus(corpus)
  if (!validated.ok) return validated
  const corpusDigest = digest(corpus)
  const contractDigest = taskContractDigest(corpus.contract)
  const taskRequestDigest = digest(corpus.request)
  const workloads = []

  for (const scenario of corpus.scenarios) {
    const request = {
      contract_digest: contractDigest,
      corpus_digest: corpusDigest,
      scenario_digest: digest(scenario),
      scenario_id: scenario.id,
      schema: TASK_RUNTIME_LIFECYCLE_REQUEST_SCHEMA,
      task_request_digest: taskRequestDigest,
    }
    request.request_digest = taskRuntimeLifecycleRequestDigest(request)
    const executed = await executeScenario(corpus, scenario, request)
    if (!executed.ok) return executed
    workloads.push({
      id: scenario.id,
      request,
      result: executed.value,
    })
  }

  const report = {
    corpus_digest: corpusDigest,
    profile: TASK_RUNTIME_LIFECYCLE_PROFILE,
    runtime: 'node-reference',
    schema: TASK_RUNTIME_LIFECYCLE_REPORT_SCHEMA,
    workloads,
  }
  report.report_digest = taskRuntimeLifecycleReportDigest(report)
  return { ok: true, value: report }
}

export async function verifyTaskRuntimeLifecycleBenchmark(report, corpus) {
  const structural = validateReport(report, corpus)
  if (!structural.ok) return structural
  const expected = await runTaskRuntimeLifecycleBenchmark(corpus)
  if (!expected.ok) return expected

  for (let index = 0; index < expected.value.workloads.length; index += 1) {
    const actual = report.workloads[index]
    const authority = expected.value.workloads[index]
    if (!canonicalEqual(actual.request, authority.request)) {
      return rejected('task-runtime-lifecycle-request-authority-mismatch', {
        workload: actual.id,
      })
    }
    if (!canonicalEqual(actual.result, authority.result)) {
      return rejected('task-runtime-lifecycle-result-authority-mismatch', {
        workload: actual.id,
      })
    }
  }
  return { ok: true }
}

export function taskRuntimeLifecycleRequestDigest(request) {
  if (!plainObject(request)) throw new TypeError('invalid lifecycle request')
  const { request_digest: ignored, ...content } = request
  return digest(content)
}

export function taskRuntimeLifecycleResultDigest(result) {
  if (!plainObject(result)) throw new TypeError('invalid lifecycle result')
  const { result_digest: ignored, ...content } = result
  return digest(content)
}

export function taskRuntimeLifecycleReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid lifecycle report')
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

async function executeScenario(corpus, scenario, request) {
  const identity = taskIdentity(corpus.contract, corpus.request)
  if (!identity.ok) return identity
  const effects = new Map()
  const cleanupEvents = []
  let performerCalls = 0
  let result

  try {
    if (scenario.kind === 'success-resource-close') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async () => success('success-effect'), count),
        resource: resource(cleanupEvents),
      })
    } else if (scenario.kind === 'retry-transient-success') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async ({ attempt }) => (
          attempt < 3
            ? retryError(attempt)
            : success('retry-effect', { approved: true })
        ), count),
        resource: resource(cleanupEvents),
      })
    } else if (scenario.kind === 'permanent-error') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async () => ({
          checkpoint: {},
          error: { code: 'validation', message: 'permanent' },
          kind: 'error',
        }), count),
        resource: resource(cleanupEvents),
      })
    } else if (scenario.kind === 'replay-existing-effect') {
      effects.set('replay-effect', {
        attempt: 2,
        effect_key: 'replay-effect',
        output: { approved: true },
        payload: { posted: true },
        task_id: identity.value.task_id,
      })
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
      })
    } else if (scenario.kind === 'cancel-before-start') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: 'before_start',
        checkpoint: null,
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
      })
    } else if (scenario.kind === 'parent-already-aborted') {
      const parent = new AbortController()
      parent.abort()
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
        signal: observedSignal(parent.signal, cleanupEvents),
      })
    } else if (scenario.kind === 'timeout-late-effect') {
      result = await executeCancellationScenario({
        cleanupEvents,
        contract: corpus.contract,
        effects,
        mode: 'timeout',
        request: corpus.request,
        onPerform: count,
      })
    } else if (scenario.kind === 'parent-wins-timeout') {
      result = await executeCancellationScenario({
        cleanupEvents,
        contract: corpus.contract,
        effects,
        mode: 'parent',
        request: corpus.request,
        onPerform: count,
      })
    } else if (scenario.kind === 'performer-host-fault') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        clearTimeoutImpl: () => cleanupEvents.push('timer-clear'),
        effects,
        perform: performer(async () => {
          throw new Error('private performer fault')
        }, count),
        resource: resource(cleanupEvents),
        setTimeoutImpl: () => ({ timer: 'deadline' }),
        timeout_ms: 25,
      })
    } else if (scenario.kind === 'stale-checkpoint') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: {
          attempt: 1,
          data: {},
          input_digest: `sha256:${'a'.repeat(64)}`,
          revision: 'stale',
          state: 'retrying',
          task_id: `sha256:${'b'.repeat(64)}`,
        },
        clearTimeoutImpl: () => cleanupEvents.push('timer-clear'),
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
        setTimeoutImpl: () => ({ timer: 'deadline' }),
        timeout_ms: 25,
      })
    } else if (scenario.kind === 'resource-close-fault') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        effects,
        perform: performer(async () => success('rollback-effect'), count),
        resource: resource(cleanupEvents, { fail: true }),
      })
    } else if (scenario.kind === 'cleanup-first-fault') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        clearTimeoutImpl: () => {
          cleanupEvents.push('timer-clear')
          throw new Error('private timer cleanup fault')
        },
        effects,
        perform: performer(async () => success('cleanup-rollback'), count),
        resource: resource(cleanupEvents, { fail: true }),
        setTimeoutImpl: () => ({ timer: 'deadline' }),
        signal: observedSignal(new AbortController().signal, cleanupEvents, {
          failRemove: true,
        }),
        timeout_ms: 25,
      })
    } else if (scenario.kind === 'listener-setup-fault') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        clearTimeoutImpl: () => cleanupEvents.push('timer-clear'),
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
        setTimeoutImpl: () => ({ timer: 'deadline' }),
        signal: observedSignal(new AbortController().signal, cleanupEvents, {
          failAdd: true,
        }),
        timeout_ms: 25,
      })
    } else if (scenario.kind === 'timer-setup-fault') {
      result = await executeTask(corpus.contract, corpus.request, {
        cancel_at: null,
        checkpoint: null,
        clearTimeoutImpl: () => cleanupEvents.push('timer-clear'),
        effects,
        perform: performer(async () => success('must-not-run'), count),
        resource: resource(cleanupEvents),
        setTimeoutImpl: () => {
          throw new Error('private timer setup fault')
        },
        signal: observedSignal(new AbortController().signal, cleanupEvents),
        timeout_ms: 25,
      })
    } else {
      return rejected('task-runtime-lifecycle-scenario-unsupported', {
        workload: scenario.id,
      })
    }
  } catch {
    return rejected('task-runtime-lifecycle-driver-fault', {
      workload: scenario.id,
    })
  }

  function count() {
    performerCalls += 1
  }

  const trace = result.ok ? snapshotJson(result.value.trace) : []
  const receipt = {
    attempts: result.ok ? result.value.attempts : performerCalls,
    cancel_reason: result.ok ? result.value.cancel_reason ?? null : null,
    cleanup_events: [...cleanupEvents],
    effect_count: effects.size,
    effects_digest: digest(snapshotEffects(effects)),
    output_digest: result.ok && Object.hasOwn(result.value, 'output')
      ? digest(result.value.output)
      : null,
    performer_calls: performerCalls,
    replayed: result.ok ? result.value.replayed : false,
    schema: TASK_RUNTIME_LIFECYCLE_RECEIPT_SCHEMA,
    task_id: identity.value.task_id,
    trace,
  }
  const lifecycleResult = {
    error: result.ok ? null : snapshotJson(result.diagnostics[0]),
    receipt,
    request_digest: request.request_digest,
    schema: TASK_RUNTIME_LIFECYCLE_RESULT_SCHEMA,
    terminal: result.ok ? result.value.outcome : 'rejected',
    trace_digest: digest({
      cleanup_events: receipt.cleanup_events,
      trace: receipt.trace,
    }),
  }
  lifecycleResult.result_digest = taskRuntimeLifecycleResultDigest(lifecycleResult)
  return { ok: true, value: lifecycleResult }
}

async function executeCancellationScenario({
  cleanupEvents,
  contract,
  effects,
  mode,
  onPerform,
  request,
}) {
  const parent = new AbortController()
  let fireTimer
  let started
  const performerStarted = new Promise((resolve) => { started = resolve })
  const run = executeTask(contract, request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => cleanupEvents.push('timer-clear'),
    effects,
    perform: performer(async ({ signal }) => {
      started()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, {
        once: true,
      }))
      return success('late-effect')
    }, onPerform),
    resource: resource(cleanupEvents),
    setTimeoutImpl: (callback) => {
      fireTimer = callback
      return { timer: 'deadline' }
    },
    signal: observedSignal(parent.signal, cleanupEvents),
    timeout_ms: 25,
  })
  await performerStarted
  if (mode === 'parent') {
    parent.abort()
    fireTimer()
  } else {
    fireTimer()
  }
  return run
}

function performer(operation, onCall) {
  return async (input) => {
    onCall()
    return operation(input)
  }
}

function success(effectKey, output = { approved: true }) {
  return {
    effect: { key: effectKey, payload: { posted: true } },
    kind: 'success',
    output,
  }
}

function retryError(attempt) {
  return {
    checkpoint: { cursor: attempt },
    error: { code: 'timeout', message: 'temporary' },
    kind: 'error',
  }
}

function resource(events, { fail = false } = {}) {
  return {
    close: async () => {
      events.push('resource-close')
      if (fail) throw new Error('private resource close fault')
    },
  }
}

function observedSignal(signal, events, {
  failAdd = false,
  failRemove = false,
} = {}) {
  return {
    get aborted() {
      return signal.aborted
    },
    addEventListener(type, listener, options) {
      signal.addEventListener(type, listener, options)
      if (failAdd) throw new Error('private signal setup fault')
    },
    removeEventListener(type, listener) {
      events.push('signal-remove')
      signal.removeEventListener(type, listener)
      if (failRemove) throw new Error('private signal cleanup fault')
    },
  }
}

function validateCorpus(corpus) {
  if (!plainObject(corpus)
    || !exactFields(corpus, ['contract', 'request', 'scenarios', 'schema'])
    || corpus.schema !== TASK_RUNTIME_LIFECYCLE_CORPUS_SCHEMA
    || !Array.isArray(corpus.scenarios)
    || corpus.scenarios.length !== SCENARIO_KINDS.length) {
    return rejected('invalid-task-runtime-lifecycle-corpus')
  }
  const ids = new Set()
  for (let index = 0; index < corpus.scenarios.length; index += 1) {
    const scenario = corpus.scenarios[index]
    if (!plainObject(scenario)
      || !exactFields(scenario, ['id', 'kind'])
      || scenario.kind !== SCENARIO_KINDS[index]
      || typeof scenario.id !== 'string'
      || scenario.id.length === 0
      || ids.has(scenario.id)) {
      return rejected('invalid-task-runtime-lifecycle-scenario')
    }
    ids.add(scenario.id)
  }
  const identity = taskIdentity(corpus.contract, corpus.request)
  return identity.ok ? { ok: true } : identity
}

function validateReport(report, corpus) {
  const corpusValidation = validateCorpus(corpus)
  if (!corpusValidation.ok) return corpusValidation
  if (!plainObject(report)
    || !exactFields(report, REPORT_FIELDS)
    || report.schema !== TASK_RUNTIME_LIFECYCLE_REPORT_SCHEMA
    || report.profile !== TASK_RUNTIME_LIFECYCLE_PROFILE
    || report.runtime !== 'node-reference'
    || report.corpus_digest !== digest(corpus)
    || report.report_digest !== taskRuntimeLifecycleReportDigest(report)
    || !Array.isArray(report.workloads)
    || report.workloads.length !== corpus.scenarios.length) {
    return rejected('invalid-task-runtime-lifecycle-report')
  }
  for (let index = 0; index < report.workloads.length; index += 1) {
    const workload = report.workloads[index]
    const scenario = corpus.scenarios[index]
    if (!plainObject(workload)
      || !exactFields(workload, WORKLOAD_FIELDS)
      || workload.id !== scenario.id
      || !validateRequest(workload.request)
      || !validateResult(workload.result, workload.request.request_digest)) {
      return rejected('invalid-task-runtime-lifecycle-workload', {
        workload: workload?.id,
      })
    }
  }
  return { ok: true }
}

function validateRequest(request) {
  return plainObject(request)
    && exactFields(request, REQUEST_FIELDS)
    && request.schema === TASK_RUNTIME_LIFECYCLE_REQUEST_SCHEMA
    && DIGEST.test(request.contract_digest)
    && DIGEST.test(request.corpus_digest)
    && DIGEST.test(request.task_request_digest)
    && DIGEST.test(request.scenario_digest)
    && typeof request.scenario_id === 'string'
    && request.scenario_id.length > 0
    && request.request_digest === taskRuntimeLifecycleRequestDigest(request)
}

function validateResult(result, requestDigest) {
  if (!plainObject(result)
    || !exactFields(result, RESULT_FIELDS)
    || result.schema !== TASK_RUNTIME_LIFECYCLE_RESULT_SCHEMA
    || result.request_digest !== requestDigest
    || !['succeeded', 'failed', 'cancelled', 'rejected'].includes(result.terminal)
    || !DIGEST.test(result.trace_digest)
    || !validateReceipt(result.receipt)
    || !(result.error === null
      || (plainObject(result.error) && typeof result.error.code === 'string'))
    || result.trace_digest !== digest({
      cleanup_events: result.receipt.cleanup_events,
      trace: result.receipt.trace,
    })
    || result.result_digest !== taskRuntimeLifecycleResultDigest(result)) {
    return false
  }
  return true
}

function validateReceipt(receipt) {
  return plainObject(receipt)
    && exactFields(receipt, RECEIPT_FIELDS)
    && receipt.schema === TASK_RUNTIME_LIFECYCLE_RECEIPT_SCHEMA
    && Number.isSafeInteger(receipt.attempts)
    && receipt.attempts >= 0
    && (receipt.cancel_reason === null
      || ['after_start', 'before_start', 'parent', 'timeout'].includes(
        receipt.cancel_reason,
      ))
    && Array.isArray(receipt.cleanup_events)
    && receipt.cleanup_events.every((event) => (
      ['resource-close', 'signal-remove', 'timer-clear'].includes(event)
    ))
    && Number.isSafeInteger(receipt.effect_count)
    && receipt.effect_count >= 0
    && DIGEST.test(receipt.effects_digest)
    && (receipt.output_digest === null || DIGEST.test(receipt.output_digest))
    && Number.isSafeInteger(receipt.performer_calls)
    && receipt.performer_calls >= 0
    && typeof receipt.replayed === 'boolean'
    && DIGEST.test(receipt.task_id)
    && Array.isArray(receipt.trace)
}

function snapshotEffects(effects) {
  return [...effects.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, value]) => [key, snapshotJson(value)])
}

function snapshotJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function exactFields(value, fields) {
  const actual = Object.keys(value).sort(compareText)
  const expected = [...fields].sort(compareText)
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index])
}

function canonicalEqual(left, right) {
  return stableJson(left) === stableJson(right)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}
