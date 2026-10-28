import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  lowerConcurrency,
  verifyConcurrencyTrace,
} from '../src/toolchain/concurrency-contract.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/concurrency-corpus.json', import.meta.url),
  'utf8',
))
const schema = 're.concurrency-contract@0.1.0'
const fileDomain = `sha256:${'a'.repeat(64)}`
const dbDomain = `sha256:${'b'.repeat(64)}`
const cancelReasonDigest = `sha256:${'e'.repeat(64)}`
const graphRevision = `sha256:${'9'.repeat(64)}`
const joinDigest = `sha256:${'f'.repeat(64)}`
const taskOutcomeDigest = `sha256:${'1'.repeat(64)}`
const usersBranchUid = `baaaaaa${'a'.repeat(19)}`
const ordersBranchUid = `caaaaaa${'a'.repeat(19)}`

test('every P0-06 concurrency attack executes through one lowering interface', () => {
  assert.equal(corpus.schema, 're.concurrency-corpus@0.1.0')
  assert.equal(corpus.status, 'executable-contract')
  for (const entry of corpus.cases) {
    const result = lowerConcurrency(contractFor(entry.shape))
    if (entry.expected === 'accept-par') {
      assert.equal(result.ok, true, entry.id)
      assert.equal(result.plan.construct, 'par', entry.id)
      assert.equal(result.plan.schema, 're.concurrency-plan@0.1.0', entry.id)
    } else {
      assert.equal(result.ok, false, entry.id)
      assert.equal(result.diagnostics[0].code, entry.expected.slice(7), entry.id)
    }
  }
})

test('par lowering is permutation-stable and join order follows branch identity', () => {
  const first = baseContract()
  first.region.branches[0].effects.push(effect({
    after: ['load'],
    id: 'decode',
    mode: 'read',
    path: ['tenant-a', 'input'],
  }))
  const second = structuredClone(first)
  second.region.branches.reverse()
  second.region.branches[1].effects.reverse()
  second.region.branches[1].effects[1].footprint.reverse()
  assert.deepEqual(lowerConcurrency(second), lowerConcurrency(first))

  const plan = lowerConcurrency(first).plan
  const join = plan.nodes.find(({ kind }) => kind === 'join')
  assert.deepEqual(join.members, ['orders', 'users'])
  assert.deepEqual(join.member_types.map(({ branch }) => branch), ['orders', 'users'])
  assert.equal(join.output_type.declaration_digest, joinDigest)
  assert.equal(plan.edges.filter(({ kind }) => kind === 'spawn').length, 2)
  assert.equal(plan.edges.filter(({ kind }) => kind === 'join').length, 2)
})

test('branch result errors are collected as values and never select a racing winner', () => {
  const input = baseContract()
  input.region.branches[0].output_type = {
    kind: 'result',
    error: 'users.error',
    ok: 'users.record',
  }
  const plan = lowerConcurrency(input).plan
  const join = plan.nodes.find(({ kind }) => kind === 'join')
  const users = join.member_types.find(({ branch }) => branch === 'users')
  assert.deepEqual(users.type, {
    arguments: [
      { error: 'users.error', kind: 'result', ok: 'users.record' },
      declaredType(cancelReasonDigest),
    ],
    declaration_digest: taskOutcomeDigest,
    kind: 'declared',
  })
  const region = plan.nodes.find(({ kind }) => kind === 'par-region')
  assert.equal(region.policy.branch_error, 'collect-as-value')
  assert.equal(region.policy.host_fault, 'cancel-siblings-join-cleanup-propagate')
})

