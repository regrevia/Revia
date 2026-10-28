import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'

import {
  agentAdapterContractDigest,
  invokeAgentCapability,
} from '../host/agent-adapter-contract.js'
import { AgentMemoryAdapter, agentMemoryResponseKey } from '../host/agent-memory-adapter.js'
import { executeBusinessFunction } from './business-function-executor.js'
import { lowerConcurrency } from './concurrency-contract.js'
import {
  executeProjectConcurrency,
  verifyProjectConcurrencyAudit,
} from './project-runtime.js'
import { executeTask } from './task-runtime.js'
import { taskContractDigest, taskIdentity } from './task-contract.js'
import { canonicalizeValue } from './type-contract.js'

export const PROJECT_RUN_SELECTION_SCHEMA = 're.project-run-selection@0.1.0'
export const PROJECT_RUN_FIXTURE_SCHEMA = PROJECT_RUN_SELECTION_SCHEMA
export const PROJECT_RUN_RECEIPT_SCHEMA = 're.project-run-receipt@0.3.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INTERNAL_PROJECT_RUN_SCHEMA = 're.project-run-expanded@0.1.0'
const SELECTION_FIELDS = ['case', 'graph_revision', 'run', 'schema']
const FIXTURE_FIELDS = ['adapter', 'graph_revision', 'request', 'run', 'schema', 'task']
const ADAPTER_FIELDS = ['contract', 'responses']
const RESPONSE_FIELDS = ['input', 'outcome']
const RUN_FIELDS = ['cancel_at', 'replay']
const TASK_FIELDS = ['contract', 'name', 'task_id']
const RECEIPT_FIELDS = [
  'adapter', 'business', 'concurrency', 'fixture_digest', 'graph_revision', 'project_digest',
  'receipt_digest', 'replay', 'schema', 'task', 'typed_outcome',
]

