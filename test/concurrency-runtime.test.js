import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeConcurrencyPlan,
} from '../src/toolchain/concurrency-runtime.js'
import {
  lowerConcurrency,
  verifyConcurrencyTrace,
} from '../src/toolchain/concurrency-contract.js'

const schema = 're.concurrency-contract@0.1.0'
const digest = (letter) => `sha256:${letter.repeat(64)}`

function planFor(branches, { deadline = null } = {}) {
  const result = lowerConcurrency({
    kind: 'par',
    region: {
      branches: branches.map((branch) => ({
        effects: (branch.effects ?? []).map((effect) => ({
          after: effect.after ?? [],
          cancellation: effect.cancellation ?? 'cooperative',
          footprint: [{
            handle: null,
            mode: 'read',
            resource: {
              domain_digest: digest('a'),
              segments: [{
                canonical_hex: 'aa',
                type_digest: digest('b'),
              }],
            },
          }],
          id: effect.id,
          operation_digest: digest('c'),
        })),
        id: branch.id,
        output_type: 'unit',
      })),
      cancel_reason_type: {
        arguments: [],
        declaration_digest: digest('d'),
        kind: 'declared',
      },
      deadline: deadline === null ? null : {
        endpoint: 'request.deadline',
        type: 'time.monotonic_instant',
      },
      handles: [],
      id: 'runtime',
      join_type: {
        arguments: [],
        declaration_digest: digest('e'),
        kind: 'declared',
      },
      task_outcome_digest: digest('f'),
    },
    schema,
  })
  assert.equal(result.ok, true)
  return result.plan
}

function eventKinds(result) {
  return result.trace.events.map(({ kind }) => kind)
}

test('runtime establishes all branches, joins outcomes, and verifies its trace', async () => {
  const plan = planFor([
    { id: 'users', effects: [{ id: 'load' }] },
    { id: 'orders', effects: [{ id: 'load' }] },
  ])
  const calls = []
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['users', async ({ runEffect }) => {
        calls.push('users')
        return { loaded: await runEffect('load', async () => 'users') }
      }],
      ['orders', async ({ runEffect }) => {
        calls.push('orders')
        return { loaded: await runEffect('load', async () => 'orders') }
      }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'joined')
  assert.deepEqual(calls.sort(), ['orders', 'users'])
  assert.deepEqual(result.branches, {
    orders: { loaded: 'orders' },
    users: { loaded: 'users' },
  })
  assert.equal(result.verification.ok, true)
  assert.deepEqual(result.scheduler, {
    max_concurrent_branches: null,
    policy: 'fifo',
    regions: [{
      admitted: ['orders', 'users'],
      queued_cancelled: [],
      scope_path: ['runtime'],
    }],
    schema: 're.concurrency-scheduler@0.1.0',
  })
  assert.deepEqual(eventKinds(result).slice(0, 4), [
    'branch-spawn', 'branch-spawn', 'effect-start', 'effect-start',
  ])
  assert.equal(eventKinds(result).at(-1), 'region-exit')
})

test('runtime follows explicit plan order edges instead of effect names', async () => {
  const plan = planFor([
    { id: 'users', effects: [
      { id: 'z-last' },
      { after: ['z-last'], id: 'a-first' },
    ] },
    { id: 'orders', effects: [] },
  ])
  const order = []
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['users', async ({ runEffect }) => {
        await runEffect('z-last', async () => { order.push('z-last') })
        await runEffect('a-first', async () => { order.push('a-first') })
      }],
      ['orders', async () => null],
    ]),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(order, ['z-last', 'a-first'])
})

test('bounded admission is FIFO and never exceeds the configured active limit', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
    { id: 'gamma' },
  ])
  const order = []
  let active = 0
  let peak = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map(['alpha', 'beta', 'gamma'].map((branch) => [
      branch,
      async () => {
        active += 1
        peak = Math.max(peak, active)
        order.push(`${branch}:start`)
        await Promise.resolve()
        order.push(`${branch}:end`)
        active -= 1
        return branch
      },
    ])),
    maxConcurrentBranches: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(peak, 1)
  assert.deepEqual(order, [
    'alpha:start', 'alpha:end',
    'beta:start', 'beta:end',
    'gamma:start', 'gamma:end',
  ])
  assert.deepEqual(result.scheduler.regions[0], {
    admitted: ['alpha', 'beta', 'gamma'],
    queued_cancelled: [],
    scope_path: ['runtime'],
  })
  assert.equal(result.scheduler.max_concurrent_branches, 1)
  assert.equal(result.verification.ok, true)
})