test('deadline is an absolute monotonic input and cancellation policy is fixed', () => {
  const input = baseContract()
  input.region.deadline = {
    endpoint: 'request.deadline',
    type: 'time.monotonic_instant',
  }
  const plan = lowerConcurrency(input).plan
  const region = plan.nodes.find(({ kind }) => kind === 'par-region')
  assert.deepEqual(region.deadline, input.region.deadline)
  assert.equal(region.policy.cancel_propagation, 'downward')
  assert.equal(region.policy.detach, false)
  assert.equal(region.policy.retry, 'explicit-loop-only')

  input.region.deadline.type = 'time.duration'
  assert.equal(lowerConcurrency(input).diagnostics[0].code, 'invalid-par-deadline-type')

  const finish = baseContract()
  finish.region.branches[0].effects[0].cancellation = 'complete-before-join'
  assert.equal(lowerConcurrency(finish).ok, true)
  finish.region.branches[0].effects[0].cancellation = 'detach-on-cancel'
  assert.equal(
    lowerConcurrency(finish).diagnostics[0].code,
    'invalid-effect-cancellation-mode',
  )
})

test('resource overlap is typed, hierarchical, symmetric, and conservative', () => {
  assert.equal(lowerConcurrency(resourcePair({
    left: { mode: 'read', path: ['tenant-a'] },
    right: { mode: 'read', path: ['tenant-a', 'row-1'] },
  })).ok, true)
  assert.equal(lowerConcurrency(resourcePair({
    left: { mode: 'write', path: ['tenant-a'] },
    right: { mode: 'read', path: ['tenant-a', 'row-1'] },
  })).diagnostics[0].code, 'parallel-resource-conflict')
  assert.equal(lowerConcurrency(resourcePair({
    left: { mode: 'read', path: ['tenant-a', 'row-1'] },
    right: { mode: 'write', path: ['tenant-a'] },
  })).diagnostics[0].code, 'parallel-resource-conflict')
  assert.equal(lowerConcurrency(resourcePair({
    left: { mode: 'write', path: ['tenant-a'] },
    right: { domain: dbDomain, mode: 'write', path: ['tenant-a'] },
  })).ok, true)
  const typed = resourcePair({
    left: { mode: 'write', path: ['1'] },
    right: { mode: 'write', path: ['1'] },
  })
  typed.region.branches[1].effects[0].footprint[0]
    .resource.segments[0].type_digest = `sha256:${'e'.repeat(64)}`
  assert.equal(lowerConcurrency(typed).ok, true)
})

test('schema resource footprints are directly consumable by the overlap contract', () => {
  const definition = {
    identity: 'resource.demo',
    revision: '0.1.0',
    resource_catalog: {
      'demo.file': {
        domain_digest: fileDomain,
        segments: [{
          parameter: 'path',
          type_digest: `sha256:${'d'.repeat(64)}`,
        }],
      },
    },
    types: {},
    members: {
      read_file: {
        access: ['read demo.file(path)'],
        params: [{ name: 'path', type: 'fs.path' }],
        returns: 'unit',
      },
    },
  }
  const registry = SchemaRegistry.load([definition]).value
  const left = registry.resourceFootprint(
    'resource.demo@0.1.0',
    'read_file',
    { path: 'tenant-a' },
  ).value[0]
  const right = registry.resourceFootprint(
    'resource.demo@0.1.0',
    'read_file',
    { path: 'tenant-a/row-1' },
  ).value[0]
  const input = resourcePair({
    left: { mode: left.mode, path: null },
    right: { mode: right.mode, path: null },
  })
  input.region.branches[0].effects[0].footprint = [left]
  input.region.branches[1].effects[0].footprint = [right]
  assert.equal(lowerConcurrency(input).ok, true)
})

test('effect order is explicit, total within one branch, and cannot cross branches', () => {
  const valid = baseContract()
  valid.region.branches[0].effects.push(effect({
    after: ['load'], id: 'decode', mode: 'read', path: ['tenant-a', 'input'],
  }))
  assert.equal(lowerConcurrency(valid).ok, true)

  const cycle = structuredClone(valid)
  cycle.region.branches[0].effects[0].after = ['decode']
  assert.equal(lowerConcurrency(cycle).diagnostics[0].code, 'effect-order-cycle')

  const crossBranch = baseContract()
  crossBranch.region.branches[0].effects[0].after = ['query']
  assert.equal(
    lowerConcurrency(crossBranch).diagnostics[0].code,
    'cross-branch-or-unknown-effect-order',
  )
})

