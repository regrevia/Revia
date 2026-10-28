import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { lowerConcurrency } from '../src/toolchain/concurrency-contract.js'
import {
  executeProjectConcurrency,
  verifyProjectConcurrencyAudit,
} from '../src/toolchain/project-runtime.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`
const uid = 'aaaaaaaaaaaaaaaaaaaaaaaaae'

function planFor(branches) {
  const result = lowerConcurrency({
    kind: 'par',
    region: {
      branches: branches.map((id) => ({
        effects: [{
          after: [], cancellation: 'cooperative', footprint: [{
            handle: null, mode: 'read',
            resource: {
              domain_digest: digest('a'),
              segments: [{
                canonical_hex: Buffer.from(id).toString('hex'),
                type_digest: digest('b'),
              }],
            },
          }],
          id: 'run', operation_digest: digest('c'),
        }],
        id, output_type: 'unit',
      })),
      cancel_reason_type: { arguments: [], declaration_digest: digest('d'), kind: 'declared' },
      deadline: null, handles: [], id: 'runtime',
      join_type: { arguments: [], declaration_digest: digest('e'), kind: 'declared' },
      task_outcome_digest: digest('f'),
    },
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(result.ok, true)
  return result.plan
}

function nestedPlan() {
  const region = (id, branches) => ({
    branches,
    cancel_reason_type: { arguments: [], declaration_digest: digest('d'), kind: 'declared' },
    deadline: null,
    handles: [],
    id,
    join_type: { arguments: [], declaration_digest: digest('e'), kind: 'declared' },
    task_outcome_digest: digest('f'),
  })
  const result = lowerConcurrency({
    kind: 'par',
    region: region('fetch', [
      { effects: [], id: 'orders', output_type: 'unit' },
      {
        effects: [],
        id: 'users',
        nested_regions: [region('profile', [
          { effects: [{ after: [], cancellation: 'cooperative', footprint: [{
            handle: null, mode: 'read',
            resource: { domain_digest: digest('a'), segments: [{
              canonical_hex: 'aa', type_digest: digest('b'),
            }] },
          }], id: 'load', operation_digest: digest('c') }], id: 'cache', output_type: 'unit' },
          { effects: [{ after: [], cancellation: 'cooperative', footprint: [{
            handle: null, mode: 'read',
            resource: { domain_digest: digest('a'), segments: [{
              canonical_hex: 'bb', type_digest: digest('b'),
            }] },
          }], id: 'load', operation_digest: digest('c') }], id: 'remote', output_type: 'unit' },
        ])],
        output_type: 'unit',
      },
    ]),
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(result.ok, true)
  return result.plan
}

function project(plan, branches, revision = digest('a')) {
  return {
    graph_revision: revision,
    plan,
    schema: 're.project-concurrency@0.1.0',
    tasks: branches.map((branch) => ({
      branch,
      graph_revision: revision,
      mutable_aliases: [],
      resources: [{ alias: `resource_${branch}`, key: `resource_${branch}`, mode: 'read' }],
      scope_path: ['runtime'],
      task_id: digest('x'),
    })).map((task) => ({
      ...task,
      task_id: `sha256:${requireTaskDigest(task.graph_revision, task.scope_path, task.branch)}`,
    })),
  }
}

function tasksForPlan(plan, revision = digest('a')) {
  return plan.nodes
    .filter((node) => node?.kind === 'task-scope')
    .map((node) => {
      const match = node.id.match(/^par\.(.+)\.branch\.([a-z][a-z0-9_.-]*)$/u)
      const regionKey = `par.${match[1]}`
      const parts = regionKey.split('.')
      const scopePath = [parts[1]]
      for (let index = 2; index < parts.length; index += 4) {
        scopePath.push(parts[index + 1], parts[index + 3])
      }
      const branch = match[2]
      const taskId = createHash('sha256')
        .update(`{"branch":${JSON.stringify(branch)},"graph_revision":${JSON.stringify(revision)},"scope_path":[${scopePath.map((value) => JSON.stringify(value)).join(',')}]}`)
        .digest('hex')
      return {
        branch,
        graph_revision: revision,
        mutable_aliases: [],
        resources: [{
          alias: `${scopePath.join('_')}_${branch}`,
          key: `${scopePath.join('_')}_${branch}`,
          mode: 'read',
        }],
        scope_path: scopePath,
        task_id: `sha256:${taskId}`,
      }
    })
}

function requireTaskDigest(revision, scopePath, branch) {
  return createHash('sha256')
    .update(`{"branch":${JSON.stringify(branch)},"graph_revision":${JSON.stringify(revision)},"scope_path":[${scopePath.map((value) => JSON.stringify(value)).join(',')}]}`)
    .digest('hex')
}

test('project runtime binds task identity and emits replayable audit', async () => {
  const plan = planFor(['alpha', 'beta'])
  const result = await executeProjectConcurrency(project(plan, ['alpha', 'beta'], digest('a')), {
    branches: new Map([
      ['alpha', async ({ runEffect }) => runEffect('run', async () => 'a')],
      ['beta', async ({ runEffect }) => runEffect('run', async () => 'b')],
    ]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.project_audit.schema, 're.project-concurrency-audit@0.1.0')
  assert.equal(result.verification.ok, true)
  assert.deepEqual(
    result.project_audit.trace.events.filter((event) => event.branch === 'alpha')[0],
    {
      branch: 'alpha',
      kind: 'branch-spawn',
      ordinal: 0,
      graph_revision: digest('a'),
      scope_path: ['runtime'],
      task_id: result.project_audit.scheduler.regions[0].tasks[0],
    },
  )
  assert.equal(verifyProjectConcurrencyAudit(project(plan, ['alpha', 'beta'], digest('a')), result.project_audit).ok, true)
})

test('project runtime rejects stale, detached, and missing task identities before runners', async () => {
  const plan = planFor(['alpha', 'beta'])
  const base = project(plan, ['alpha', 'beta'])
  let calls = 0
  for (const mutate of [
    (value) => ({ ...value, graph_revision: digest('s') }),
    (value) => ({ ...value, tasks: [{ ...value.tasks[0], branch: 'detached' }] }),
    (value) => ({ ...value, tasks: [] }),
  ]) {
    const result = await executeProjectConcurrency(mutate(base), {
      branches: new Map(['alpha', 'beta'].map((branch) => [
        branch, async () => { calls += 1 },
      ])),
    })
    assert.equal(result.ok, false)
  }
  assert.equal(calls, 0)
})

test('project runtime rejects write conflicts and mutable aliases before runners', async () => {
  const plan = planFor(['alpha', 'beta'])
  const base = project(plan, ['alpha', 'beta'])
  const conflict = {
    ...base,
    tasks: base.tasks.map((task) => ({
      ...task,
      resources: [{ alias: 'shared', key: 'db', mode: 'write' }],
    })),
  }
  let calls = 0
  const result = await executeProjectConcurrency(conflict, {
    branches: new Map(['alpha', 'beta'].map((branch) => [
      branch, async () => { calls += 1 },
    ])),
  })
  assert.equal(result.diagnostics[0].code, 'project-resource-conflict')
  assert.equal(calls, 0)
  const aliases = {
    ...base,
    tasks: base.tasks.map((task) => ({
      ...task,
      mutable_aliases: ['shared'],
    })),
  }
  const aliasResult = await executeProjectConcurrency(aliases, {
    branches: new Map(['alpha', 'beta'].map((branch) => [branch, async () => {}])),
  })
  assert.equal(aliasResult.diagnostics[0].code, 'mutable-resource-alias-conflict')
})

test('project scheduler remains deterministic for 10000 tasks and replay', async () => {
  const branches = Array.from({ length: 10000 }, (_, index) => `task${index}`)
  const plan = planFor(branches)
  const value = project(plan, branches)
  value.tasks = value.tasks.map((task) => ({
    ...task,
    resources: [{ alias: task.branch, key: task.branch, mode: 'read' }],
  }))
  const runners = new Map(branches.map((branch) => [
    branch, async ({ runEffect }) => runEffect('run', async () => branch),
  ]))
  const first = await executeProjectConcurrency(value, {
    branches: runners,
    maxConcurrentBranches: 7,
  })
  const second = await executeProjectConcurrency(value, {
    branches: runners,
    maxConcurrentBranches: 7,
  })
  assert.equal(first.ok, true)
  assert.deepEqual(first.project_audit, second.project_audit)
  assert.equal(first.project_audit.scheduler.regions[0].tasks.length, 10000)
})

test('project audit binds nested task scopes and host-fault cleanup', async () => {
  const plan = nestedPlan()
  const revision = digest('b')
  const projectValue = {
    graph_revision: revision,
    plan,
    schema: 're.project-concurrency@0.1.0',
    tasks: tasksForPlan(plan, revision),
  }
  const result = await executeProjectConcurrency(projectValue, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async ({ runEffect }) => runEffect('load', async () => 'cache')],
        ['remote', async ({ runEffect }) => runEffect('load', async () => {
          throw new Error('host fault')
        })],
      ]))],
    ]),
  })
  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'host-fault')
  assert.equal(result.verification.ok, true)
  assert.ok(result.project_audit.trace.events.some((event) => (
    event.task_id !== undefined
    && event.scope_path.join('/') === 'fetch/users/profile'
    && event.branch === 'remote'
  )))
  assert.equal(verifyProjectConcurrencyAudit(projectValue, result.project_audit).ok, true)
})
