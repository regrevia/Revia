import { Buffer } from 'node:buffer'

import { isValidUid } from './graph-identity.js'

const CONTRACT_SCHEMA = 're.concurrency-contract@0.1.0'
const PLAN_SCHEMA = 're.concurrency-plan@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CANONICAL_HEX = /^(?:[0-9a-f]{2})*$/u
const ID = /^[a-z][a-z0-9_.-]*$/u
const CANCELLATION_MODES = ['complete-before-join', 'cooperative']
const ACCESS_MODES = ['read', 'write']

export function lowerConcurrency(input) {
  try {
    assertObject(input, 'invalid-concurrency-contract')
    exactFields(input, ['kind', 'region', 'schema'], 'concurrency-contract')
    if (input.schema !== CONTRACT_SCHEMA) fail('unsupported-concurrency-contract')
    if (input.kind !== 'par') fail('unsupported-concurrency-kind', { kind: input.kind })
    return { ok: true, plan: lowerPar(input.region) }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-concurrency-contract' }],
      ok: false,
    }
  }
}

export function verifyConcurrencyTrace(plan, trace) {
  try {
    const shape = planShape(plan)
    assertObject(trace, 'invalid-concurrency-trace')
    exactFields(trace, ['events', 'region_id', 'schema'], 'concurrency-trace')
    if (trace.schema !== 're.concurrency-trace@0.1.0') {
      fail('unsupported-concurrency-trace')
    }
    if (trace.region_id !== shape.regionId) fail('concurrency-trace-region-mismatch')
    if (!Array.isArray(trace.events)) fail('invalid-concurrency-trace-events')
    if (shape.regions.size > 1) return verifyNestedConcurrencyTrace(shape, trace)
    const state = new Map(shape.branches.map((branch) => [branch, 'pending']))
    const effects = new Map(shape.branches.map((branch) => [
      branch,
      new Map(shape.effectsByBranch.get(branch).map((effect) => [
        effect.effect,
        { ...effect, cancel_latency_ms: null, state: 'pending' },
      ])),
    ]))
    const cancelReasons = new Set()
    const completeBeforeJoinEffects = []
    const hostFaults = new Set()
    let exit = null
    let firstCancel = null
    let pendingBranches = shape.branches.length
    let spawningClosed = false
    for (let index = 0; index < trace.events.length; index += 1) {
      const event = trace.events[index]
      assertObject(event, 'invalid-concurrency-trace-event')
      if (event.ordinal !== index) fail('non-contiguous-concurrency-trace-ordinal')
      if (exit !== null) fail('event-after-region-exit')
      if (event.kind === 'branch-spawn') {
        exactFields(event, ['branch', 'kind', 'ordinal'], 'branch-spawn-event')
        traceBranch(event.branch, state)
        if (spawningClosed) fail('late-branch-spawn', { branch: event.branch })
        if (state.get(event.branch) !== 'pending') fail('duplicate-branch-spawn')
        state.set(event.branch, 'spawned')
        pendingBranches -= 1
      } else if (event.kind === 'effect-start') {
        exactFields(event, ['branch', 'effect', 'kind', 'ordinal'], 'effect-start-event')
        traceBranch(event.branch, state)
        const effect = traceEffect(event.branch, event.effect, effects)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (state.get(event.branch) !== 'spawned') fail('effect-start-after-branch-terminal')
        if (effect.state !== 'pending') fail('effect-lifecycle-repeated', {
          branch: event.branch,
          effect: event.effect,
        })
        effect.state = 'started'
      } else if (event.kind === 'effect-complete') {
        exactFields(event, [
          'branch', 'cancel_latency_ms', 'effect', 'kind', 'ordinal',
        ], 'effect-complete-event')
        traceBranch(event.branch, state)
        const effect = traceEffect(event.branch, event.effect, effects)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (state.get(event.branch) !== 'spawned') fail('effect-complete-after-branch-terminal')
        if (effect.state !== 'started') fail('effect-complete-without-start', {
          branch: event.branch,
          effect: event.effect,
        })
        const afterCancel = firstCancel !== null || hostFaults.size > 0
        if (afterCancel && effect.cancellation !== 'complete-before-join') {
          fail('cooperative-effect-completed-after-cancel', {
            branch: event.branch,
            effect: event.effect,
          })
        }
        if (afterCancel) {
          if (!validLatency(event.cancel_latency_ms)) {
            fail('invalid-complete-before-join-cancel-latency', {
              branch: event.branch,
              effect: event.effect,
            })
          }
          effect.cancel_latency_ms = event.cancel_latency_ms
          completeBeforeJoinEffects.push({
            branch: event.branch,
            cancel_latency_ms: event.cancel_latency_ms,
            effect: event.effect,
          })
        } else if (event.cancel_latency_ms !== null) {
          fail('unexpected-effect-cancel-latency', {
            branch: event.branch,
            effect: event.effect,
          })
        }
        effect.state = 'completed'
      } else if (event.kind === 'effect-cancelled') {
        exactFields(event, ['branch', 'effect', 'kind', 'ordinal'], 'effect-cancelled-event')
        traceBranch(event.branch, state)
        const effect = traceEffect(event.branch, event.effect, effects)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (state.get(event.branch) !== 'spawned') fail('effect-cancelled-after-branch-terminal')
        if (effect.state !== 'started') fail('effect-cancelled-without-start', {
          branch: event.branch,
          effect: event.effect,
        })
        if (effect.cancellation !== 'cooperative') {
          fail('complete-before-join-effect-cancelled', {
            branch: event.branch,
            effect: event.effect,
          })
        }
        effect.state = 'cancelled'
      } else if (event.kind === 'region-cancel') {
        exactFields(event, ['kind', 'ordinal', 'reason'], 'region-cancel-event')
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (!['deadline', 'parent'].includes(event.reason)) fail('invalid-region-cancel-reason')
        if (firstCancel !== null) fail('duplicate-region-cancel')
        if (![...state.values()].includes('spawned')) fail('cancel-after-children-settle')
        firstCancel = event.reason
        cancelReasons.add(event.reason)
      } else if (event.kind === 'branch-complete') {
        exactFields(event, ['branch', 'kind', 'ordinal'], 'branch-complete-event')
        traceBranch(event.branch, state)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (state.get(event.branch) !== 'spawned') fail('branch-terminal-state-repeated')
        requireStartedEffectsSettled(event.branch, effects)
        if (firstCancel !== null || hostFaults.size > 0) {
          fail('branch-completed-after-cancel', { branch: event.branch })
        }
        state.set(event.branch, 'completed')
      } else if (event.kind === 'branch-cancelled') {
        exactFields(event, ['branch', 'kind', 'ordinal', 'reason'], 'branch-cancelled-event')
        traceBranch(event.branch, state)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        if (state.get(event.branch) !== 'spawned') fail('branch-terminal-state-repeated')
        requireCompleteBeforeJoinSettled(event.branch, effects)
        const expected = expectedBranchCancelReasons(firstCancel, hostFaults)
        if (!expected.includes(event.reason)) {
          fail('branch-cancellation-reason-mismatch', { branch: event.branch })
        }
        cancelReasons.add(event.reason)
        state.set(event.branch, 'cancelled')
      } else if (event.kind === 'branch-host-fault') {
        exactFields(event, ['branch', 'fault_ref', 'kind', 'ordinal'], 'branch-host-fault-event')
        traceBranch(event.branch, state)
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        named(event.fault_ref, 'invalid-host-fault-reference')
        if (state.get(event.branch) !== 'spawned') fail('branch-terminal-state-repeated')
        hostFaults.add(event.branch)
        state.set(event.branch, 'host-fault')
      } else if (event.kind === 'region-exit') {
        exactFields(event, ['kind', 'ordinal', 'outcome'], 'region-exit-event')
        spawningClosed = true
        requireAllSpawned(pendingBranches, state)
        const unsettled = [...state].filter(([, value]) => value === 'spawned')
        if (unsettled.length > 0) {
          fail('region-exit-before-children-settle', {
            branches: unsettled.map(([branch]) => branch).sort(compareText),
          })
        }
        const expected = expectedRegionOutcome(state, hostFaults)
        if (event.outcome !== expected) fail('region-exit-outcome-mismatch')
        exit = event.outcome
      } else {
        fail('unsupported-concurrency-trace-event', { kind: event.kind })
      }
    }
    if (exit === null) fail('missing-region-exit')
    return {
      ok: true,
      summary: {
        branch_count: shape.branches.length,
        complete_before_join_effects: completeBeforeJoinEffects.sort(compareEffectEvidence),
        cancel_reasons: [...cancelReasons].sort(compareText),
        host_fault_branches: [...hostFaults].sort(compareText),
        outcome: exit,
        region_id: shape.regionId,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-concurrency-trace' }],
      ok: false,
    }
  }
}

function validLatency(value) {
  return Number.isInteger(value) && value >= 0
}

function verifyNestedConcurrencyTrace(shape, trace) {
  const runtime = new Map([...shape.regions].map(([key, region]) => [key, {
    cancelReasons: new Set(),
    completeBeforeJoinEffects: [],
    effects: new Map(region.branches.map((branch) => [
      branch,
      new Map(region.effectsByBranch.get(branch).map((effect) => [
        effect.effect,
        { ...effect, cancel_latency_ms: null, state: 'pending' },
      ])),
    ])),
    exit: null,
    firstCancel: null,
    hostFaults: new Set(),
    pendingBranches: region.branches.length,
    region,
    spawningClosed: false,
    state: new Map(region.branches.map((branch) => [branch, 'pending'])),
  }]))
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index]
    assertObject(event, 'invalid-concurrency-trace-event')
    if (event.ordinal !== index) fail('non-contiguous-concurrency-trace-ordinal')
    const scope = scopeKeyFromTraceEvent(shape, event)
    const regionState = runtime.get(scope.key)
    const rootState = runtime.get(shape.rootKey)
    if (rootState.exit !== null) traceFail('event-after-region-exit', event, scope)
    if (regionState.exit !== null) traceFail('event-after-region-exit', event, scope)
    if (
      scope.key !== shape.rootKey
      && regionState.firstCancel === null
      && ancestorCancelled(shape, runtime, scope.key)
    ) {
      if (event.kind !== 'region-cancel' || event.reason !== 'parent') {
        traceFail('nested-region-missing-parent-cancel', event, scope)
      }
    }
    if (
      scope.key !== shape.rootKey
      && event.kind === 'region-cancel'
      && event.reason === 'parent'
      && !ancestorCancelled(shape, runtime, scope.key)
    ) {
      traceFail('nested-region-parent-cancel-without-ancestor', event, scope)
    }
    applyScopedTraceEvent(regionState, runtime, scope, event)
  }
  for (const [key, regionState] of runtime) {
    if (regionState.exit === null) traceFail('missing-region-exit', { ordinal: trace.events.length }, {
      key,
      regionId: regionState.region.regionId,
      scopePath: regionState.region.scopePath,
    })
  }
  const root = runtime.get(shape.rootKey)
  return {
    ok: true,
    summary: {
      branch_count: root.region.branches.length,
      complete_before_join_effects: root.completeBeforeJoinEffects.sort(compareEffectEvidence),
      cancel_reasons: [...root.cancelReasons].sort(compareText),
      host_fault_branches: [...root.hostFaults].sort(compareText),
      nested_regions: [...runtime.entries()]
        .filter(([key]) => key !== shape.rootKey)
        .map(([, state]) => ({
          branch_count: state.region.branches.length,
          cancel_reasons: [...state.cancelReasons].sort(compareText),
          outcome: state.exit,
          region_id: state.region.regionId,
          scope_path: state.region.scopePath,
        }))
        .sort(compareNestedRegionSummary),
      outcome: root.exit,
      region_id: shape.regionId,
    },
  }
}