test('queued branches are cancelled without invoking their runners', async () => {
  const plan = planFor([
    { id: 'first' },
    { id: 'second' },
    { id: 'third' },
  ])
  const parent = new AbortController()
  const calls = []
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['first', async ({ signal }) => {
        calls.push('first')
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
        })
      }],
      ['second', async () => { calls.push('second') }],
      ['third', async () => { calls.push('third') }],
    ]),
    maxConcurrentBranches: 1,
    parentSignal: parent.signal,
  })
  await Promise.resolve()
  parent.abort()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'cancelled')
  assert.deepEqual(calls, ['first'])
  assert.deepEqual(result.scheduler.regions[0], {
    admitted: ['first'],
    queued_cancelled: ['second', 'third'],
    scope_path: ['runtime'],
  })
  assert.deepEqual(
    result.trace.events
      .filter(({ kind }) => kind === 'branch-cancelled')
      .map(({ branch }) => branch)
      .sort(),
    ['first', 'second', 'third'],
  )
  assert.equal(result.verification.ok, true)
})

test('throwing branches accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let timerCalls = 0
  const options = {
    get branches() {
      accessorReads += 1
      throw new Error('private branches accessor failure')
    },
    deadline: 10,
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(timerCalls, 0)
})

test('branches accessor is snapshotted once before runtime startup', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  let accessorReads = 0
  let runnerCalls = 0
  const branches = new Map([
    ['alpha', async () => { runnerCalls += 1 }],
    ['beta', async () => { runnerCalls += 1 }],
  ])
  const options = {
    get branches() {
      accessorReads += 1
      if (accessorReads === 1) return branches
      throw new Error('private branches accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('root runner map get override cannot replace validated authority', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  let legitimateCalls = 0
  let spoofCalls = 0
  const branches = new Map([
    ['alpha', async ({ branch }) => {
      legitimateCalls += 1
      return branch
    }],
    ['beta', async ({ branch }) => {
      legitimateCalls += 1
      return branch
    }],
  ])
  branches.get = () => {
    spoofCalls += 1
    return async () => 'spoof'
  }
  const result = await executeConcurrencyPlan(plan, { branches })

  assert.equal(result.ok, true)
  assert.deepEqual(result.branches, { alpha: 'alpha', beta: 'beta' })
  assert.equal(legitimateCalls, 2)
  assert.equal(spoofCalls, 0)
})

test('root runner map snapshot ignores overridden iterator and size', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  let runnerCalls = 0
  const branches = new Map([
    ['alpha', async () => { runnerCalls += 1 }],
    ['beta', async () => { runnerCalls += 1 }],
  ])
  Object.defineProperty(branches, 'size', { value: 0 })
  branches[Symbol.iterator] = () => {
    throw new Error('private runner iterator failure')
  }
  const result = await executeConcurrencyPlan(plan, { branches })

  assert.equal(result.ok, true)
  assert.equal(runnerCalls, 2)
})

test('unreadable root runner map fails closed before branch startup', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  let runnerCalls = 0
  const branches = new Proxy(new Map([
    ['alpha', async () => { runnerCalls += 1 }],
    ['beta', async () => { runnerCalls += 1 }],
  ]), {})
  const result = await executeConcurrencyPlan(plan, { branches })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-runners' }],
    ok: false,
  })
  assert.equal(runnerCalls, 0)
})

test('invalid bounded admission options fail closed', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  for (const value of [null, 0, -1, 1.5, NaN, Infinity, '1']) {
    const result = await executeConcurrencyPlan(plan, {
      branches: new Map([
        ['alpha', async () => null],
        ['beta', async () => null],
      ]),
      maxConcurrentBranches: value,
    })

    assert.equal(result.ok, false, `value=${String(value)}`)
    assert.equal(
      result.diagnostics[0].code,
      'invalid-concurrency-max-concurrent-branches',
      `value=${String(value)}`,
    )
  }
})