export async function executeProjectRun(project, fixtureFile, options = {}) {
  try {
    assertRunOptions(options)
    const selection = await readFixture(fixtureFile)
    const validated = validateProjectRunFixture(project, selection)
    const fixture = validated.fixture
    const adapter = options.adapter_factory === undefined
      ? runCaseAdapter(fixture.adapter.contract, fixture.adapter.responses)
      : options.adapter_factory({
        contract: structuredClone(fixture.adapter.contract),
        responses: structuredClone(fixture.adapter.responses),
      })
    const effects = new Map()
    const businessTrace = []
    const taskResult = await executeTask(
      fixture.task.contract,
      fixture.request,
      {
        cancel_at: fixture.run.cancel_at,
        effects,
        perform: async ({ attempt, input }) => {
          if (validated.business === null) {
            const adapterResult = await invokeAgentCapability(
              fixture.adapter.contract,
              adapter,
              {
                capability_reference: fixture.adapter.contract.capability.reference,
                cancellation: null,
                deadline: null,
                input: { ...input, attempt },
                member: fixture.adapter.contract.capability.member,
                request_id: `${fixture.request.idempotency_key}:${attempt}`,
              },
            )
            return taskOutcome(
              adapterResult.ok ? adapterResult.value?.outcome : null,
              attempt,
              validated.effectKey,
            )
          }
          const execution = await executeBusinessFunction({
            adapter,
            adapter_contract: fixture.adapter.contract,
            declarations: validated.declarations,
            function_declaration: validated.business.declaration,
            input,
            request_id: `${fixture.request.idempotency_key}:${attempt}`,
          })
          if (!execution.ok) {
            throw Object.assign(new Error(execution.diagnostics[0].code), {
              diagnostic: execution.diagnostics[0],
            })
          }
          businessTrace.push(...execution.value.trace)
          return taskOutcome(execution.value.outcome, attempt, validated.effectKey)
        },
      },
    )
    if (!taskResult.ok) return taskResult

    const typedOutcome = projectTypedOutcome(taskResult.value)
    const replay = fixture.run.replay && taskResult.value.outcome === 'succeeded'
      ? await executeTask(fixture.task.contract, fixture.request, {
        effects,
        perform: async () => {
          throw new Error('project-run replay performer must not execute')
        },
      })
      : null

    const concurrency = await executeProjectConcurrency(
      concurrencyProject(project.graph_revision, validated.effectKey),
      {
        branches: new Map([
          ['run', async ({ runEffect }) =>
            runEffect('run', async () => taskResult.value.output)],
          ['receipt', async ({ runEffect }) =>
            runEffect('bind', async () => project.graph_revision)],
        ]),
      },
    )
    if (!concurrency.ok) return concurrency

    const receipt = {
      adapter: {
        contract_digest: validated.adapterContractDigest,
        profile: fixture.adapter.contract.profile,
      },
      business: validated.business === null ? null : {
        declaration_digest: validated.business.declaration_digest,
        execution_trace: businessTrace,
        function: validated.business.name,
      },
      concurrency: {
        audit: concurrency.project_audit,
        verification: concurrency.verification,
      },
      fixture_digest: validated.fixtureDigest,
      graph_revision: project.graph_revision,
      project_digest: project.project_digest,
      replay: replay === null ? null : {
        attempts: replay.value?.attempts ?? null,
        replayed: replay.value?.replayed === true,
        task_id: replay.value?.task_id ?? null,
      },
      schema: PROJECT_RUN_RECEIPT_SCHEMA,
      task: {
        attempts: taskResult.value.attempts,
        contract_digest: validated.taskContractDigest,
        declared_task_id: fixture.task.task_id,
        effect_key: taskResult.value.effect_key ?? null,
        error: taskResult.value.error ?? null,
        name: fixture.task.name,
        outcome: taskResult.value.outcome,
        output_digest: taskResult.value.outcome === 'succeeded'
          ? digest(taskResult.value.output)
          : null,
        task_id: taskResult.value.task_id,
        trace: taskResult.value.trace,
      },
      typed_outcome: typedOutcome,
    }
    const result = {
      ok: true,
      value: {
        ...receipt,
        receipt_digest: digest(receipt),
      },
    }
    const verification = verifyProjectRunReceipt(project, selection, result.value)
    if (!verification.ok) return verification
    return result
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'project-run-failure' }],
      ok: false,
    }
  }
}

async function readFixture(file) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('project-run-fixture-not-regular-file')
    }
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.diagnostic !== undefined) throw error
    fail(error.code === 'ENOENT' ? 'project-run-fixture-missing' : 'project-run-fixture-invalid')
  }
}