function applyScopedTraceEvent(regionState, runtime, scope, event) {
  if (event.kind === 'branch-spawn') {
    exactFields(event, ['branch', 'kind', 'ordinal', 'scope_path'], 'branch-spawn-event', {
      optional: ['scope_path'],
    })
    traceBranch(event.branch, regionState.state)
    if (regionState.spawningClosed) traceFail('late-branch-spawn', event, scope, {
      branch: event.branch,
    })
    if (regionState.state.get(event.branch) !== 'pending') traceFail('duplicate-branch-spawn', event, scope)
    regionState.state.set(event.branch, 'spawned')
    regionState.pendingBranches -= 1
  } else if (event.kind === 'effect-start') {
    exactFields(event, ['branch', 'effect', 'kind', 'ordinal', 'scope_path'], 'effect-start-event', {
      optional: ['scope_path'],
    })
    const effect = traceScopedEffect(regionState, event, scope)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (regionState.state.get(event.branch) !== 'spawned') traceFail('effect-start-after-branch-terminal', event, scope)
    if (effect.state !== 'pending') traceFail('effect-lifecycle-repeated', event, scope, {
      branch: event.branch,
      effect: event.effect,
    })
    effect.state = 'started'
  } else if (event.kind === 'effect-complete') {
    exactFields(event, [
      'branch', 'cancel_latency_ms', 'effect', 'kind', 'ordinal', 'scope_path',
    ], 'effect-complete-event', { optional: ['scope_path'] })
    const effect = traceScopedEffect(regionState, event, scope)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (regionState.state.get(event.branch) !== 'spawned') traceFail('effect-complete-after-branch-terminal', event, scope)
    if (effect.state !== 'started') traceFail('effect-complete-without-start', event, scope, {
      branch: event.branch,
      effect: event.effect,
    })
    const afterCancel = regionState.firstCancel !== null || regionState.hostFaults.size > 0
    if (afterCancel && effect.cancellation !== 'complete-before-join') {
      traceFail('cooperative-effect-completed-after-cancel', event, scope, {
        branch: event.branch,
        effect: event.effect,
      })
    }
    if (afterCancel) {
      if (!validLatency(event.cancel_latency_ms)) {
        traceFail('invalid-complete-before-join-cancel-latency', event, scope, {
          branch: event.branch,
          effect: event.effect,
        })
      }
      effect.cancel_latency_ms = event.cancel_latency_ms
      regionState.completeBeforeJoinEffects.push({
        branch: event.branch,
        cancel_latency_ms: event.cancel_latency_ms,
        effect: event.effect,
      })
    } else if (event.cancel_latency_ms !== null) {
      traceFail('unexpected-effect-cancel-latency', event, scope, {
        branch: event.branch,
        effect: event.effect,
      })
    }
    effect.state = 'completed'
  } else if (event.kind === 'effect-cancelled') {
    exactFields(event, ['branch', 'effect', 'kind', 'ordinal', 'scope_path'], 'effect-cancelled-event', {
      optional: ['scope_path'],
    })
    const effect = traceScopedEffect(regionState, event, scope)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (regionState.state.get(event.branch) !== 'spawned') {
      traceFail('effect-cancelled-after-branch-terminal', event, scope)
    }
    if (effect.state !== 'started') {
      traceFail('effect-cancelled-without-start', event, scope, {
        branch: event.branch,
        effect: event.effect,
      })
    }
    if (effect.cancellation !== 'cooperative') {
      traceFail('complete-before-join-effect-cancelled', event, scope, {
        branch: event.branch,
        effect: event.effect,
      })
    }
    effect.state = 'cancelled'
  } else if (event.kind === 'region-cancel') {
    exactFields(event, ['kind', 'ordinal', 'reason', 'scope_path'], 'region-cancel-event', {
      optional: ['scope_path'],
    })
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (!['deadline', 'parent'].includes(event.reason)) traceFail('invalid-region-cancel-reason', event, scope)
    if (regionState.firstCancel !== null) traceFail('duplicate-region-cancel', event, scope)
    if (![...regionState.state.values()].includes('spawned')) traceFail('cancel-after-children-settle', event, scope)
    regionState.firstCancel = event.reason
    regionState.cancelReasons.add(event.reason)
  } else if (event.kind === 'branch-complete') {
    exactFields(event, ['branch', 'kind', 'ordinal', 'scope_path'], 'branch-complete-event', {
      optional: ['scope_path'],
    })
    traceBranch(event.branch, regionState.state)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (regionState.state.get(event.branch) !== 'spawned') traceFail('branch-terminal-state-repeated', event, scope)
    requireStartedEffectsSettled(event.branch, regionState.effects)
    requireNestedRegionsSettled(regionState, runtime, event, scope)
    if (regionState.firstCancel !== null || regionState.hostFaults.size > 0) {
      traceFail('branch-completed-after-cancel', event, scope, { branch: event.branch })
    }
    regionState.state.set(event.branch, 'completed')
  } else if (event.kind === 'branch-cancelled') {
    exactFields(event, ['branch', 'kind', 'ordinal', 'reason', 'scope_path'], 'branch-cancelled-event', {
      optional: ['scope_path'],
    })
    traceBranch(event.branch, regionState.state)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    if (regionState.state.get(event.branch) !== 'spawned') traceFail('branch-terminal-state-repeated', event, scope)
    requireCompleteBeforeJoinSettled(event.branch, regionState.effects)
    requireNestedRegionsSettled(regionState, runtime, event, scope)
    const expected = expectedBranchCancelReasons(regionState.firstCancel, regionState.hostFaults)
    if (!expected.includes(event.reason)) {
      traceFail('branch-cancellation-reason-mismatch', event, scope, { branch: event.branch })
    }
    regionState.cancelReasons.add(event.reason)
    regionState.state.set(event.branch, 'cancelled')
  } else if (event.kind === 'branch-host-fault') {
    exactFields(event, ['branch', 'fault_ref', 'kind', 'ordinal', 'scope_path'], 'branch-host-fault-event', {
      optional: ['scope_path'],
    })
    traceBranch(event.branch, regionState.state)
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    named(event.fault_ref, 'invalid-host-fault-reference')
    if (regionState.state.get(event.branch) !== 'spawned') traceFail('branch-terminal-state-repeated', event, scope)
    requireNestedRegionsSettled(regionState, runtime, event, scope)
    regionState.hostFaults.add(event.branch)
    regionState.state.set(event.branch, 'host-fault')
  } else if (event.kind === 'region-exit') {
    exactFields(event, ['kind', 'ordinal', 'outcome', 'scope_path'], 'region-exit-event', {
      optional: ['scope_path'],
    })
    regionState.spawningClosed = true
    requireAllSpawned(regionState.pendingBranches, regionState.state)
    const unsettled = [...regionState.state].filter(([, value]) => value === 'spawned')
    if (unsettled.length > 0) {
      traceFail('region-exit-before-children-settle', event, scope, {
        branches: unsettled.map(([branch]) => branch).sort(compareText),
      })
    }
    const expected = expectedRegionOutcome(regionState.state, regionState.hostFaults)
    if (event.outcome !== expected) traceFail('region-exit-outcome-mismatch', event, scope)
    regionState.exit = event.outcome
  } else {
    traceFail('unsupported-concurrency-trace-event', event, scope, { kind: event.kind })
  }
}