test('match control paths must be projected before par co-executable analysis', () => {
  const projected = baseContract()
  projected.region.branches[0].control_path = ['result', 'ok']
  const plan = lowerConcurrency(projected).plan
  const users = plan.nodes.find(({ id }) => id === 'par.fetch.branch.users')
  assert.deepEqual(users.control_path, ['result', 'ok'])

  const unprojected = baseContract()
  unprojected.region.branches[0].effects.push(effect({
    id: 'fallback', mode: 'write', path: ['tenant-a', 'fallback'],
  }))
  unprojected.region.branches[0].effects[0].control_path = ['result', 'ok']
  unprojected.region.branches[0].effects[1].control_path = ['result', 'err']
  assert.equal(
    lowerConcurrency(unprojected).diagnostics[0].code,
    'unprojected-match-effect-path',
  )
})

test('par branch identity binds plan branches to canonical UID anchors', () => {
  const anchored = baseContract()
  anchored.region.branches[0].identity = {
    graph_revision: graphRevision,
    uid: usersBranchUid,
  }
  anchored.region.branches[1].identity = {
    graph_revision: graphRevision,
    uid: ordersBranchUid,
  }
  const plan = lowerConcurrency(anchored).plan
  const users = plan.nodes.find(({ id }) => id === 'par.fetch.branch.users')
  const orders = plan.nodes.find(({ id }) => id === 'par.fetch.branch.orders')
  assert.deepEqual(users.identity, {
    graph_revision: graphRevision,
    uid: usersBranchUid,
  })
  assert.deepEqual(orders.identity, {
    graph_revision: graphRevision,
    uid: ordersBranchUid,
  })

  const partial = structuredClone(anchored)
  delete partial.region.branches[1].identity
  assert.equal(lowerConcurrency(partial).diagnostics[0].code, 'missing-par-branch-identity')

  const duplicate = structuredClone(anchored)
  duplicate.region.branches[1].identity.uid = usersBranchUid
  assert.equal(lowerConcurrency(duplicate).diagnostics[0].code, 'duplicate-par-branch-identity')

  const drifted = structuredClone(anchored)
  drifted.region.branches[1].identity.graph_revision = `sha256:${'8'.repeat(64)}`
  assert.equal(
    lowerConcurrency(drifted).diagnostics[0].code,
    'par-branch-identity-revision-mismatch',
  )
})

test('resource handles cannot escape a child scope or bypass declared users', () => {
  const parent = baseContract()
  parent.region.handles.push({
    closed_by: null,
    escapes: false,
    id: 'store',
    owner: 'parent',
    used_by: ['orders', 'users'],
  })
  for (const branch of parent.region.branches) {
    branch.effects[0].footprint[0].handle = 'store'
  }
  assert.equal(lowerConcurrency(parent).ok, true)

  const child = baseContract()
  child.region.handles.push({
    closed_by: 'users',
    escapes: false,
    id: 'cursor',
    owner: 'users',
    used_by: ['users'],
  })
  child.region.branches[0].effects[0].footprint[0].handle = 'cursor'
  assert.equal(lowerConcurrency(child).ok, true)
  child.region.handles[0].closed_by = null
  assert.equal(
    lowerConcurrency(child).diagnostics[0].code,
    'child-resource-lifetime-violation',
  )
})