test('throwing max concurrency accessor fails closed before branch startup', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  let accessorReads = 0
  let runnerCalls = 0
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    get maxConcurrentBranches() {
      accessorReads += 1
      throw new Error('private max concurrency accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('max concurrency accessor is snapshotted once before branch startup', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  let accessorReads = 0
  let runnerCalls = 0
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    get maxConcurrentBranches() {
      accessorReads += 1
      if (accessorReads === 1) return 1
      throw new Error('private max concurrency accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.equal(result.ok, true)
  assert.equal(result.scheduler.max_concurrent_branches, 1)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('invalid concurrency options containers fail closed before property access', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  for (const options of [null, [], 1, 'options']) {
    const result = await executeConcurrencyPlan(plan, options)

    assert.equal(result.ok, false, `options=${String(options)}`)
    assert.deepEqual(result.diagnostics, [{
      code: 'invalid-concurrency-options',
    }], `options=${String(options)}`)
  }
})

test('throwing deadline accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  let timerCalls = 0
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    get deadline() {
      accessorReads += 1
      throw new Error('private deadline accessor failure')
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
})

test('deadline accessor is snapshotted once before runtime startup', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  let timerDelay = null
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    get deadline() {
      accessorReads += 1
      if (accessorReads === 1) return 10
      throw new Error('private deadline accessor failure')
    },
    now: () => 5,
    setTimeoutImpl: (callback, delay) => {
      timerDelay = delay
      return null
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(timerDelay, 5)
  assert.equal(runnerCalls, 2)
})

test('throwing parent signal accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  let timerCalls = 0
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    get parentSignal() {
      accessorReads += 1
      throw new Error('private parent signal accessor failure')
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
})

test('parent signal accessor is snapshotted once before runtime startup', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  let accessorReads = 0
  let addCalls = 0
  let removeCalls = 0
  let runnerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener() {
      addCalls += 1
    },
    removeEventListener() {
      removeCalls += 1
    },
  }
  const options = {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    get parentSignal() {
      accessorReads += 1
      if (accessorReads === 1) return parentSignal
      throw new Error('private parent signal accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, options)

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(addCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(runnerCalls, 2)
})

test('parent signal capabilities are snapshotted before listener startup', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  let abortedReads = 0
  let addReads = 0
  let removeReads = 0
  let addCalls = 0
  let removeCalls = 0
  let runnerCalls = 0
  const parentSignal = {
    get aborted() {
      abortedReads += 1
      if (abortedReads === 1) return false
      throw new Error('private parent aborted capability failure')
    },
    get addEventListener() {
      addReads += 1
      if (addReads === 1) return () => { addCalls += 1 }
      throw new Error('private parent add capability failure')
    },
    get removeEventListener() {
      removeReads += 1
      if (removeReads === 1) return () => { removeCalls += 1 }
      throw new Error('private parent remove capability failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    parentSignal,
  })

  assert.equal(result.ok, true)
  assert.equal(abortedReads, 1)
  assert.equal(addReads, 1)
  assert.equal(removeReads, 1)
  assert.equal(addCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(runnerCalls, 2)
})

test('parent signal method bind overrides cannot replace capability authority', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  const listeners = new Set()
  let addCalls = 0
  let removeCalls = 0
  let spoofBindReads = 0
  let spoofCalls = 0
  const parentSignal = { aborted: false }
  parentSignal.addEventListener = function (type, listener) {
    assert.equal(this, parentSignal)
    assert.equal(type, 'abort')
    addCalls += 1
    listeners.add(listener)
  }
  parentSignal.removeEventListener = function (type, listener) {
    assert.equal(this, parentSignal)
    assert.equal(type, 'abort')
    removeCalls += 1
    listeners.delete(listener)
  }
  for (const method of [
    parentSignal.addEventListener,
    parentSignal.removeEventListener,
  ]) {
    Object.defineProperty(method, 'bind', {
      configurable: true,
      get() {
        spoofBindReads += 1
        return () => {
          spoofCalls += 1
          return () => {}
        }
      },
    })
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => {}],
      ['beta', async () => {}],
    ]),
    parentSignal,
  })

  assert.equal(result.ok, true)
  assert.equal(addCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(spoofBindReads, 0)
  assert.equal(spoofCalls, 0)
  assert.equal(listeners.size, 0)
})

test('parent signal method bind accessor faults do not invalidate a valid capability', async () => {
  const plan = planFor([{ id: 'alpha' }, { id: 'beta' }])
  let addCalls = 0
  let removeCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener(type) {
      assert.equal(type, 'abort')
      addCalls += 1
    },
    removeEventListener(type) {
      assert.equal(type, 'abort')
      removeCalls += 1
    },
  }
  for (const method of [
    parentSignal.addEventListener,
    parentSignal.removeEventListener,
  ]) {
    Object.defineProperty(method, 'bind', {
      configurable: true,
      get() {
        throw new Error('private parent method bind failure')
      },
    })
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => {}],
      ['beta', async () => {}],
    ]),
    parentSignal,
  })

  assert.equal(result.ok, true)
  assert.equal(addCalls, 1)
  assert.equal(removeCalls, 1)
})

