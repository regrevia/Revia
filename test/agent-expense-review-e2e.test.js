import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { lowerConcurrency } from '../src/toolchain/concurrency-contract.js'
import { validateAgentContract } from '../src/toolchain/agent-contract.js'
import { applyProjectPatch } from '../src/toolchain/project-patch.js'
import { executeProjectConcurrency } from '../src/toolchain/project-runtime.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'
import { translateProject } from '../src/toolchain/project-translator.js'
import { executeTask } from '../src/toolchain/task-runtime.js'

const fixture = new URL('./fixtures/agent-expense-review/', import.meta.url)
const digest = (letter) => `sha256:${letter.repeat(64)}`
const uid = (letter) => `${letter.repeat(25)}e`
const apiModuleUid = `${'n'.repeat(24)}fe`

test('expense-review project closes loader, patch, translation, task, and concurrency evidence', async () => {
  const loaded = await loadProjectDirectory(fixture.pathname)
  assert.equal(loaded.ok, true)
  const project = enrichProject(loaded.value)

  const translated = translateProject(project, { locale: 'en-US' })
  assert.equal(translated.ok, true)
  assert.equal(translated.value.facts.length > 15, true)
  assert.equal(translated.value.receipt.graph_revision, project.graph_revision)
  assert.equal(translated.value.renderings.html.includes('data-fact-id="fact:project/module/'), true)

  const patched = applyProjectPatch(project, {
    base_revision: project.graph_revision,
    operations: [{
      expected_uid: apiModuleUid,
      kind: 'add-state',
      module: 'agent.expense.api',
      value: { name: 'reviewed' },
    }],
    schema: 're.project-patch@0.1.0',
  })
  assert.equal(patched.ok, true, JSON.stringify(patched.diagnostics))
  assert.notEqual(patched.receipt.result_revision, project.graph_revision)
  assert.equal(patched.receipt.changed_fact_ids.some((id) => id.includes('reviewed')), true)

  const stale = applyProjectPatch(project, {
    base_revision: `sha256:${'0'.repeat(64)}`,
    operations: [{
      expected_uid: apiModuleUid,
      kind: 'add-state',
      module: 'agent.expense.api',
      value: { name: 'stale' },
    }],
    schema: 're.project-patch@0.1.0',
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.diagnostics[0].code, 'project-patch-base-revision-mismatch')

  const taskContract = {
    agent: 'agent.expense.intake',
    backoff_ms: [0],
    checkpoint: {
      fields: ['attempt', 'input_digest', 'revision'],
      revision_field: 'revision',
      schema: 're.task-checkpoint@0.1.0',
    },
    error_type: { kind: 'type', name: 'expense.error' },
    input_type: { kind: 'type', name: 'expense.input' },
    max_attempts: 2,
    module: 'agent.expense.intake',
    node_uid: uid('b'),
    output_type: { kind: 'type', name: 'expense.result' },
    retryable_errors: ['transient'],
    schema: 're.task-contract@0.1.0',
  }
  const taskRequest = {
    agent: taskContract.agent,
    idempotency_key: 'expense-001',
    input: { amount: '125.00', currency: { variant: 'usd' } },
    module: taskContract.module,
    node_uid: taskContract.node_uid,
    revision: project.graph_revision,
  }
  const effects = new Map()
  let attempts = 0
  const executed = await executeTask(taskContract, taskRequest, {
    effects,
    perform: async ({ attempt }) => {
      attempts += 1
      return attempt === 1
        ? { checkpoint: { attempt: 1 }, error: { code: 'transient', message: 'storage retry' }, kind: 'error' }
        : { effect: { key: 'expense:expense-001', payload: { approved: true } }, kind: 'success', output: { approved: true } }
    },
  })
  assert.equal(executed.ok, true)
  assert.equal(executed.value.outcome, 'succeeded')
  assert.equal(executed.value.attempts, 2)
  assert.equal(attempts, 2)
  const replay = await executeTask(taskContract, taskRequest, {
    effects,
    perform: async () => { throw new Error('replay must not perform') },
  })
  assert.equal(replay.value.replayed, true)
  let cancelledCalls = 0
  const cancelled = await executeTask(taskContract, {
    ...taskRequest,
    idempotency_key: 'expense-cancelled',
  }, {
    cancel_at: 'before_start',
    effects: new Map(),
    perform: async () => { cancelledCalls += 1 },
  })
  assert.equal(cancelled.value.outcome, 'cancelled')
  assert.equal(cancelledCalls, 0)

  const concurrency = await executeProjectConcurrency(
    concurrencyProject(project.graph_revision),
    {
      branches: new Map([
        ['persist', async ({ runEffect }) => runEffect('write', async () => 'saved')],
        ['notify', async ({ runEffect }) => runEffect('write', async () => 'notified')],
      ]),
    },
  )
  assert.equal(concurrency.ok, true)
  assert.equal(concurrency.verification.ok, true)
  assert.equal(concurrency.project_audit.graph_revision, project.graph_revision)
})

function enrichProject(input) {
  const project = structuredClone(input)
  project.allowed_capabilities = ['db.read@0.1.0', 'db.write@0.1.0', 'http.request@0.1.0']
  project.resources = [{ alias: 'expense_db', key: 'expense_db', uid: uid('f') }]
  project.modules = project.modules.map((module, index) => ({
    ...module,
    uid: `${'n'.repeat(24)}${String.fromCharCode(97 + index)}e`,
    edges: (module.edges ?? []).length === 0
      ? [{ from: `${module.name}.input`, to: `${module.name}.output`, uid: uid(String.fromCharCode(104 + index)) }]
      : module.edges,
    states: (module.states ?? []).length === 0
      ? [{ name: 'ready', uid: uid(String.fromCharCode(111 + index)) }]
      : module.states,
    tasks: (module.tasks ?? []).length === 0
      ? [{ name: `${module.name}.task`, task_id: digest(String.fromCharCode(97 + index)) }]
      : module.tasks,
    surface: {
      ...module.surface,
      capabilities: (module.surface.capabilities ?? []).length === 0 ? [{
        instance: `${module.name}.db`,
        member: index === 3 ? 'read' : 'write',
        reference: index === 3 ? 'db.read@0.1.0' : 'db.write@0.1.0',
        uid: uid(String.fromCharCode(117 + index)),
      }] : module.surface.capabilities,
      errors: (module.surface.errors ?? []).length === 0
        ? [{ name: `${module.name}.error`, uid: uid(String.fromCharCode(50 + index)) }]
        : module.surface.errors,
    },
  }))
  project.graph_revision = revision(project)
  project.project_digest = project.graph_revision
  return project
}

function concurrencyProject(graphRevision) {
  const planResult = lowerConcurrency({
    kind: 'par',
    region: {
      branches: ['persist', 'notify'].map((id) => ({
        effects: [{
          after: [],
          cancellation: 'cooperative',
          footprint: [{
            handle: null,
            mode: 'write',
            resource: {
              domain_digest: digest('a'),
              segments: [{ canonical_hex: Buffer.from(id).toString('hex'), type_digest: digest('b') }],
            },
          }],
          id: 'write',
          operation_digest: digest('c'),
        }],
        id,
        output_type: 'unit',
      })),
      cancel_reason_type: { arguments: [], declaration_digest: digest('d'), kind: 'declared' },
      deadline: null,
      handles: [],
      id: 'expense',
      join_type: { arguments: [], declaration_digest: digest('e'), kind: 'declared' },
      task_outcome_digest: digest('f'),
    },
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(planResult.ok, true, JSON.stringify(planResult))
  const tasks = planResult.plan.nodes.filter((node) => node.kind === 'task-scope').map((node) => {
    const branch = node.id.split('.').at(-1)
    const scopePath = ['expense']
    return {
      branch,
      graph_revision: graphRevision,
      mutable_aliases: [],
      resources: [{ alias: branch, key: branch, mode: 'write' }],
      scope_path: scopePath,
      task_id: concurrencyTaskId(graphRevision, scopePath, branch),
    }
  })
  return {
    graph_revision: graphRevision,
    plan: planResult.plan,
    schema: 're.project-concurrency@0.1.0',
    tasks,
  }
}

function concurrencyTaskId(graphRevision, scopePath, branch) {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    branch,
    graph_revision: graphRevision,
    scope_path: scopePath,
  })).digest('hex')}`
}

function revision(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
