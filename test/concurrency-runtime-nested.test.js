import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { lowerConcurrency } from '../src/toolchain/concurrency-contract.js'
import { executeConcurrencyPlan } from '../src/toolchain/concurrency-runtime.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`

function effect(id, cancellation = 'cooperative') {
  return {
    after: [],
    cancellation,
    footprint: [{
      handle: null,
      mode: 'read',
      resource: {
        domain_digest: digest('a'),
        segments: [{
          canonical_hex: Buffer.from(id).toString('hex'),
          type_digest: digest('b'),
        }],
      },
    }],
    id,
    operation_digest: digest('c'),
  }
}

function region(id, branches) {
  return {
    branches,
    cancel_reason_type: {
      arguments: [],
      declaration_digest: digest('d'),
      kind: 'declared',
    },
    deadline: null,
    handles: [],
    id,
    join_type: {
      arguments: [],
      declaration_digest: digest('e'),
      kind: 'declared',
    },
    task_outcome_digest: digest('f'),
  }
}

function nestedPlan({
  childBranches = [
    { effects: [effect('load-cache')], id: 'cache', output_type: 'unit' },
    { effects: [effect('load-remote')], id: 'remote', output_type: 'unit' },
  ],
} = {}) {
  const result = lowerConcurrency({
    kind: 'par',
    region: region('fetch', [
      {
        effects: [],
        id: 'orders',
        output_type: 'unit',
      },
      {
        effects: [],
        id: 'users',
        nested_regions: [region('profile', childBranches)],
        output_type: 'unit',
      },
    ]),
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(result.ok, true)
  return result.plan
}

function nestedEvents(result) {
  return result.trace.events.filter(({ scope_path: scopePath }) => (
    Array.isArray(scopePath) && scopePath.join('/') === 'fetch/users/profile'
  ))
}

test('nested runner map get override cannot replace validated authority', async () => {
  const plan = nestedPlan()
  let legitimateCalls = 0
  let spoofCalls = 0
  const childRunners = new Map([
    ['cache', async ({ runEffect }) => {
      legitimateCalls += 1
      await runEffect('load-cache', async () => 'cache')
      return 'cache'
    }],
    ['remote', async ({ runEffect }) => {
      legitimateCalls += 1
      await runEffect('load-remote', async () => 'remote')
      return 'remote'
    }],
  ])
  childRunners.get = () => {
    spoofCalls += 1
    return async ({ branch, runEffect }) => {
      await runEffect(branch === 'cache' ? 'load-cache' : 'load-remote', async () => 'spoof')
      return 'spoof'
    }
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', childRunners)],
    ]),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.branches.users.branches, {
    cache: 'cache',
    remote: 'remote',
  })
  assert.equal(legitimateCalls, 2)
  assert.equal(spoofCalls, 0)
})

test('nested runtime joins child outcomes before the parent branch completes', async () => {
  const plan = nestedPlan()
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async ({ runEffect }) => runEffect('load-cache', async () => 'cache')],
        ['remote', async ({ runEffect }) => runEffect('load-remote', async () => 'remote')],
      ]))],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'joined')
  assert.deepEqual(result.branches.users.branches, {
    cache: 'cache',
    remote: 'remote',
  })
  assert.equal(result.verification.ok, true)
  const childExit = result.trace.events.findIndex((event) => (
    event.kind === 'region-exit' && event.scope_path?.at(-1) === 'profile'
  ))
  const parentTerminal = result.trace.events.findIndex((event) => (
    event.kind === 'branch-complete' && event.branch === 'users'
  ))
  assert.ok(childExit >= 0)
  assert.ok(parentTerminal > childExit)
})

test('throwing nested effect start clock fails closed before child operations start', async () => {
  const plan = nestedPlan()
  let operationCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async ({ runEffect }) => runEffect('load-cache', async () => {
          operationCalls += 1
        })],
        ['remote', async ({ runEffect }) => runEffect('load-remote', async () => {
          operationCalls += 1
        })],
      ]))],
    ]),
    now: () => {
      throw new Error('private nested effect clock failure')
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(operationCalls, 0)
})

test('invalid nested effect clock reading fails closed before child operations start', async () => {
  const plan = nestedPlan()
  let operationCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async ({ runEffect }) => runEffect('load-cache', async () => {
          operationCalls += 1
        })],
        ['remote', async ({ runEffect }) => runEffect('load-remote', async () => {
          operationCalls += 1
        })],
      ]))],
    ]),
    now: () => NaN,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(operationCalls, 0)
})