export function verifyProjectRunReceipt(project, fixture, receipt) {
  try {
    const validated = validateProjectRunFixture(project, fixture)
    const expanded = validated.fixture
    exactFields(receipt, RECEIPT_FIELDS, 'project-run-receipt')
    if (receipt.schema !== PROJECT_RUN_RECEIPT_SCHEMA
      || receipt.graph_revision !== project.graph_revision
      || receipt.project_digest !== project.project_digest
      || receipt.fixture_digest !== validated.fixtureDigest) {
      fail('invalid-project-run-receipt')
    }
    const { receipt_digest: receiptDigest, ...withoutDigest } = receipt
    if (receiptDigest !== digest(withoutDigest)) fail('invalid-project-run-receipt')
    exactFields(receipt.adapter, ['contract_digest', 'profile'], 'project-run-receipt-adapter')
    if (receipt.adapter.contract_digest !== validated.adapterContractDigest
      || !same(receipt.adapter.profile, expanded.adapter.contract.profile)) {
      fail('invalid-project-run-receipt')
    }
    if (validated.business === null) {
      if (receipt.business !== null) fail('invalid-project-run-receipt')
    } else {
      exactFields(
        receipt.business,
        ['declaration_digest', 'execution_trace', 'function'],
        'project-run-receipt-business',
      )
      if (receipt.business.function !== validated.business.name
        || receipt.business.declaration_digest
          !== validated.business.declaration_digest
        || !validBusinessTrace(
          receipt.business.execution_trace,
          expanded,
          validated.business,
          validated.declarations,
          receipt.task?.attempts,
        )) {
        fail('invalid-project-run-receipt')
      }
    }
    exactFields(receipt.task, [
      'attempts', 'contract_digest', 'declared_task_id', 'effect_key',
      'error', 'name', 'outcome', 'output_digest', 'task_id', 'trace',
    ], 'project-run-receipt-task')
    const identity = taskIdentity(expanded.task.contract, expanded.request)
    if (!identity.ok
      || receipt.task.contract_digest !== validated.taskContractDigest
      || receipt.task.declared_task_id !== expanded.task.task_id
      || receipt.task.name !== expanded.task.name
      || receipt.task.task_id !== identity.value.task_id
      || !Number.isSafeInteger(receipt.task.attempts)
      || !Array.isArray(receipt.task.trace)) {
      fail('invalid-project-run-receipt')
    }
    const expectedAdapterOutcome = adapterOutcomeForAttempt(
      expanded,
      receipt.task.attempts,
    )
    if (receipt.task.outcome === 'succeeded') {
      if (receipt.task.error !== null
        || receipt.task.effect_key !== validated.effectKey
        || receipt.task.output_digest !== digest(receipt.typed_outcome?.value)
        || receipt.typed_outcome?.kind !== 'ok'
        || expectedAdapterOutcome?.kind !== 'ok'
        || !same(expectedAdapterOutcome.value, receipt.typed_outcome.value)) {
        fail('invalid-project-run-receipt')
      }
    } else if (receipt.task.outcome === 'failed') {
      if (receipt.task.effect_key !== null
        || receipt.task.output_digest !== null
        || receipt.task.error?.code === undefined
        || receipt.typed_outcome?.kind !== 'err'
        || !same(receipt.task.error, receipt.typed_outcome.error)
        || expectedAdapterOutcome?.kind !== 'err'
        || expectedAdapterOutcome.error.variant !== receipt.task.error.code) {
        fail('invalid-project-run-receipt')
      }
    } else if (receipt.task.outcome === 'cancelled') {
      if (receipt.task.effect_key !== null
        || receipt.task.output_digest !== null
        || receipt.task.error !== null
        || receipt.typed_outcome?.kind !== 'cancelled') {
        fail('invalid-project-run-receipt')
      }
    } else {
      fail('invalid-project-run-receipt')
    }
    if (receipt.task.outcome === 'succeeded' && expanded.run.replay === true) {
      exactFields(receipt.replay, ['attempts', 'replayed', 'task_id'], 'project-run-receipt-replay')
      if (receipt.replay.replayed !== true
        || receipt.replay.attempts !== receipt.task.attempts
        || receipt.replay.task_id !== receipt.task.task_id) {
        fail('invalid-project-run-receipt')
      }
    } else if (receipt.replay !== null) {
      fail('invalid-project-run-receipt')
    }
    exactFields(receipt.concurrency, ['audit', 'verification'], 'project-run-receipt-concurrency')
    const concurrency = verifyProjectConcurrencyAudit(
      concurrencyProject(project.graph_revision, validated.effectKey),
      receipt.concurrency.audit,
    )
    if (!concurrency.ok || receipt.concurrency.verification?.ok !== true) {
      fail('invalid-project-run-receipt')
    }
    return { ok: true }
  } catch {
    return {
      diagnostics: [{ code: 'invalid-project-run-receipt' }],
      ok: false,
    }
  }
}