function scopeKeyFromTraceEvent(shape, event) {
  if (event.scope_path === undefined) {
    return {
      key: shape.rootKey,
      regionId: shape.regionId,
      scopePath: [shape.regionId],
    }
  }
  if (!Array.isArray(event.scope_path) || event.scope_path.length === 0) {
    fail('invalid-concurrency-trace-scope-path', { ordinal: event.ordinal })
  }
  for (const segment of event.scope_path) named(segment, 'invalid-concurrency-trace-scope-path')
  for (const [key, region] of shape.regions) {
    if (same(region.scopePath, event.scope_path)) {
      return { key, regionId: region.regionId, scopePath: region.scopePath }
    }
  }
  fail('concurrency-trace-scope-not-found', { ordinal: event.ordinal, scope_path: event.scope_path })
}

function traceScopedEffect(regionState, event, scope) {
  traceBranch(event.branch, regionState.state)
  named(event.effect, 'invalid-concurrency-trace-effect')
  const effect = regionState.effects.get(event.branch).get(event.effect)
  if (effect === undefined) {
    traceFail('concurrency-trace-effect-not-found', event, scope, {
      branch: event.branch,
      effect: event.effect,
    })
  }
  return effect
}

function requireNestedRegionsSettled(regionState, runtime, event, scope) {
  const children = regionState.region.childRegionsByBranch.get(event.branch)
  const unsettled = children.filter((key) => runtime.get(key).exit === null)
  if (unsettled.length > 0) {
    traceFail('branch-terminal-before-nested-region-exit', event, scope, {
      branch: event.branch,
      nested_regions: unsettled.map((key) => runtime.get(key).region.scopePath),
    })
  }
}

