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

function recursivePlan({ betaEffects = [], leafEffects = [] } = {}) {
  const result = lowerConcurrency({
    kind: 'par',
    region: region('root', [
      {
        effects: [],
        id: 'outer',
        nested_regions: [region('middle', [
          {
            effects: [],
            id: 'inner',
            nested_regions: [region('leaf', [
              { effects: leafEffects, id: 'alpha', output_type: 'unit' },
              { effects: betaEffects, id: 'beta', output_type: 'unit' },
            ])],
            output_type: 'unit',
          },
          { effects: [], id: 'middle-peer', output_type: 'unit' },
        ])],
        output_type: 'unit',
      },
      { effects: [], id: 'root-peer', output_type: 'unit' },
    ]),
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(result.ok, true)
  return result.plan
}

function recursiveRunners(leafRunners) {
  return new Map([
    ['outer', async ({ runNested }) => runNested('middle', new Map([
      ['inner', async ({ runNested: runLeaf }) => runLeaf('leaf', leafRunners)],
      ['middle-peer', async () => 'middle-peer'],
    ]))],
    ['root-peer', async () => 'root-peer'],
  ])
}

function eventIndex(events, predicate) {
  return events.findIndex(predicate)
}

test('recursive runtime joins every descendant region before its direct parent', async () => {
  const result = await executeConcurrencyPlan(recursivePlan(), {
    branches: recursiveRunners(new Map([
      ['alpha', async () => 'alpha'],
      ['beta', async () => 'beta'],
    ])),
  })

  assert.equal(result.ok, true)
  assert.equal(result.verification.ok, true)
  assert.equal(result.branches.outer.branches.inner.branches.alpha, 'alpha')
  const events = result.trace.events
  const leafExit = eventIndex(events, (event) => (
    event.kind === 'region-exit' && event.scope_path?.join('/') === 'root/outer/middle/inner/leaf'
  ))
  const innerTerminal = eventIndex(events, (event) => (
    event.kind === 'branch-complete'
    && event.branch === 'inner'
    && event.scope_path?.join('/') === 'root/outer/middle'
  ))
  const middleExit = eventIndex(events, (event) => (
    event.kind === 'region-exit' && event.scope_path?.join('/') === 'root/outer/middle'
  ))
  const outerTerminal = eventIndex(events, (event) => (
    event.kind === 'branch-complete' && event.branch === 'outer'
  ))
  assert.ok(leafExit >= 0)
  assert.ok(innerTerminal > leafExit)
  assert.ok(middleExit > innerTerminal)
  assert.ok(outerTerminal > middleExit)
})

test('root cancellation reaches a deep cooperative effect and joins all descendants', async () => {
  const parent = new AbortController()
  const clock = { value: 10 }
  let effectsStarted = 0
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  let releaseFinisher
  const markStarted = () => {
    effectsStarted += 1
    if (effectsStarted === 2) ready()
  }
  const waitForCancel = async ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true })
  })
  const resultPromise = executeConcurrencyPlan(recursivePlan({
    betaEffects: [effect('finish', 'complete-before-join')],
    leafEffects: [effect('wait')],
  }), {
    branches: new Map([
      ['outer', async ({ runNested }) => runNested('middle', new Map([
        ['inner', async ({ runNested: runLeaf }) => runLeaf('leaf', new Map([
          ['alpha', async ({ runEffect, signal }) => runEffect('wait', async () => {
            markStarted()
            await waitForCancel({ signal })
          })],
          ['beta', async ({ runEffect }) => runEffect('finish', async () => {
            markStarted()
            return new Promise((resolve) => {
              releaseFinisher = () => {
                clock.value = 17
                resolve('finished')
              }
            })
          })],
        ]))],
        ['middle-peer', waitForCancel],
      ]))],
      ['root-peer', waitForCancel],
    ]),
    now: () => clock.value,
    parentSignal: parent.signal,
  })
  const first = await Promise.race([
    started.then(() => 'started'),
    resultPromise.then(() => 'settled'),
  ])
  assert.equal(first, 'started')
  parent.abort()
  releaseFinisher()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.verification.ok, true)
  const deepEvents = result.trace.events.filter((event) => (
    event.scope_path?.join('/') === 'root/outer/middle/inner/leaf'
  ))
  assert.equal(deepEvents.some((event) => (
    event.kind === 'region-cancel' && event.reason === 'parent'
  )), true)
  assert.equal(deepEvents.some((event) => (
    event.kind === 'effect-cancelled' && event.effect === 'wait'
  )), true)
  assert.equal(deepEvents.some((event) => (
    event.kind === 'effect-complete'
    && event.effect === 'finish'
    && event.cancel_latency_ms === 7
  )), true)
})