test('trace conformance makes cancellation downward and scope exit explicit', () => {
  const plan = lowerConcurrency(baseContract()).plan
  const accepted = verifyConcurrencyTrace(plan, trace([
    spawn('users'),
    spawn('orders'),
    { kind: 'branch-complete', branch: 'users' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'joined' },
  ]))
  assert.deepEqual(accepted, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['deadline'],
      host_fault_branches: [],
      outcome: 'joined',
      region_id: 'fetch',
    },
  })

  const notDownward = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'region-cancel', reason: 'parent' },
    { kind: 'branch-complete', branch: 'orders' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'parent' },
    { kind: 'region-exit', outcome: 'joined' },
  ]))
  assert.equal(notDownward.diagnostics[0].code, 'branch-completed-after-cancel')

  const orphan = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-complete', branch: 'orders' },
    { kind: 'region-exit', outcome: 'joined' },
  ]))
  assert.equal(orphan.diagnostics[0].code, 'region-exit-before-children-settle')

  const lateCancel = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-complete', branch: 'orders' },
    { kind: 'branch-complete', branch: 'users' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'joined' },
  ]))
  assert.equal(lateCancel.diagnostics[0].code, 'cancel-after-children-settle')

  const allCancelled = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.deepEqual(allCancelled, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['deadline'],
      host_fault_branches: [],
      outcome: 'cancelled',
      region_id: 'fetch',
    },
  })

  const hiddenAllCancel = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'joined' },
  ]))
  assert.equal(hiddenAllCancel.diagnostics[0].code, 'region-exit-outcome-mismatch')

  const driftedPlan = structuredClone(plan)
  driftedPlan.nodes.find(({ kind }) => kind === 'join').members.pop()
  assert.equal(
    verifyConcurrencyTrace(driftedPlan, trace([])).diagnostics[0].code,
    'concurrency-plan-join-membership-mismatch',
  )
})

test('host fault cancels siblings, joins cleanup, and remains outside program values', () => {
  const plan = lowerConcurrency(baseContract()).plan
  const result = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-host-fault', branch: 'orders', fault_ref: 'fault.orders' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'host-fault' },
    { kind: 'region-exit', outcome: 'host-fault' },
  ]))
  assert.deepEqual(result, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['host-fault'],
      host_fault_branches: ['orders'],
      outcome: 'host-fault',
      region_id: 'fetch',
    },
  })

  const afterDeadline = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-host-fault', branch: 'orders', fault_ref: 'fault.orders' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'host-fault' },
  ]))
  assert.deepEqual(afterDeadline, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['deadline'],
      host_fault_branches: ['orders'],
      outcome: 'host-fault',
      region_id: 'fetch',
    },
  })
})

test('complete-before-join cancellation requires effect progress and latency evidence', () => {
  const input = baseContract()
  input.region.branches[0].effects[0].cancellation = 'complete-before-join'
  const plan = lowerConcurrency(input).plan

  const accepted = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'effect-start', branch: 'users', effect: 'load' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'effect-complete', branch: 'users', effect: 'load', cancel_latency_ms: 17 },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.deepEqual(accepted, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [
        { branch: 'users', cancel_latency_ms: 17, effect: 'load' },
      ],
      cancel_reasons: ['deadline'],
      host_fault_branches: [],
      outcome: 'cancelled',
      region_id: 'fetch',
    },
  })

  const hiddenInFlight = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'effect-start', branch: 'users', effect: 'load' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.equal(hiddenInFlight.diagnostics[0].code, 'complete-before-join-effect-not-settled')

  const notStartedCancelled = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.deepEqual(notStartedCancelled, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['deadline'],
      host_fault_branches: [],
      outcome: 'cancelled',
      region_id: 'fetch',
    },
  })

  const missingLatency = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'effect-start', branch: 'users', effect: 'load' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'effect-complete', branch: 'users', effect: 'load', cancel_latency_ms: null },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.equal(missingLatency.diagnostics[0].code, 'invalid-complete-before-join-cancel-latency')
})