function ancestorCancelled(shape, runtime, key) {
  let cursor = key
  while (cursor !== shape.rootKey) {
    const parent = parentRegionForKey(cursor)
    const parentState = runtime.get(parent.regionKey)
    if (parentState.firstCancel !== null || parentState.hostFaults.size > 0) return true
    cursor = parent.regionKey
  }
  return false
}

function traceFail(code, event, scope, details = {}) {
  fail(code, {
    ...details,
    ordinal: event.ordinal,
    region_id: scope.regionId,
    scope_path: scope.scopePath,
  })
}

function expectedBranchCancelReasons(firstCancel, hostFaults) {
  const reasons = []
  if (firstCancel !== null) reasons.push(firstCancel)
  if (hostFaults.size > 0) reasons.push('host-fault')
  return reasons
}

function expectedRegionOutcome(state, hostFaults) {
  if (hostFaults.size > 0) return 'host-fault'
  const terminals = [...state.values()]
  if (terminals.every((value) => value === 'cancelled')) return 'cancelled'
  return 'joined'
}

function planShape(plan) {
  assertObject(plan, 'invalid-concurrency-plan')
  if (
    plan.schema !== PLAN_SCHEMA
    || plan.construct !== 'par'
    || !Array.isArray(plan.nodes)
    || !Array.isArray(plan.edges)
  ) {
    fail('invalid-concurrency-plan')
  }
  if (typeof plan.output !== 'string' || !plan.output.endsWith('.join')) {
    fail('invalid-concurrency-plan-output')
  }
  const regionNodes = plan.nodes.filter(({ kind }) => kind === 'par-region')
  const joinNodes = plan.nodes.filter(({ kind }) => kind === 'join')
  if (regionNodes.length === 0 || joinNodes.length === 0) fail('invalid-concurrency-plan-shape')
  const joinById = new Map(joinNodes.map((join) => [join.id, join]))
  const rootKey = plan.output.slice(0, -'.join'.length)
  const regions = new Map()
  for (const region of regionNodes) {
    if (typeof region.id !== 'string') fail('invalid-concurrency-plan-region')
    const join = joinById.get(`${region.id}.join`)
    if (join === undefined || !Array.isArray(join.members)) fail('invalid-concurrency-plan-shape')
    if (!same(region.policy, concurrencyPolicy())) fail('invalid-concurrency-plan-policy')
    const scopePath = scopePathFromRegionKey(region.id)
    const branchPrefix = `${region.id}.branch.`
    const tasks = plan.nodes.filter(({ kind, id }) => (
      kind === 'task-scope'
      && typeof id === 'string'
      && id.startsWith(branchPrefix)
      && !id.slice(branchPrefix.length).includes('.')
    ))
    const taskBranches = tasks.map(({ id }) => id.slice(branchPrefix.length)).sort(compareText)
    const members = uniqueNames(join.members, 'concurrency-plan-branch')
    if (!same(taskBranches, members)) fail('concurrency-plan-join-membership-mismatch')
    const effectsByBranch = new Map(members.map((branch) => [branch, []]))
    const childRegionsByBranch = new Map(members.map((branch) => [branch, []]))
    for (const node of plan.nodes) {
      if (node.kind !== 'effect-occurrence') continue
      if (typeof node.id !== 'string') fail('invalid-concurrency-plan-effect')
      const branch = members.find((member) => node.id.startsWith(`${branchPrefix}${member}.effect.`))
      if (branch === undefined) continue
      const effect = node.id.slice(`${branchPrefix}${branch}.effect.`.length)
      if (effect.includes('.')) continue
      named(effect, 'invalid-concurrency-plan-effect')
      if (!CANCELLATION_MODES.includes(node.cancellation)) fail('invalid-concurrency-plan-effect')
      effectsByBranch.get(branch).push({
        branch,
        cancellation: node.cancellation,
        effect,
      })
    }
    for (const effects of effectsByBranch.values()) {
      effects.sort(compareEffectEvidence)
    }
    regions.set(region.id, {
      branches: members,
      childRegionsByBranch,
      effectsByBranch,
      key: region.id,
      regionId: scopePath.at(-1),
      scopePath,
    })
  }
  if (!regions.has(rootKey)) fail('invalid-concurrency-plan-output')
  for (const key of regions.keys()) {
    if (key === rootKey) continue
    const parent = parentRegionForKey(key)
    const parentShape = regions.get(parent.regionKey)
    if (parentShape === undefined || !parentShape.branches.includes(parent.branch)) {
      fail('invalid-nested-concurrency-plan-region')
    }
    parentShape.childRegionsByBranch.get(parent.branch).push(key)
  }
  for (const shape of regions.values()) {
    for (const children of shape.childRegionsByBranch.values()) children.sort(compareText)
  }
  for (const shape of regions.values()) validateRegionEdges(plan, shape)
  const root = regions.get(rootKey)
  return {
    branches: root.branches,
    effectsByBranch: root.effectsByBranch,
    regionId: root.regionId,
    regions,
    rootKey,
  }
}