function validateProjectRunFixture(project, fixture) {
  exactFields(fixture, SELECTION_FIELDS, 'project-run-selection')
  if (fixture.schema !== PROJECT_RUN_SELECTION_SCHEMA) {
    fail('unsupported-project-run-fixture')
  }
  if (!DIGEST.test(fixture.graph_revision)
    || fixture.graph_revision !== project.graph_revision
    || project.project_digest !== project.graph_revision) {
    fail('project-run-graph-revision-mismatch')
  }
  exactFields(fixture.run, RUN_FIELDS, 'project-run')
  if (!['before_start', 'after_start', null].includes(fixture.run.cancel_at)
    || typeof fixture.run.replay !== 'boolean') {
    fail('invalid-project-run-options')
  }
  if (typeof fixture.case !== 'string') fail('invalid-project-run-case')
  const owner = project.modules.find((module) =>
    module.run_cases?.some(({ name }) => name === fixture.case))
  const runCase = owner?.run_cases?.find(({ name }) => name === fixture.case)
  if (owner === undefined || runCase === undefined) fail('project-run-case-not-found')
  const taskContract = owner.task_contracts?.find(({ name }) => name === runCase.task)
  const adapterContract = owner.adapter_contracts?.find(
    ({ name }) => name === runCase.adapter,
  )
  const declaredTask = owner.tasks?.find(({ name }) => name === runCase.task)
  const business = runCase.function === undefined
    ? null
    : owner.function_declarations?.find(({ name }) => name === runCase.function)
  if (taskContract === undefined
    || adapterContract === undefined
    || declaredTask === undefined
    || (runCase.function !== undefined && business === undefined)) {
    fail('project-run-case-contract-not-found')
  }
  const expanded = {
    adapter: {
      contract: adapterContract.contract,
      responses: runCase.responses,
    },
    graph_revision: fixture.graph_revision,
    request: {
      ...runCase.request,
      revision: project.graph_revision,
    },
    run: fixture.run,
    schema: INTERNAL_PROJECT_RUN_SCHEMA,
    task: {
      contract: taskContract.contract,
      name: taskContract.name,
      task_id: declaredTask.task_id,
    },
  }
  return {
    ...validateExpandedProjectRunFixture(project, expanded),
    business,
    declarations: project.modules.flatMap(
      ({ type_declarations: values = [] }) =>
        values.map(({ declaration }) => declaration),
    ),
    fixture: expanded,
    fixtureDigest: digest(fixture),
  }
}

function validateExpandedProjectRunFixture(project, fixture) {
  exactFields(fixture, FIXTURE_FIELDS, 'project-run-fixture')
  if (fixture.schema !== INTERNAL_PROJECT_RUN_SCHEMA) fail('unsupported-project-run-fixture')
  if (!DIGEST.test(fixture.graph_revision)
    || fixture.graph_revision !== project.graph_revision
    || project.project_digest !== project.graph_revision) {
    fail('project-run-graph-revision-mismatch')
  }
  exactTaskRequest(fixture.request)
  exactFields(fixture.task, TASK_FIELDS, 'project-run-task')
  if (!DIGEST.test(fixture.task.task_id)) fail('invalid-project-run-task-id')
  const module = project.modules.find(({ name }) => name === fixture.request.module)
  if (module === undefined) fail('project-run-task-module-not-found')
  const declaredTask = module.tasks?.find(({ name }) => name === fixture.task.name)
  if (declaredTask === undefined || declaredTask.task_id !== fixture.task.task_id) {
    fail('project-run-task-not-declared')
  }
  exactFields(fixture.adapter, ADAPTER_FIELDS, 'project-run-adapter')
  if (!Array.isArray(fixture.adapter.responses)) fail('invalid-project-run-adapter-responses')
  exactFields(fixture.run, RUN_FIELDS, 'project-run')
  if (!['before_start', 'after_start', null].includes(fixture.run.cancel_at)
    || typeof fixture.run.replay !== 'boolean') {
    fail('invalid-project-run-options')
  }
  const adapterContractDigest = digestValidated(
    fixture.adapter.contract,
    agentAdapterContractDigest,
    'invalid-project-run-adapter-contract',
  )
  const taskContractDigestValue = digestValidated(
    fixture.task.contract,
    taskContractDigest,
    'invalid-project-run-task-contract',
  )
  if (fixture.request.revision !== project.graph_revision
    || fixture.request.module !== module.name
    || fixture.request.agent !== fixture.task.contract.agent
    || fixture.request.node_uid !== fixture.task.contract.node_uid) {
    fail('project-run-task-identity-mismatch')
  }
  if (fixture.task.contract.module !== module.name
    || project.agents.find(({ agent }) => agent === fixture.task.contract.agent) === undefined) {
    fail('project-run-task-contract-detached')
  }
  if (fixture.adapter.contract.module !== module.name
    || fixture.adapter.contract.agent !== fixture.task.contract.agent
    || fixture.adapter.contract.node_uid !== fixture.task.contract.node_uid) {
    fail('project-run-adapter-detached')
  }
  const capability = module.surface.capabilities?.find((entry) =>
    entry.member === fixture.adapter.contract.capability.member
      && entry.reference === fixture.adapter.contract.capability.reference)
  if (capability === undefined
    || !project.allowed_capabilities?.includes(fixture.adapter.contract.capability.reference)
    || capability.uid !== fixture.adapter.contract.node_uid) {
    fail('project-run-capability-not-declared')
  }
  const resource = project.resources?.find(({ alias, key }) =>
    alias === fixture.adapter.contract.resource.constructor
      || key === fixture.adapter.contract.resource.constructor)
  if (resource === undefined) fail('project-run-resource-not-declared')
  return {
    adapterContractDigest,
    effectKey: `project-${fixture.task.task_id.slice('sha256:'.length, 24)}`,
    taskContractDigest: taskContractDigestValue,
  }
}