test('nested par traces compose parent cancellation through explicit scope paths', () => {
  const plan = lowerConcurrency(nestedContract()).plan
  const accepted = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'cache' },
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'remote' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'region-cancel', scope_path: ['fetch', 'users', 'profile'], reason: 'parent' },
    {
      kind: 'branch-cancelled', scope_path: ['fetch', 'users', 'profile'], branch: 'cache', reason: 'parent',
    },
    {
      kind: 'branch-cancelled', scope_path: ['fetch', 'users', 'profile'], branch: 'remote', reason: 'parent',
    },
    { kind: 'region-exit', scope_path: ['fetch', 'users', 'profile'], outcome: 'cancelled' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'deadline' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.deepEqual(accepted, {
    ok: true,
    summary: {
      branch_count: 2,
      complete_before_join_effects: [],
      cancel_reasons: ['deadline'],
      host_fault_branches: [],
      nested_regions: [{
        branch_count: 2,
        cancel_reasons: ['parent'],
        outcome: 'cancelled',
        region_id: 'profile',
        scope_path: ['fetch', 'users', 'profile'],
      }],
      outcome: 'cancelled',
      region_id: 'fetch',
    },
  })

  const parentCancelAccepted = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'cache' },
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'remote' },
    { kind: 'region-cancel', reason: 'parent' },
    { kind: 'region-cancel', scope_path: ['fetch', 'users', 'profile'], reason: 'parent' },
    {
      kind: 'branch-cancelled', scope_path: ['fetch', 'users', 'profile'], branch: 'cache', reason: 'parent',
    },
    {
      kind: 'branch-cancelled', scope_path: ['fetch', 'users', 'profile'], branch: 'remote', reason: 'parent',
    },
    { kind: 'region-exit', scope_path: ['fetch', 'users', 'profile'], outcome: 'cancelled' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'parent' },
    { kind: 'branch-cancelled', branch: 'orders', reason: 'parent' },
    { kind: 'region-exit', outcome: 'cancelled' },
  ]))
  assert.equal(parentCancelAccepted.ok, true)
  assert.deepEqual(parentCancelAccepted.summary.cancel_reasons, ['parent'])

  const missingChildCancel = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'cache' },
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'remote' },
    { kind: 'region-cancel', reason: 'deadline' },
    {
      kind: 'branch-cancelled', scope_path: ['fetch', 'users', 'profile'], branch: 'cache', reason: 'parent',
    },
  ]))
  assert.equal(missingChildCancel.diagnostics[0].code, 'nested-region-missing-parent-cancel')
  assert.deepEqual(missingChildCancel.diagnostics[0].scope_path, ['fetch', 'users', 'profile'])
  assert.equal(missingChildCancel.diagnostics[0].region_id, 'profile')
  assert.equal(missingChildCancel.diagnostics[0].ordinal, 5)

  const forgedParentCancel = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'cache' },
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'remote' },
    { kind: 'region-cancel', scope_path: ['fetch', 'users', 'profile'], reason: 'parent' },
  ]))
  assert.equal(
    forgedParentCancel.diagnostics[0].code,
    'nested-region-parent-cancel-without-ancestor',
  )
  assert.deepEqual(forgedParentCancel.diagnostics[0].scope_path, ['fetch', 'users', 'profile'])
  assert.equal(forgedParentCancel.diagnostics[0].region_id, 'profile')
  assert.equal(forgedParentCancel.diagnostics[0].ordinal, 4)

  const parentBeforeChildExit = verifyConcurrencyTrace(plan, trace([
    spawn('orders'),
    spawn('users'),
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'cache' },
    { kind: 'branch-spawn', scope_path: ['fetch', 'users', 'profile'], branch: 'remote' },
    { kind: 'region-cancel', reason: 'deadline' },
    { kind: 'region-cancel', scope_path: ['fetch', 'users', 'profile'], reason: 'parent' },
    { kind: 'branch-cancelled', branch: 'users', reason: 'deadline' },
  ]))
  assert.equal(parentBeforeChildExit.diagnostics[0].code, 'branch-terminal-before-nested-region-exit')
  assert.deepEqual(parentBeforeChildExit.diagnostics[0].scope_path, ['fetch'])
  assert.equal(parentBeforeChildExit.diagnostics[0].ordinal, 6)
})