test('throwing now accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  let timerCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    get now() {
      accessorReads += 1
      throw new Error('private now accessor failure')
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
})

test('throwing setTimeout accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    get setTimeoutImpl() {
      accessorReads += 1
      throw new Error('private setTimeout accessor failure')
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('throwing clearTimeout accessor fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let accessorReads = 0
  let runnerCalls = 0
  let timerCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    get clearTimeoutImpl() {
      accessorReads += 1
      throw new Error('private clearTimeout accessor failure')
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-options' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
})

test('invalid initial deadline clock readings fail before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  for (const reading of [NaN, Infinity, -1]) {
    let timerCalls = 0
    let runnerCalls = 0
    const result = await executeConcurrencyPlan(plan, {
      branches: new Map([
        ['alpha', async () => { runnerCalls += 1 }],
        ['beta', async () => { runnerCalls += 1 }],
      ]),
      deadline: 10,
      now: () => reading,
      setTimeoutImpl: () => {
        timerCalls += 1
        return null
      },
    })

    assert.equal(result.ok, false, `reading=${String(reading)}`)
    assert.equal(result.diagnostics[0].code, 'invalid-concurrency-clock')
    assert.equal(timerCalls, 0)
    assert.equal(runnerCalls, 0)
  }
})

test('throwing initial deadline clock fails closed before timers and runners', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let timerCalls = 0
  let runnerCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => {
      throw new Error('private clock failure')
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return null
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
})

test('throwing deadline timer fails closed and removes the parent listener', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  const listeners = new Set()
  let runnerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.delete(listener)
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => {
      throw new Error('private timer failure')
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(runnerCalls, 0)
  assert.equal(listeners.size, 0)
})

test('throwing deadline timer cleanup fails closed and removes the parent listener', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  const listeners = new Set()
  let runnerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.delete(listener)
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    clearTimeoutImpl: () => {
      throw new Error('private timer cleanup failure')
    },
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => ({ timer: true }),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(runnerCalls, 2)
  assert.equal(listeners.size, 0)
})

test('throwing parent listener registration fails closed and rolls back the listener', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  const listeners = new Set()
  let runnerCalls = 0
  let timerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.add(listener)
      throw new Error('private parent signal failure')
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.delete(listener)
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => {
      timerCalls += 1
      return { timer: true }
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-parent-signal' }],
    ok: false,
  })
  assert.equal(timerCalls, 0)
  assert.equal(runnerCalls, 0)
  assert.equal(listeners.size, 0)
})

test('throwing parent aborted getter fails closed during signal validation', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ])
  let runnerCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    parentSignal: {
      addEventListener() {},
      get aborted() {
        throw new Error('private parent state failure')
      },
      removeEventListener() {},
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-parent-signal' }],
    ok: false,
  })
  assert.equal(runnerCalls, 0)
})