function adapterOutcomeForAttempt(fixture, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null
  const key = agentMemoryResponseKey({ ...fixture.request.input, attempt })
  const response = fixture.adapter.responses.find(
    ({ input }) => agentMemoryResponseKey(input) === key,
  )
  return response?.outcome?.value ?? {
    error: {
      type: fixture.adapter.contract.error_type.name,
      variant: 'unavailable',
    },
    kind: 'err',
  }
}

function exactTaskRequest(request) {
  exactFields(
    request,
    ['agent', 'idempotency_key', 'input', 'module', 'node_uid', 'revision'],
    'project-run-request',
  )
  if (typeof request.idempotency_key !== 'string') fail('invalid-project-run-request')
}

function responseMap(responses) {
  const result = new Map()
  for (const response of responses) {
    exactFields(response, RESPONSE_FIELDS, 'project-run-response')
    const key = agentMemoryResponseKey(response.input)
    if (result.has(key)) fail('duplicate-project-run-response')
    result.set(key, response.outcome)
  }
  return result
}

function taskOutcome(outcome, attempt, effectKey) {
  if (outcome?.kind === 'ok') {
    return {
      effect: { key: effectKey, payload: { typed_outcome: outcome } },
      kind: 'success',
      output: outcome.value,
    }
  }
  if (outcome?.kind === 'err') {
    return {
      checkpoint: { attempt },
      error: {
        code: outcome.error.variant,
        message: outcome.error.variant,
      },
      kind: 'error',
    }
  }
  fail('project-run-adapter-outcome-invalid')
}

function runCaseAdapter(contract, responses) {
  const memory = new AgentMemoryAdapter({
    contract,
    profile: contract.profile,
    responses: responseMap(responses),
  })
  return {
    invoke(operation, input, context) {
      const attempt = requestAttempt(context?.request_id)
      return memory.invoke(operation, { ...input, attempt }, context)
    },
    profileIdentity() {
      return memory.profileIdentity()
    },
  }
}

function requestAttempt(requestId) {
  const value = /:([1-9][0-9]*)$/u.exec(requestId)?.[1]
  const attempt = Number(value)
  if (!Number.isSafeInteger(attempt)) fail('invalid-project-run-attempt-request-id')
  return attempt
}