function validateRegionEdges(plan, shape) {
  const spawnCounts = new Map(shape.branches.map((branch) => [branch, 0]))
  const joinCounts = new Map(shape.branches.map((branch) => [branch, 0]))
  const branchPrefix = `${shape.key}.branch.`
  for (const edge of plan.edges) {
    if (
      edge.kind === 'spawn'
      && spawnCounts.has(edge.branch)
      && edge.from === shape.key
      && edge.to === `${branchPrefix}${edge.branch}`
    ) spawnCounts.set(edge.branch, spawnCounts.get(edge.branch) + 1)
    if (
      edge.kind === 'join'
      && joinCounts.has(edge.branch)
      && edge.to === `${shape.key}.join`
    ) {
      const taskId = `${branchPrefix}${edge.branch}`
      if (edge.from === taskId || edge.from.startsWith(`${taskId}.effect.`) || edge.from.startsWith(`${taskId}.par.`)) {
        joinCounts.set(edge.branch, joinCounts.get(edge.branch) + 1)
      }
    }
  }
  for (const branch of shape.branches) {
    if (spawnCounts.get(branch) !== 1 || joinCounts.get(branch) !== 1) {
      fail('concurrency-plan-branch-edge-mismatch', { branch, region_id: shape.regionId })
    }
  }
}

function scopePathFromRegionKey(key) {
  const parts = key.split('.')
  if (parts.length < 2 || parts[0] !== 'par') fail('invalid-concurrency-plan-region')
  const scopePath = [parts[1]]
  let index = 2
  while (index < parts.length) {
    if (parts[index] !== 'branch' || parts[index + 2] !== 'par') {
      fail('invalid-concurrency-plan-region')
    }
    scopePath.push(parts[index + 1], parts[index + 3])
    index += 4
  }
  return scopePath
}

function parentRegionForKey(key) {
  const marker = '.branch.'
  const lastBranch = key.lastIndexOf(marker)
  const lastPar = key.lastIndexOf('.par.')
  if (lastBranch < 0 || lastPar < lastBranch) fail('invalid-nested-concurrency-plan-region')
  return {
    branch: key.slice(lastBranch + marker.length, lastPar),
    regionKey: key.slice(0, lastBranch),
  }
}

function traceBranch(branch, state) {
  if (!state.has(branch)) fail('concurrency-trace-branch-not-found', { branch })
}

function traceEffect(branch, effect, effects) {
  named(effect, 'invalid-concurrency-trace-effect')
  const branchEffects = effects.get(branch)
  const result = branchEffects.get(effect)
  if (result === undefined) {
    fail('concurrency-trace-effect-not-found', { branch, effect })
  }
  return result
}

function requireStartedEffectsSettled(branch, effects) {
  const unsettled = [...effects.get(branch).values()]
    .filter((effect) => effect.state === 'started')
    .map(({ effect }) => effect)
    .sort(compareText)
  if (unsettled.length > 0) {
    fail('branch-terminal-before-effect-settle', { branch, effects: unsettled })
  }
}

function requireCompleteBeforeJoinSettled(branch, effects) {
  const unsettled = [...effects.get(branch).values()]
    .filter((effect) => (
      effect.cancellation === 'complete-before-join'
      && effect.state === 'started'
    ))
    .map(({ effect }) => effect)
    .sort(compareText)
  if (unsettled.length > 0) {
    fail('complete-before-join-effect-not-settled', { branch, effects: unsettled })
  }
  requireStartedEffectsSettled(branch, effects)
}

function requireAllSpawned(pendingCount, state) {
  if (pendingCount > 0) {
    const pending = [...state].filter(([, value]) => value === 'pending')
    fail('concurrency-trace-before-all-spawned', {
      branches: pending.map(([branch]) => branch).sort(compareText),
    })
  }
}

function lowerPar(regionInput) {
  return buildPlan(normalizeParRegion(regionInput))
}

function normalizeParRegion(regionInput) {
  assertObject(regionInput, 'invalid-par-region')
  exactFields(regionInput, [
    'branches', 'cancel_reason_type', 'deadline', 'handles', 'id', 'join_type',
    'task_outcome_digest',
  ], 'par-region')
  named(regionInput.id, 'invalid-par-region-id')
  const deadline = normalizeDeadline(regionInput.deadline)
  const cancelReasonType = normalizeDeclaredType(
    regionInput.cancel_reason_type,
    'cancel-reason-type',
  )
  const joinType = normalizeDeclaredType(regionInput.join_type, 'par-join-type')
  if (!DIGEST.test(regionInput.task_outcome_digest)) {
    fail('invalid-task-outcome-declaration-digest')
  }
  if (!Array.isArray(regionInput.branches) || regionInput.branches.length < 2) {
    fail('par-requires-two-branches')
  }
  const branchIds = new Set()
  const branches = regionInput.branches.map((branch) => {
    const normalized = normalizeBranch(branch)
    if (branchIds.has(normalized.id)) fail('duplicate-par-branch', { branch: normalized.id })
    branchIds.add(normalized.id)
    return normalized
  }).sort(compareId)
  const handles = normalizeHandles(regionInput.handles, branchIds)
  validateBranchIdentities(branches)
  validateHandleUses(handles, branches)
  validateResourceConflicts(branches)
  return {
    branches,
    cancelReasonType,
    deadline,
    handles,
    joinType,
    regionId: regionInput.id,
    taskOutcomeDigest: regionInput.task_outcome_digest,
  }
}