test('parent aborted state is snapshotted before listener registration', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  const listeners = new Set()
  let abortedReads = 0
  let runnerCalls = 0
  let timerCalls = 0
  const parentSignal = {
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.add(listener)
    },
    get aborted() {
      abortedReads += 1
      if (abortedReads === 1) return false
      throw new Error('private parent state failure')
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.delete(listener)
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => {
      timerCalls += 1
      return { timer: true }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(abortedReads, 1)
  assert.equal(timerCalls, 1)
  assert.equal(runnerCalls, 2)
  assert.equal(listeners.size, 0)
})

test('throwing parent listener rollback preserves the primary timer fault', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let removeCalls = 0
  let runnerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      removeCalls += 1
      throw new Error('private parent cleanup failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => {
      throw new Error('private timer failure')
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(removeCalls, 1)
  assert.equal(runnerCalls, 0)
})

test('throwing parent listener final cleanup fails closed after runners complete', async () => {
  const plan = planFor([
    { id: 'alpha' },
    { id: 'beta' },
  ], { deadline: 10 })
  let clearCalls = 0
  let removeCalls = 0
  let runnerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      removeCalls += 1
      throw new Error('private parent cleanup failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async () => { runnerCalls += 1 }],
      ['beta', async () => { runnerCalls += 1 }],
    ]),
    clearTimeoutImpl: () => {
      clearCalls += 1
    },
    deadline: 10,
    now: () => 5,
    parentSignal,
    setTimeoutImpl: () => ({ timer: true }),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-parent-signal' }],
    ok: false,
  })
  assert.equal(clearCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(runnerCalls, 2)
})

test('throwing effect start clock fails closed before the operation starts', async () => {
  const plan = planFor([
    { id: 'alpha', effects: [{ id: 'load' }] },
    { id: 'beta' },
  ])
  let operationCalls = 0
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async ({ runEffect }) => runEffect('load', async () => {
        operationCalls += 1
      })],
      ['beta', async () => 'beta'],
    ]),
    now: () => {
      throw new Error('private effect clock failure')
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(operationCalls, 0)
})

test('throwing cancellation completion clock fails closed after the operation completes', async () => {
  const plan = planFor([
    {
      effects: [{ cancellation: 'complete-before-join', id: 'finish' }],
      id: 'alpha',
    },
    { id: 'beta' },
  ])
  const parent = new AbortController()
  let clockReads = 0
  let operationCompleted = false
  let release
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async ({ runEffect }) => runEffect('finish', async () => {
        started()
        await new Promise((resolve) => { release = resolve })
        operationCompleted = true
      })],
      ['beta', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
    ]),
    now: () => {
      clockReads += 1
      if (clockReads === 1) return 10
      throw new Error('private effect clock failure')
    },
    parentSignal: parent.signal,
  })
  await ready
  parent.abort()
  release()
  const result = await resultPromise

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(operationCompleted, true)
})

test('invalid effect clock readings fail closed before operations start', async () => {
  const plan = planFor([
    { id: 'alpha', effects: [{ id: 'load' }] },
    { id: 'beta' },
  ])
  for (const reading of [NaN, Infinity, -1]) {
    let operationCalls = 0
    const result = await executeConcurrencyPlan(plan, {
      branches: new Map([
        ['alpha', async ({ runEffect }) => runEffect('load', async () => {
          operationCalls += 1
        })],
        ['beta', async () => 'beta'],
      ]),
      now: () => reading,
    })

    assert.deepEqual(result, {
      diagnostics: [{ code: 'invalid-concurrency-clock' }],
      ok: false,
    }, `reading=${String(reading)}`)
    assert.equal(operationCalls, 0, `reading=${String(reading)}`)
  }
})

test('invalid cancellation completion clock fails closed after the operation completes', async () => {
  const plan = planFor([
    {
      effects: [{ cancellation: 'complete-before-join', id: 'finish' }],
      id: 'alpha',
    },
    { id: 'beta' },
  ])
  const parent = new AbortController()
  let clockReads = 0
  let operationCompleted = false
  let release
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['alpha', async ({ runEffect }) => runEffect('finish', async () => {
        started()
        await new Promise((resolve) => { release = resolve })
        operationCompleted = true
      })],
      ['beta', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
    ]),
    now: () => {
      clockReads += 1
      return clockReads === 1 ? 10 : NaN
    },
    parentSignal: parent.signal,
  })
  await ready
  parent.abort()
  release()
  const result = await resultPromise

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-clock' }],
    ok: false,
  })
  assert.equal(operationCompleted, true)
})