function validBusinessTrace(trace, fixture, business, declarations, attempts) {
  if (!Array.isArray(trace)) return false
  if (fixture.run.cancel_at === 'before_start') {
    return attempts === 0 && trace.length === 0
  }
  if (!Number.isSafeInteger(attempts)
    || attempts < 1
    || attempts > fixture.task.contract.max_attempts
    || trace.length !== attempts) return false
  const call = business.declaration.body.capability_calls[0]
  if (call === undefined) return false
  const canonicalInput = canonicalizeValue(
    business.declaration.input_type,
    fixture.request.input,
    declarations,
  )
  if (!canonicalInput.ok) return false
  const inputDigest = digest(canonicalInput.value)
  return trace.every((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    const attempt = index + 1
    const expected = adapterOutcomeForAttempt(fixture, attempt)
    return Object.keys(entry).sort(compareText).join(',')
        === 'call,capability_reference,input_digest,outcome_digest,request_id'
      && entry.call === call.id
      && entry.capability_reference === fixture.adapter.contract.capability.reference
      && entry.input_digest === inputDigest
      && entry.outcome_digest === digest(expected)
      && entry.request_id === `${fixture.request.idempotency_key}:${attempt}`
  })
}

function assertRunOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('invalid-project-run-options-container')
  }
  exactFields(
    options,
    ['adapter_factory'],
    'project-run-execution-options',
    { optional: ['adapter_factory'] },
  )
  if (options.adapter_factory !== undefined
    && typeof options.adapter_factory !== 'function') {
    fail('invalid-project-run-adapter-factory')
  }
}

function projectTypedOutcome(taskResult) {
  if (taskResult.outcome === 'succeeded') {
    return { kind: 'ok', value: taskResult.output }
  }
  if (taskResult.outcome === 'failed') {
    return { error: taskResult.error, kind: 'err' }
  }
  if (taskResult.outcome === 'cancelled') return { kind: 'cancelled' }
  fail('project-run-task-outcome-invalid')
}

function concurrencyProject(graphRevision, effectKey) {
  const digestValue = digest({ effectKey, graphRevision })
  const lowered = lowerConcurrency({
    kind: 'par',
    region: {
      branches: [
        concurrencyBranch('run', 'run', effectKey, digestValue),
        concurrencyBranch('receipt', 'bind', graphRevision, digestValue),
      ],
      cancel_reason_type: { arguments: [], declaration_digest: digestValue, kind: 'declared' },
      deadline: null,
      handles: [],
      id: 'project',
      join_type: { arguments: [], declaration_digest: digestValue, kind: 'declared' },
      task_outcome_digest: digestValue,
    },
    schema: 're.concurrency-contract@0.1.0',
  })
  if (!lowered.ok) fail('project-run-concurrency-plan-invalid')
  const scopePath = ['project']
  return {
    graph_revision: graphRevision,
    plan: lowered.plan,
    schema: 're.project-concurrency@0.1.0',
    tasks: ['run', 'receipt'].map((branch) => ({
      branch,
      graph_revision: graphRevision,
      mutable_aliases: [],
      resources: [{ alias: branch, key: `${branch}_resource`, mode: 'read' }],
      scope_path: scopePath,
      task_id: projectTaskId(graphRevision, scopePath, branch),
    })),
  }
}

function concurrencyBranch(id, effect, resourceKey, digestValue) {
  return {
    effects: [{
      after: [],
      cancellation: 'cooperative',
      footprint: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: digestValue,
          segments: [{
            canonical_hex: Buffer.from(resourceKey).toString('hex'),
            type_digest: digestValue,
          }],
        },
      }],
      id: effect,
      operation_digest: digestValue,
    }],
    id,
    output_type: 'unit',
  }
}

function projectTaskId(graphRevision, scopePath, branch) {
  return digest({ branch, graph_revision: graphRevision, scope_path: scopePath })
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function digestValidated(value, validator, code) {
  try {
    return validator(value)
  } catch {
    fail(code)
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function same(left, right) {
  return canonical(left) === canonical(right)
}

function compareText(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function exactFields(input, expected, label, { optional = [] } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(`invalid-${label}-shape`)
  }
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.some((field) => !wanted.includes(field))
    || wanted.some((field) => !optional.includes(field) && !actual.includes(field))) {
    const unexpected = actual.find((field) => !wanted.includes(field))
    fail(
      unexpected === undefined ? `missing-${label}-field` : `unexpected-${label}-field`,
      unexpected === undefined ? {} : { field: unexpected },
    )
  }
}

function fail(code, detail = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...detail } })
}