function normalizeDeclaredType(input, label) {
  assertObject(input, `invalid-${label}`)
  exactFields(input, ['arguments', 'declaration_digest', 'kind'], label)
  if (input.kind !== 'declared' || !DIGEST.test(input.declaration_digest)) {
    fail(`invalid-${label}`)
  }
  if (!Array.isArray(input.arguments)) fail(`invalid-${label}-arguments`)
  return {
    arguments: canonicalValue(input.arguments),
    declaration_digest: input.declaration_digest,
    kind: 'declared',
  }
}

function normalizeDeadline(input) {
  if (input === null) return null
  assertObject(input, 'invalid-par-deadline')
  exactFields(input, ['endpoint', 'type'], 'par-deadline')
  named(input.endpoint, 'invalid-par-deadline-endpoint')
  if (input.type !== 'time.monotonic_instant') fail('invalid-par-deadline-type')
  return { endpoint: input.endpoint, type: input.type }
}

function normalizeBranch(input) {
  assertObject(input, 'invalid-par-branch')
  exactFields(input, [
    'control_path', 'effects', 'id', 'identity', 'nested_regions', 'output_type',
  ], 'par-branch', {
    optional: ['control_path', 'identity', 'nested_regions'],
  })
  named(input.id, 'invalid-par-branch-id')
  if (input.id === 'parent') fail('reserved-par-branch-id')
  if (input.output_type === undefined) fail('missing-par-branch-output-type')
  const controlPath = Object.hasOwn(input, 'control_path')
    ? normalizeControlPath(input.control_path)
    : null
  const identity = Object.hasOwn(input, 'identity')
    ? normalizeBranchIdentity(input.identity)
    : null
  if (!Array.isArray(input.effects)) fail('invalid-branch-effect-set', { branch: input.id })
  const effectIds = new Set()
  const effects = input.effects.map((effect) => {
    const normalized = normalizeEffect(effect)
    if (effectIds.has(normalized.id)) {
      fail('duplicate-branch-effect', { branch: input.id, effect: normalized.id })
    }
    effectIds.add(normalized.id)
    return normalized
  })
  const orderedEffects = orderEffects(input.id, effects, effectIds)
  const nestedRegions = normalizeNestedRegions(input.nested_regions ?? [])
  return {
    control_path: controlPath,
    effects: orderedEffects,
    id: input.id,
    identity,
    nested_regions: nestedRegions,
    output_type: canonicalValue(input.output_type),
  }
}

function normalizeBranchIdentity(input) {
  assertObject(input, 'invalid-par-branch-identity')
  exactFields(input, ['graph_revision', 'uid'], 'par-branch-identity')
  if (!isValidUid(input.uid)) fail('invalid-par-branch-identity-uid', { uid: input.uid })
  if (!DIGEST.test(input.graph_revision)) {
    fail('invalid-par-branch-identity-revision', { graph_revision: input.graph_revision })
  }
  return {
    graph_revision: input.graph_revision,
    uid: input.uid,
  }
}

function validateBranchIdentities(branches) {
  const identities = branches.filter((branch) => branch.identity !== null)
  if (identities.length === 0) return
  if (identities.length !== branches.length) fail('missing-par-branch-identity')
  const revisions = new Set(identities.map((branch) => branch.identity.graph_revision))
  if (revisions.size !== 1) fail('par-branch-identity-revision-mismatch')
  const seen = new Set()
  for (const branch of identities) {
    const uid = branch.identity.uid
    if (seen.has(uid)) fail('duplicate-par-branch-identity', { uid })
    seen.add(uid)
  }
}

function normalizeNestedRegions(input) {
  if (!Array.isArray(input)) fail('invalid-nested-par-region-set')
  const ids = new Set()
  const regions = input.map((region) => {
    const normalized = normalizeParRegion(region)
    if (ids.has(normalized.regionId)) fail('duplicate-nested-par-region', {
      region: normalized.regionId,
    })
    ids.add(normalized.regionId)
    return normalized
  })
  return regions.sort((left, right) => compareText(left.regionId, right.regionId))
}

function normalizeEffect(input) {
  assertObject(input, 'invalid-branch-effect')
  exactFields(input, [
    'after', 'cancellation', 'control_path', 'footprint', 'id', 'operation_digest',
  ], 'branch-effect', { optional: ['control_path'] })
  if (Object.hasOwn(input, 'control_path')) {
    fail('unprojected-match-effect-path', { effect: input.id })
  }
  named(input.id, 'invalid-branch-effect-id')
  if (!DIGEST.test(input.operation_digest)) fail('effect-requires-exact-operation')
  if (!CANCELLATION_MODES.includes(input.cancellation)) {
    fail('invalid-effect-cancellation-mode', { effect: input.id })
  }
  const after = uniqueNames(input.after, 'effect-order-dependency', true)
  if (!Array.isArray(input.footprint) || input.footprint.length === 0) {
    fail('effect-requires-resource-footprint', { effect: input.id })
  }
  const accessesByKey = new Map()
  for (const access of input.footprint) {
    const normalized = normalizeAccess(access)
    const key = `${normalized.mode}:${normalized.handle ?? ''}:${resourceKey(normalized.resource)}`
    if (accessesByKey.has(key)) fail('duplicate-resource-access', { effect: input.id })
    accessesByKey.set(key, normalized)
  }
  return {
    after,
    cancellation: input.cancellation,
    footprint: [...accessesByKey.values()].sort(compareAccessShape),
    id: input.id,
    operation_digest: input.operation_digest,
  }
}