test('host fault cancels bounded branches that have not been admitted', async () => {
  const plan = planFor([
    { id: 'bad' },
    { id: 'queued' },
  ])
  const calls = []
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['bad', async () => {
        calls.push('bad')
        throw new Error('private host fault')
      }],
      ['queued', async () => { calls.push('queued') }],
    ]),
    maxConcurrentBranches: 1,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.outcome, 'host-fault')
  assert.deepEqual(calls, ['bad'])
  assert.deepEqual(result.scheduler.regions[0], {
    admitted: ['bad'],
    queued_cancelled: ['queued'],
    scope_path: ['runtime'],
  })
  assert.equal(result.trace.events.some((event) => (
    event.kind === 'branch-cancelled' && event.branch === 'queued'
  )), true)
  assert.equal(result.verification.ok, true)
})

test('parent cancellation waits cleanup and does not fake cooperative completion', async () => {
  const plan = planFor([
    { id: 'fast', effects: [{ id: 'run' }] },
    { id: 'slow', effects: [{ id: 'run' }] },
  ])
  const parent = new AbortController()
  let release
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['fast', async ({ runEffect }) => runEffect('run', async () => {
        await new Promise((resolve) => { release = resolve })
        return 'late'
      })],
      ['slow', async ({ signal, runEffect }) => runEffect('run', async () => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
        })
        return 'stopped'
      })],
    ]),
    parentSignal: parent.signal,
  })
  await Promise.resolve()
  parent.abort()
  release()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.trace.events.some((event) => (
    event.kind === 'effect-complete' && event.branch === 'fast'
  )), false)
  assert.equal(result.verification.ok, true)
})

test('branch completion before parent cancellation remains complete', async () => {
  const plan = planFor([
    { id: 'fast', effects: [{ id: 'run' }] },
    { id: 'slow', effects: [{ id: 'run' }] },
  ])
  const parent = new AbortController()
  let finishFast
  let markSlowStarted
  const fastCompleted = new Promise((resolve) => { finishFast = resolve })
  const slowStarted = new Promise((resolve) => { markSlowStarted = resolve })
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['fast', async ({ runEffect }) => {
        const value = await runEffect('run', async () => 'fast-result')
        finishFast()
        return value
      }],
      ['slow', async ({ signal, runEffect }) => runEffect('run', async () => {
        markSlowStarted()
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
        })
        return 'cancelled-result'
      })],
    ]),
    parentSignal: parent.signal,
  })

  await Promise.all([fastCompleted, slowStarted])
  parent.abort()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'joined')
  assert.equal(result.branches.fast, 'fast-result')
  assert.equal(Object.hasOwn(result.branches, 'slow'), false)
  assert.equal(result.trace.events.some((event) => (
    event.kind === 'branch-complete' && event.branch === 'fast'
  )), true)
  assert.equal(result.trace.events.some((event) => (
    event.kind === 'branch-cancelled' && event.branch === 'slow'
  )), true)
  assert.deepEqual(eventKinds(result).filter((kind) => (
    kind === 'effect-complete' || kind === 'effect-cancelled'
  )), ['effect-complete', 'effect-cancelled'])
  assert.equal(result.verification.ok, true)
})

test('complete-before-join records non-negative cancellation latency', async () => {
  const plan = planFor([
    { id: 'fast', effects: [{ id: 'run', cancellation: 'complete-before-join' }] },
    { id: 'other', effects: [] },
  ])
  const parent = new AbortController()
  const clock = { value: 10 }
  let release
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['fast', async ({ runEffect }) => runEffect('run', async () => (
        new Promise((resolve) => { release = () => { clock.value = 17; resolve('done') } })
      ))],
      ['other', async () => 'other'],
    ]),
    now: () => clock.value,
    parentSignal: parent.signal,
  })
  await Promise.resolve()
  parent.abort()
  release()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.deepEqual(result.verification.summary.complete_before_join_effects, [
    { branch: 'fast', cancel_latency_ms: 7, effect: 'run' },
  ])
})

test('deadline uses an explicit monotonic endpoint and waits cooperative cleanup', async () => {
  const plan = planFor([
    { id: 'fast', effects: [] },
    { id: 'slow', effects: [] },
  ], { deadline: 35 })
  let timer = null
  const resultPromise = executeConcurrencyPlan(plan, {
    branches: new Map([
      ['fast', async () => 'fast'],
      ['slow', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
    ]),
    deadline: 35,
    now: () => 10,
    setTimeoutImpl: (callback, delay) => {
      timer = { callback, delay }
      return timer
    },
    clearTimeoutImpl: () => {},
  })
  await Promise.resolve()
  assert.equal(timer.delay, 25)
  timer.callback()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'joined')
  assert.equal(result.verification.summary.cancel_reasons[0], 'deadline')
})