test('deep host fault settles local siblings and propagates through every parent region', async () => {
  const result = await executeConcurrencyPlan(recursivePlan(), {
    branches: recursiveRunners(new Map([
      ['alpha', async () => { throw new Error('private deep fault') }],
      ['beta', async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })],
    ])),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'host-fault')
  assert.equal(result.verification.ok, true)
  assert.equal(JSON.stringify(result).includes('private deep fault'), false)
  const exits = result.trace.events.filter(({ kind }) => kind === 'region-exit')
  assert.deepEqual(exits.map(({ outcome, scope_path: scopePath }) => ({
    outcome,
    scopePath: scopePath ?? ['root'],
  })), [
    { outcome: 'host-fault', scopePath: ['root', 'outer', 'middle', 'inner', 'leaf'] },
    { outcome: 'host-fault', scopePath: ['root', 'outer', 'middle'] },
    { outcome: 'host-fault', scopePath: ['root'] },
  ])
})

test('recursive runner authority stays local to the current plan step', async () => {
  const wrongLevel = await executeConcurrencyPlan(recursivePlan(), {
    branches: new Map([
      ['outer', async ({ runNested }) => runNested('leaf', new Map())],
      ['root-peer', async () => null],
    ]),
  })
  assert.equal(wrongLevel.ok, false)
  assert.equal(wrongLevel.diagnostics[0].code, 'unknown-nested-concurrency-region')

  const missingDeepRunner = await executeConcurrencyPlan(recursivePlan(), {
    branches: recursiveRunners(new Map([
      ['alpha', async () => null],
    ])),
  })
  assert.equal(missingDeepRunner.ok, false)
  assert.equal(missingDeepRunner.diagnostics[0].code, 'missing-concurrency-runner')
})

test('recursive plan depth is bounded before any runner starts', async () => {
  let nested = region('level-32', [
    { effects: [], id: 'left-32', output_type: 'unit' },
    { effects: [], id: 'right-32', output_type: 'unit' },
  ])
  for (let depth = 31; depth >= 1; depth -= 1) {
    nested = region(`level-${depth}`, [
      {
        effects: [],
        id: `left-${depth}`,
        nested_regions: [nested],
        output_type: 'unit',
      },
      { effects: [], id: `right-${depth}`, output_type: 'unit' },
    ])
  }
  const lowered = lowerConcurrency({
    kind: 'par',
    region: region('level-0', [
      {
        effects: [],
        id: 'left-0',
        nested_regions: [nested],
        output_type: 'unit',
      },
      { effects: [], id: 'right-0', output_type: 'unit' },
    ]),
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(lowered.ok, true)
  let started = false
  const result = await executeConcurrencyPlan(lowered.plan, {
    branches: new Map([
      ['left-0', async () => { started = true }],
      ['right-0', async () => { started = true }],
    ]),
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'concurrency-plan-depth-limit-exceeded')
  assert.equal(started, false)
})

test('sixteen nested levels with one thousand leaf branches settle without orphans', async () => {
  const leafBranches = Array.from({ length: 1_000 }, (_, index) => ({
    effects: [],
    id: `leaf-${String(index).padStart(4, '0')}`,
    output_type: 'unit',
  }))
  let rootRegion = region('level-15', leafBranches)
  for (let depth = 14; depth >= 0; depth -= 1) {
    rootRegion = region(`level-${depth}`, [
      {
        effects: [],
        id: `left-${depth}`,
        nested_regions: [rootRegion],
        output_type: 'unit',
      },
      { effects: [], id: `right-${depth}`, output_type: 'unit' },
    ])
  }
  const lowered = lowerConcurrency({
    kind: 'par',
    region: rootRegion,
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(lowered.ok, true)
  const runnersFor = (depth) => {
    if (depth === 15) {
      return new Map(leafBranches.map(({ id }) => [id, async () => id]))
    }
    return new Map([
      [`left-${depth}`, async ({ runNested }) => (
        runNested(`level-${depth + 1}`, runnersFor(depth + 1))
      )],
      [`right-${depth}`, async () => `right-${depth}`],
    ])
  }

  const result = await executeConcurrencyPlan(lowered.plan, {
    branches: runnersFor(0),
  })

  assert.equal(result.ok, true)
  assert.equal(result.verification.ok, true)
  assert.equal(result.trace.events.filter(({ kind }) => kind === 'region-exit').length, 16)
  assert.equal(result.trace.events.filter(({ kind }) => kind === 'branch-spawn').length, 1_030)
  assert.equal(result.trace.events.filter(({ kind }) => kind === 'branch-complete').length, 1_030)
})