function normalizeControlPath(input) {
  if (!Array.isArray(input) || input.length === 0) fail('invalid-branch-control-path')
  const path = input.map((segment) => {
    named(segment, 'invalid-branch-control-path')
    return segment
  })
  return path
}

function normalizeAccess(input) {
  assertObject(input, 'invalid-resource-access')
  exactFields(input, ['handle', 'mode', 'resource'], 'resource-access')
  if (!ACCESS_MODES.includes(input.mode)) fail('invalid-resource-access-mode')
  if (input.handle !== null) named(input.handle, 'invalid-resource-handle-reference')
  assertObject(input.resource, 'invalid-resource-key')
  exactFields(input.resource, ['domain_digest', 'segments'], 'resource-key')
  if (!DIGEST.test(input.resource.domain_digest)) fail('invalid-resource-domain-digest')
  let segments = null
  if (input.resource.segments !== null) {
    if (!Array.isArray(input.resource.segments)) fail('invalid-resource-key-segments')
    segments = input.resource.segments.map((segment) => {
      assertObject(segment, 'invalid-resource-key-segment')
      exactFields(segment, ['canonical_hex', 'type_digest'], 'resource-key-segment')
      if (!DIGEST.test(segment.type_digest) || !CANONICAL_HEX.test(segment.canonical_hex)) {
        fail('invalid-resource-key-segment')
      }
      return {
        canonical_hex: segment.canonical_hex,
        type_digest: segment.type_digest,
      }
    })
  }
  return {
    handle: input.handle,
    mode: input.mode,
    resource: { domain_digest: input.resource.domain_digest, segments },
  }
}

function orderEffects(branch, effects, effectIds) {
  const byId = new Map(effects.map((effect) => [effect.id, effect]))
  const outgoing = new Map(effects.map((effect) => [effect.id, []]))
  const indegree = new Map(effects.map((effect) => [effect.id, 0]))
  for (const effect of effects) {
    for (const dependency of effect.after) {
      if (!effectIds.has(dependency)) {
        fail('cross-branch-or-unknown-effect-order', { branch, dependency, effect: effect.id })
      }
      if (dependency === effect.id) fail('effect-order-cycle', { branch })
      outgoing.get(dependency).push(effect.id)
      indegree.set(effect.id, indegree.get(effect.id) + 1)
    }
  }
  const ready = effects.filter(({ id }) => indegree.get(id) === 0).map(({ id }) => id)
    .sort(compareText)
  const ordered = []
  while (ready.length > 0) {
    if (ready.length > 1) {
      fail('unordered-effects-in-par-branch', { branch, effects: [...ready] })
    }
    const id = ready.shift()
    ordered.push(byId.get(id))
    for (const target of outgoing.get(id).sort(compareText)) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) insertSorted(ready, target)
    }
  }
  if (ordered.length !== effects.length) fail('effect-order-cycle', { branch })
  return ordered.map(({ after: _after, ...effect }) => effect)
}

function normalizeHandles(input, branchIds) {
  if (!Array.isArray(input)) fail('invalid-resource-handle-set')
  const handles = new Map()
  for (const handle of input) {
    assertObject(handle, 'invalid-resource-handle')
    exactFields(handle, [
      'closed_by', 'escapes', 'id', 'owner', 'used_by',
    ], 'resource-handle')
    named(handle.id, 'invalid-resource-handle-id')
    if (handles.has(handle.id)) fail('duplicate-resource-handle', { handle: handle.id })
    if (handle.owner !== 'parent' && !branchIds.has(handle.owner)) {
      fail('resource-handle-owner-not-found', { handle: handle.id })
    }
    const usedBy = uniqueNames(handle.used_by, 'resource-handle-user', true)
    if (usedBy.some((branch) => !branchIds.has(branch))) {
      fail('resource-handle-user-not-found', { handle: handle.id })
    }
    if (handle.escapes !== false) fail('child-resource-escape', { handle: handle.id })
    if (handle.owner === 'parent') {
      if (handle.closed_by !== null) fail('parent-resource-closed-by-child', { handle: handle.id })
    } else {
      if (!same(usedBy, [handle.owner]) || handle.closed_by !== handle.owner) {
        fail('child-resource-lifetime-violation', { handle: handle.id })
      }
    }
    handles.set(handle.id, {
      closed_by: handle.closed_by,
      escapes: false,
      id: handle.id,
      owner: handle.owner,
      used_by: usedBy,
    })
  }
  return handles
}

function validateHandleUses(handles, branches) {
  const actualUsers = new Map([...handles.keys()].map((id) => [id, new Set()]))
  for (const branch of branches) {
    for (const effect of branch.effects) {
      for (const access of effect.footprint) {
        if (access.handle === null) continue
        const handle = handles.get(access.handle)
        if (handle === undefined) {
          fail('resource-handle-not-found', { effect: effect.id, handle: access.handle })
        }
        if (!handle.used_by.includes(branch.id)) {
          fail('undeclared-resource-handle-use', { branch: branch.id, handle: access.handle })
        }
        actualUsers.get(access.handle).add(branch.id)
      }
    }
  }
  for (const handle of handles.values()) {
    if (!same([...actualUsers.get(handle.id)].sort(compareText), handle.used_by)) {
      fail('resource-handle-use-mismatch', { handle: handle.id })
    }
  }
}

function validateResourceConflicts(branches) {
  const accesses = []
  for (const branch of branches) {
    for (const effect of branch.effects) {
      for (const access of effect.footprint) {
        accesses.push({ ...access, branch: branch.id, effect: effect.id })
      }
    }
  }
  accesses.sort(compareAccessOccurrence)
  const domains = new Map()
  for (const access of accesses) {
    const root = domains.get(access.resource.domain_digest) ?? trieNode()
    domains.set(access.resource.domain_digest, root)
    const path = access.resource.segments ?? []
    let node = root
    checkExistingAccesses(node.accesses, access)
    for (const segment of path) {
      const segmentKey = stableJson(segment)
      node.children.set(segmentKey, node.children.get(segmentKey) ?? trieNode())
      node = node.children.get(segmentKey)
      checkExistingAccesses(node.accesses, access)
    }
    node.accesses.push(access)
  }
}