test('host fault sanitizes the fault, cancels siblings, and joins cleanup', async () => {
  const plan = planFor([
    { id: 'bad', effects: [] },
    { id: 'sibling', effects: [] },
  ])
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['bad', async () => { throw new Error('secret stack detail') }],
      ['sibling', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'host-fault')
  assert.deepEqual(result.verification.summary.host_fault_branches, ['bad'])
  assert.equal(JSON.stringify(result).includes('secret stack detail'), false)
  assert.equal(result.trace.events.some((event) => event.kind === 'branch-cancelled'), true)
})

test('throwing plan root getter fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  let accessorReads = 0
  let runnerCalls = 0
  const plan = {
    ...basePlan,
    get schema() {
      accessorReads += 1
      throw new Error('private plan schema accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('plan root fields are snapshotted before validation and verification', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  let accessorReads = 0
  let runnerCalls = 0
  const plan = {
    ...basePlan,
    get nodes() {
      accessorReads += 1
      if (accessorReads === 1) return basePlan.nodes
      throw new Error('private plan nodes accessor failure')
    },
  }
  const result = await executeConcurrencyPlan(plan, {
    get branches() {
      return new Map([
        ['one', async () => { runnerCalls += 1 }],
        ['two', async () => { runnerCalls += 1 }],
      ])
    },
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('throwing nested plan node getter fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'task-scope')
  let accessorReads = 0
  let runnerCalls = 0
  const throwingNode = {
    ...targetNode,
    get kind() {
      accessorReads += 1
      throw new Error('private nested plan node accessor failure')
    },
  }
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode ? throwingNode : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('nested plan nodes are snapshotted before validation and verification', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'task-scope')
  let accessorReads = 0
  let runnerCalls = 0
  const snapshottedNode = {
    ...targetNode,
    get kind() {
      accessorReads += 1
      if (accessorReads === 1) return 'task-scope'
      throw new Error('private nested plan node accessor failure')
    },
  }
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode ? snapshottedNode : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('throwing plan edge getter fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetEdge = basePlan.edges.find((edge) => edge.kind === 'spawn')
  let accessorReads = 0
  let runnerCalls = 0
  const throwingEdge = {
    ...targetEdge,
    get kind() {
      accessorReads += 1
      throw new Error('private plan edge accessor failure')
    },
  }
  const plan = {
    ...basePlan,
    edges: basePlan.edges.map((edge) => edge === targetEdge ? throwingEdge : edge),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('plan edges are snapshotted before validation and verification', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetEdge = basePlan.edges.find((edge) => edge.kind === 'spawn')
  let accessorReads = 0
  let runnerCalls = 0
  const snapshottedEdge = {
    ...targetEdge,
    get kind() {
      accessorReads += 1
      if (accessorReads === 1) return 'spawn'
      throw new Error('private plan edge accessor failure')
    },
  }
  const plan = {
    ...basePlan,
    edges: basePlan.edges.map((edge) => edge === targetEdge ? snapshottedEdge : edge),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('overridden node collection map cannot bypass node snapshot', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'task-scope')
  let accessorReads = 0
  let runnerCalls = 0
  const snapshottedNode = {
    ...targetNode,
    get kind() {
      accessorReads += 1
      if (accessorReads === 1) return 'task-scope'
      throw new Error('private node collection map bypass')
    },
  }
  const nodes = basePlan.nodes.map((node) => node === targetNode ? snapshottedNode : node)
  nodes.map = function () { return this }
  const result = await executeConcurrencyPlan({ ...basePlan, nodes }, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('overridden edge collection map cannot bypass edge snapshot', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetEdge = basePlan.edges.find((edge) => edge.kind === 'spawn')
  let accessorReads = 0
  let runnerCalls = 0
  const snapshottedEdge = {
    ...targetEdge,
    get kind() {
      accessorReads += 1
      if (accessorReads === 1) return 'spawn'
      throw new Error('private edge collection map bypass')
    },
  }
  const edges = basePlan.edges.map((edge) => edge === targetEdge ? snapshottedEdge : edge)
  edges.map = function () { return this }
  const result = await executeConcurrencyPlan({ ...basePlan, edges }, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('throwing join member collection accessor fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'join')
  let accessorReads = 0
  let runnerCalls = 0
  const members = [...targetNode.members]
  Object.defineProperty(members, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessorReads += 1
      throw new Error('private join member collection accessor failure')
    },
  })
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode
      ? { ...targetNode, members }
      : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 0)
})

test('join member collections are snapshotted before validation and verification', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'join')
  let accessorReads = 0
  let runnerCalls = 0
  const members = [...targetNode.members]
  Object.defineProperty(members, '0', {
    configurable: true,
    enumerable: true,
    get() {
      accessorReads += 1
      if (accessorReads === 1) return targetNode.members[0]
      throw new Error('private join member collection accessor failure')
    },
  })
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode
      ? { ...targetNode, members }
      : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.equal(result.ok, true)
  assert.equal(accessorReads, 1)
  assert.equal(runnerCalls, 2)
})

test('throwing par policy getter fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }])
  const targetNode = basePlan.nodes.find((node) => node.kind === 'par-region')
  let runnerCalls = 0
  const policy = {
    ...targetNode.policy,
    get branch_error() {
      throw new Error('private par policy accessor failure')
    },
  }
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode
      ? { ...targetNode, policy }
      : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(runnerCalls, 0)
})

test('malformed par region deadline fails closed before runtime startup', async () => {
  const basePlan = planFor([{ id: 'one' }, { id: 'two' }], { deadline: 10 })
  const targetNode = basePlan.nodes.find((node) => node.kind === 'par-region')
  let runnerCalls = 0
  const plan = {
    ...basePlan,
    nodes: basePlan.nodes.map((node) => node === targetNode
      ? { ...targetNode, deadline: { endpoint: 1, type: 'wrong' } }
      : node),
  }
  const result = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async () => { runnerCalls += 1 }],
      ['two', async () => { runnerCalls += 1 }],
    ]),
    deadline: 10,
    now: () => 0,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-concurrency-plan' }],
    ok: false,
  })
  assert.equal(runnerCalls, 0)
})

test('malformed plans and runner/effect mismatches fail closed', async () => {
  const plan = planFor([{ id: 'one', effects: [] }, { id: 'two', effects: [] }])
  for (const input of [
    null,
    {},
    { ...plan, nodes: plan.nodes.filter(({ kind }) => kind !== 'par-region') },
  ]) {
    const result = await executeConcurrencyPlan(input, { branches: new Map() })
    assert.equal(result.ok, false)
    assert.match(result.diagnostics[0].code, /^[a-z][a-z0-9-]*$/u)
  }
  const unknownRunner = await executeConcurrencyPlan(plan, {
    branches: new Map([['one', async () => 1]]),
  })
  assert.equal(unknownRunner.ok, false)

  const unknownEffect = await executeConcurrencyPlan(plan, {
    branches: new Map([
      ['one', async ({ runEffect }) => runEffect('missing', async () => 1)],
      ['two', async () => 2],
    ]),
  })
  assert.equal(unknownEffect.ok, false)

  const missingDeadline = await executeConcurrencyPlan(
    planFor([{ id: 'one' }, { id: 'two' }], { deadline: 1 }),
    { branches: new Map([['one', async () => 1], ['two', async () => 2]]) },
  )
  assert.equal(missingDeadline.diagnostics[0].code, 'missing-explicit-concurrency-deadline')
})

test('ten thousand empty branches settle without orphaned work', async () => {
  const plan = planFor(Array.from({ length: 10_000 }, (_, index) => ({
    id: `branch-${String(index).padStart(5, '0')}`,
  })))
  const branches = new Map(
    plan.nodes
      .filter(({ kind }) => kind === 'task-scope')
      .map(({ id }) => [id.slice('par.runtime.branch.'.length), async () => null]),
  )
  const result = await executeConcurrencyPlan(plan, { branches })
  assert.equal(result.ok, true)
  assert.equal(result.verification.summary.branch_count, 10_000)
  assert.equal(result.trace.events.length, 20_001)
})