test('ten thousand branches lower without an orphan or implicit queue', () => {
  const input = {
    kind: 'par',
    region: {
      branches: Array.from({ length: 10_000 }, (_, index) => ({
        effects: [],
        id: `branch-${String(index).padStart(5, '0')}`,
        output_type: 'unit',
      })),
      cancel_reason_type: declaredType(cancelReasonDigest),
      deadline: null,
      handles: [],
      id: 'fanout',
      join_type: declaredType(joinDigest),
      task_outcome_digest: taskOutcomeDigest,
    },
    schema,
  }
  const result = lowerConcurrency(input)
  assert.equal(result.ok, true)
  assert.equal(result.plan.nodes.filter(({ kind }) => kind === 'task-scope').length, 10_000)
  assert.equal(result.plan.edges.filter(({ kind }) => kind === 'join').length, 10_000)
  assert.equal(result.plan.nodes.some(({ kind }) => kind === 'queue'), false)
  const events = []
  for (const branch of input.region.branches) events.push(spawn(branch.id))
  for (const branch of input.region.branches) {
    events.push({ branch: branch.id, kind: 'branch-complete' })
  }
  events.push({ kind: 'region-exit', outcome: 'joined' })
  const verified = verifyConcurrencyTrace(result.plan, trace(events, 'fanout'))
  assert.equal(verified.ok, true)
  assert.equal(verified.summary.branch_count, 10_000)
})

test('representative par plan has a fixed digest and malformed input fails closed', () => {
  const result = lowerConcurrency(baseContract())
  const digest = createHash('sha256').update(JSON.stringify(result.plan)).digest('hex')
  assert.equal(digest, '58d44cb5c8c1ef590d4131214ecfba290063cc74923ab1515e3ee6f630901293')

  const cyclic = baseContract()
  cyclic.region.branches[0].output_type = cyclic
  for (const input of [null, [], { schema }, cyclic]) {
    const rejected = lowerConcurrency(input)
    assert.equal(rejected.ok, false)
    assert.match(rejected.diagnostics[0].code, /^[a-z][a-z0-9-]*$/u)
    assert.equal(Object.hasOwn(rejected.diagnostics[0], 'stack'), false)
  }
})

function contractFor(shape) {
  if (shape === 'disjoint-write') return baseContract()
  if (shape === 'same-resource-read-read') {
    return resourcePair({
      left: { mode: 'read', path: ['shared'] },
      right: { mode: 'read', path: ['shared'] },
    })
  }
  if (shape === 'same-resource-read-write') {
    return resourcePair({
      left: { mode: 'read', path: ['shared'] },
      right: { mode: 'write', path: ['shared'] },
    })
  }
  if (shape === 'parent-child-write') {
    return resourcePair({
      left: { mode: 'write', path: ['shared'] },
      right: { mode: 'read', path: ['shared', 'child'] },
    })
  }
  if (shape === 'unknown-key-write') {
    return resourcePair({
      left: { mode: 'write', path: null },
      right: { mode: 'read', path: ['shared'] },
    })
  }
  if (shape === 'unordered-branch-effects') {
    const input = baseContract()
    input.region.branches[0].effects.push(effect({
      id: 'decode', mode: 'read', path: ['tenant-a', 'input'],
    }))
    return input
  }
  if (shape === 'detached-task') {
    const input = baseContract()
    input.region.detached = true
    return input
  }
  if (shape === 'relative-timeout') {
    const input = baseContract()
    input.region.timeout_ms = 1000
    return input
  }
  if (shape === 'child-handle-escape') {
    const input = baseContract()
    input.region.handles.push({
      closed_by: 'users',
      escapes: true,
      id: 'cursor',
      owner: 'users',
      used_by: [],
    })
    return input
  }
  if (shape === 'program-error-value') {
    const input = baseContract()
    input.region.branches[0].output_type = {
      error: 'users.error', kind: 'result', ok: 'users.record',
    }
    return input
  }
  if (shape === 'projected-control-path') {
    const input = baseContract()
    input.region.branches[0].control_path = ['result', 'ok']
    return input
  }
  if (shape === 'unprojected-match-effect-path') {
    const input = baseContract()
    input.region.branches[0].effects[0].control_path = ['result', 'ok']
    return input
  }
  if (shape === 'branch-uid-anchors') {
    const input = baseContract()
    input.region.branches[0].identity = {
      graph_revision: graphRevision,
      uid: usersBranchUid,
    }
    input.region.branches[1].identity = {
      graph_revision: graphRevision,
      uid: ordersBranchUid,
    }
    return input
  }
  if (shape === 'duplicate-branch-uid-anchor') {
    const input = contractFor('branch-uid-anchors')
    input.region.branches[1].identity.uid = usersBranchUid
    return input
  }
  throw new Error(`unknown concurrency shape: ${shape}`)
}