function checkExistingAccesses(existing, current) {
  for (const previous of existing) {
    if (
      previous.branch !== current.branch
      && (previous.mode === 'write' || current.mode === 'write')
    ) {
      fail('parallel-resource-conflict', {
        branches: [previous.branch, current.branch].sort(compareText),
        effects: [previous.effect, current.effect].sort(compareText),
        resource_domain: current.resource.domain_digest,
      })
    }
  }
}

function buildPlan(region) {
  const nodes = []
  const edges = []
  const output = appendRegionPlan(region, `par.${region.regionId}`, nodes, edges)
  return {
    construct: 'par',
    edges: edges.sort(compareShape),
    nodes: nodes.sort(compareId),
    output,
    schema: PLAN_SCHEMA,
  }
}

function appendRegionPlan({
  branches, cancelReasonType, deadline, handles, joinType, regionId, taskOutcomeDigest,
}, prefix, nodes, edges) {
  nodes.push({
    deadline,
    id: prefix,
    kind: 'par-region',
    policy: concurrencyPolicy(),
  })
  for (const handle of [...handles.values()].sort(compareId)) {
    nodes.push({ ...handle, id: `${prefix}.handle.${handle.id}`, kind: 'resource-handle' })
  }
  for (const branch of branches) {
    const branchId = `${prefix}.branch.${branch.id}`
    nodes.push({
      ...(branch.control_path === null ? {} : { control_path: branch.control_path }),
      id: branchId,
      ...(branch.identity === null ? {} : { identity: branch.identity }),
      kind: 'task-scope',
      output_type: taskOutcome(branch.output_type, taskOutcomeDigest, cancelReasonType),
    })
    edges.push({ branch: branch.id, from: prefix, kind: 'spawn', to: branchId })
    let previous = branchId
    for (const effect of branch.effects) {
      const effectId = `${branchId}.effect.${effect.id}`
      nodes.push({ ...effect, id: effectId, kind: 'effect-occurrence' })
      edges.push({ from: previous, kind: 'order', to: effectId })
      previous = effectId
    }
    for (const nested of branch.nested_regions) {
      const nestedPrefix = `${branchId}.par.${nested.regionId}`
      edges.push({ from: previous, kind: 'order', to: nestedPrefix })
      previous = appendRegionPlan(nested, nestedPrefix, nodes, edges)
    }
    edges.push({ branch: branch.id, from: previous, kind: 'join', to: `${prefix}.join` })
  }
  const memberTypes = branches.map((branch) => ({
    branch: branch.id,
    type: taskOutcome(branch.output_type, taskOutcomeDigest, cancelReasonType),
  }))
  nodes.push({
    id: `${prefix}.join`,
    kind: 'join',
    members: branches.map(({ id }) => id),
    member_types: memberTypes,
    output_type: joinType,
  })
  return `${prefix}.join`
}

function concurrencyPolicy() {
  return {
    branch_error: 'collect-as-value',
    cancel_propagation: 'downward',
    detach: false,
    host_fault: 'cancel-siblings-join-cleanup-propagate',
    retry: 'explicit-loop-only',
  }
}

function taskOutcome(completed, declarationDigest, cancelReasonType) {
  return {
    arguments: [completed, cancelReasonType],
    declaration_digest: declarationDigest,
    kind: 'declared',
  }
}

function exactFields(value, allowed, label, { optional = [] } = {}) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail(`unexpected-${label}-field`, { field })
  }
  for (const field of allowed) {
    if (optional.includes(field) && !Object.hasOwn(value, field)) continue
    if (!Object.hasOwn(value, field)) fail(`missing-${label}-field`, { field })
  }
}

function uniqueNames(input, label, allowEmpty = false) {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) fail(`invalid-${label}-set`)
  const values = [...input]
  for (const value of values) named(value, `invalid-${label}`)
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`)
  return values.sort(compareText)
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function named(value, code) {
  if (typeof value !== 'string' || !ID.test(value)) fail(code, { value })
}

function same(left, right) {
  return stableJson(left) === stableJson(right)
}

function canonicalValue(value, visiting = new Set()) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, visiting))
  if (value !== null && typeof value === 'object') {
    if (visiting.has(value)) fail('cyclic-concurrency-contract-value')
    visiting.add(value)
    const result = Object.fromEntries(Object.keys(value).sort(compareText).map(
      (key) => [key, canonicalValue(value[key], visiting)],
    ))
    visiting.delete(value)
    return result
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return value
  fail('invalid-concurrency-contract-value')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function resourceKey(resource) {
  return `${resource.domain_digest}:${resource.segments === null ? '*' : stableJson(resource.segments)}`
}

function compareAccessShape(left, right) {
  return compareText(stableJson(left), stableJson(right))
}

function compareAccessOccurrence(left, right) {
  return compareText(left.resource.domain_digest, right.resource.domain_digest)
    || compareSegments(left.resource.segments, right.resource.segments)
    || compareText(left.branch, right.branch)
    || compareText(left.effect, right.effect)
    || compareText(left.mode, right.mode)
}

function compareSegments(left, right) {
  if (left === null && right !== null) return -1
  if (left !== null && right === null) return 1
  if (left === null && right === null) return 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const compared = compareText(stableJson(left[index]), stableJson(right[index]))
    if (compared !== 0) return compared
  }
  return left.length - right.length
}

function compareId(left, right) {
  return compareText(left.id, right.id)
}

function compareShape(left, right) {
  return compareText(stableJson(left), stableJson(right))
}

function compareEffectEvidence(left, right) {
  return compareText(left.branch, right.branch)
    || compareText(left.effect, right.effect)
}

function compareNestedRegionSummary(left, right) {
  return compareText(left.scope_path.join('\u0000'), right.scope_path.join('\u0000'))
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function insertSorted(values, value) {
  let index = 0
  while (index < values.length && compareText(values[index], value) < 0) index += 1
  values.splice(index, 0, value)
}

function trieNode() {
  return { accesses: [], children: new Map() }
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