test('nested regions apply the same bounded admission independently', async () => {
  const plan = nestedPlan()
  let active = 0
  let peak = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => 'orders'],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async ({ runEffect }) => runEffect('load-cache', async () => {
          active += 1
          peak = Math.max(peak, active)
          await Promise.resolve()
          active -= 1
          return 'cache'
        })],
        ['remote', async ({ runEffect }) => runEffect('load-remote', async () => {
          active += 1
          peak = Math.max(peak, active)
          await Promise.resolve()
          active -= 1
          return 'remote'
        })],
      ]))],
    ]),
    maxConcurrentBranches: 1,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(peak, 1)
  assert.equal(result.scheduler.max_concurrent_branches, 1)
  assert.deepEqual(result.scheduler.regions, [
    {
      admitted: ['orders', 'users'],
      queued_cancelled: [],
      scope_path: ['fetch'],
    },
    {
      admitted: ['cache', 'remote'],
      queued_cancelled: [],
      scope_path: ['fetch', 'users', 'profile'],
    },
  ])
  assert.equal(result.verification.ok, true)
})

test('root cancellation propagates parent cancellation into an active child region', async () => {
  const plan = nestedPlan({
    childBranches: [
      { effects: [], id: 'cache', output_type: 'unit' },
      { effects: [], id: 'remote', output_type: 'unit' },
    ],
  })
  const parent = new AbortController()
  let started = 0
  let allStarted
  const ready = new Promise((resolve) => { allStarted = resolve })
  const waitForCancel = async ({ signal }) => {
    started += 1
    if (started === 3) allStarted()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  }
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', waitForCancel],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', waitForCancel],
        ['remote', waitForCancel],
      ]))],
    ]),
    parentSignal: parent.signal,
  })
  await ready
  parent.abort()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.verification.ok, true)
  assert.equal(nestedEvents(result).some((event) => (
    event.kind === 'region-cancel' && event.reason === 'parent'
  )), true)
})

test('nested cancellation distinguishes cooperative cleanup from complete-before-join', async () => {
  const plan = nestedPlan({
    childBranches: [
      {
        effects: [effect('cooperate')],
        id: 'cooperative',
        output_type: 'unit',
      },
      {
        effects: [effect('finish', 'complete-before-join')],
        id: 'finisher',
        output_type: 'unit',
      },
    ],
  })
  const parent = new AbortController()
  const clock = { value: 10 }
  let effectsStarted = 0
  let release
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  const markStarted = () => {
    effectsStarted += 1
    if (effectsStarted === 2) ready()
  }
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cooperative', async ({ runEffect, signal }) => runEffect(
          'cooperate',
          async () => {
            markStarted()
            await new Promise((resolve) => {
              signal.addEventListener('abort', resolve, { once: true })
            })
          },
        )],
        ['finisher', async ({ runEffect }) => runEffect('finish', async () => {
          markStarted()
          return new Promise((resolve) => {
            release = () => {
              clock.value = 17
              resolve('finished')
            }
          })
        })],
      ]))],
    ]),
    now: () => clock.value,
    parentSignal: parent.signal,
  })
  await started
  parent.abort()
  release()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.verification.ok, true)
  assert.equal(nestedEvents(result).some((event) => (
    event.kind === 'effect-cancelled' && event.effect === 'cooperate'
  )), true)
  assert.equal(nestedEvents(result).some((event) => (
    event.kind === 'effect-complete'
    && event.effect === 'finish'
    && event.cancel_latency_ms === 7
  )), true)
})

test('nested host fault waits child cleanup and propagates as a root host fault', async () => {
  const plan = nestedPlan({
    childBranches: [
      { effects: [], id: 'bad', output_type: 'unit' },
      { effects: [], id: 'sibling', output_type: 'unit' },
    ],
  })
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['bad', async () => { throw new Error('private nested fault') }],
        ['sibling', async ({ signal }) => new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
        })],
      ]))],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'host-fault')
  assert.equal(result.verification.ok, true)
  assert.equal(JSON.stringify(result).includes('private nested fault'), false)
  assert.equal(nestedEvents(result).some((event) => event.kind === 'branch-host-fault'), true)
})

test('nested runner mismatches fail closed', async () => {
  const plan = nestedPlan()
  const unknown = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => null],
      ['users', async ({ runNested }) => runNested('missing', new Map())],
    ]),
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.diagnostics[0].code, 'unknown-nested-concurrency-region')

  const missing = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => null],
      ['users', async ({ runNested }) => runNested('profile', new Map([
        ['cache', async () => null],
      ]))],
    ]),
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'missing-concurrency-runner')
})

test('one nested region with one thousand children settles without orphaned work', async () => {
  const childBranches = Array.from({ length: 1_000 }, (_, index) => ({
    effects: [],
    id: `child-${String(index).padStart(4, '0')}`,
    output_type: 'unit',
  }))
  const plan = nestedPlan({ childBranches })
  const childRunners = new Map(childBranches.map(({ id }) => [id, async () => id]))
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['orders', async () => null],
      ['users', async ({ runNested }) => runNested('profile', childRunners)],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(result.verification.ok, true)
  assert.equal(Object.keys(result.branches.users.branches).length, 1_000)
  assert.equal(nestedEvents(result).filter(({ kind }) => kind === 'branch-spawn').length, 1_000)
  assert.equal(nestedEvents(result).filter(({ kind }) => kind === 'branch-complete').length, 1_000)
})