function baseContract() {
  return {
    kind: 'par',
    region: {
      branches: [
        {
          effects: [effect({ id: 'load', mode: 'read', path: ['tenant-a', 'user'] })],
          id: 'users',
          output_type: 'users.record',
        },
        {
          effects: [effect({
            domain: dbDomain, id: 'query', mode: 'read', path: ['tenant-a', 'orders'],
          })],
          id: 'orders',
          output_type: 'orders.list',
        },
      ],
      cancel_reason_type: declaredType(cancelReasonDigest),
      deadline: null,
      handles: [],
      id: 'fetch',
      join_type: declaredType(joinDigest),
      task_outcome_digest: taskOutcomeDigest,
    },
    schema,
  }
}

function resourcePair({ left, right }) {
  const input = baseContract()
  input.region.branches[0].effects = [effect({ id: 'left', ...left })]
  input.region.branches[1].effects = [effect({ id: 'right', ...right })]
  return input
}

function nestedContract() {
  const input = baseContract()
  input.region.branches[0].nested_regions = [{
    branches: [
      {
        effects: [effect({ id: 'load-cache', mode: 'read', path: ['tenant-a', 'cache'] })],
        id: 'cache',
        output_type: 'cache.record',
      },
      {
        effects: [effect({
          domain: dbDomain, id: 'load-remote', mode: 'read', path: ['tenant-a', 'remote'],
        })],
        id: 'remote',
        output_type: 'remote.record',
      },
    ],
    cancel_reason_type: declaredType(cancelReasonDigest),
    deadline: null,
    handles: [],
    id: 'profile',
    join_type: declaredType(joinDigest),
    task_outcome_digest: taskOutcomeDigest,
  }]
  return input
}

function effect({ after = [], domain = fileDomain, id, mode, path }) {
  return {
    after,
    cancellation: 'cooperative',
    footprint: [{
      handle: null,
      mode,
      resource: {
        domain_digest: domain,
        segments: path === null ? null : path.map(resourceSegment),
      },
    }],
    id,
    operation_digest: `sha256:${'c'.repeat(64)}`,
  }
}

function resourceSegment(value) {
  return {
    canonical_hex: Buffer.from(value, 'utf8').toString('hex'),
    type_digest: `sha256:${'d'.repeat(64)}`,
  }
}

function declaredType(declarationDigest) {
  return { arguments: [], declaration_digest: declarationDigest, kind: 'declared' }
}

function spawn(branch) {
  return { branch, kind: 'branch-spawn' }
}

function trace(events, regionId = 'fetch') {
  return {
    events: events.map((event, ordinal) => ({ ...event, ordinal })),
    region_id: regionId,
    schema: 're.concurrency-trace@0.1.0',
  }
}
