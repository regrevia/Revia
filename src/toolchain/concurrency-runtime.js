import { verifyConcurrencyTrace } from './concurrency-contract.js'

const PLAN_SCHEMA = 're.concurrency-plan@0.1.0'
const TRACE_SCHEMA = 're.concurrency-trace@0.1.0'
const SCHEDULER_SCHEMA = 're.concurrency-scheduler@0.1.0'
const RUNTIME_ERROR = Symbol('concurrency-runtime-error')
const MAX_REGION_DEPTH = 32
const PLAN_NODE_FIELDS = [
  'cancellation',
  'deadline',
  'effect',
  'id',
  'kind',
  'members',
  'policy',
]
const PLAN_EDGE_FIELDS = ['branch', 'from', 'kind', 'to']
const PLAN_POLICY = {
  branch_error: 'collect-as-value',
  cancel_propagation: 'downward',
  detach: false,
  host_fault: 'cancel-siblings-join-cleanup-propagate',
  retry: 'explicit-loop-only',
}
const PLAN_POLICY_FIELDS = Object.keys(PLAN_POLICY).sort()

export async function executeConcurrencyPlan(plan, options = {}) {
  try {
    const validated = validatePlan(plan)
    const runtime = createRuntime(validated.shape, validated.plan, options)
    return await runtime.run()
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'concurrency-runtime-failure' }],
      ok: false,
    }
  }
}

function validatePlan(plan) {
  if (!isObject(plan)) {
    fail('invalid-concurrency-plan')
  }
  let schema
  let construct
  let nodes
  let edges
  let output
  try {
    schema = plan.schema
    construct = plan.construct
    nodes = snapshotPlanNodes(plan.nodes)
    edges = snapshotPlanEdges(plan.edges)
    output = plan.output
  } catch {
    fail('invalid-concurrency-plan')
  }
  plan = { construct, edges, nodes, output, schema }
  if (plan.schema !== PLAN_SCHEMA || plan.construct !== 'par') {
    fail('invalid-concurrency-plan')
  }
  if (!Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) {
    fail('invalid-concurrency-plan')
  }
  if (typeof plan.output !== 'string' || !plan.output.endsWith('.join')) {
    fail('invalid-concurrency-plan-output')
  }
  const rootKey = plan.output.slice(0, -'.join'.length)
  if (!rootKey.startsWith('par.')) fail('invalid-concurrency-plan-output')
  const regionNodes = plan.nodes.filter((node) => node?.kind === 'par-region')
  if (regionNodes.some((region) => !isPlanPolicy(region.policy))) {
    fail('invalid-concurrency-plan')
  }
  const regionKeys = new Set(regionNodes.map(({ id }) => id))
  if (regionNodes.length !== regionKeys.size) fail('duplicate-concurrency-plan-region')
  if (!regionKeys.has(rootKey)) fail('invalid-concurrency-plan-shape')
  const regions = new Map(regionNodes.map((region) => [
    region.id,
    buildRegionShape(plan, region.id, regionKeys),
  ]))
  for (const region of regions.values()) {
    if (region.scopePath.length > (MAX_REGION_DEPTH * 2) - 1) {
      fail('concurrency-plan-depth-limit-exceeded', { region: region.regionId })
    }
    if (region.key === rootKey) {
      if (region.parentRegionKey !== null) fail('invalid-concurrency-plan-shape')
      continue
    }
    const parent = regions.get(region.parentRegionKey)
    if (parent === undefined
      || !parent.branchNames.includes(region.parentBranch)
      || !parent.childRegions.get(region.parentBranch)?.includes(region.key)) {
      fail('invalid-concurrency-plan-region-parent', { region: region.regionId })
    }
  }
  const root = regions.get(rootKey)
  return {
    plan,
    shape: { ...root, regions, rootKey },
  }
}

function snapshotPlanNodes(nodes) {
  if (!Array.isArray(nodes)) return nodes
  const snapshotNodes = []
  const length = nodes.length
  for (let index = 0; index < length; index += 1) {
    const node = nodes[index]
    if (!isObject(node)) fail('invalid-concurrency-plan')
    const snapshot = {}
    for (const field of PLAN_NODE_FIELDS) {
      const value = node[field]
      snapshot[field] = field === 'members' && Array.isArray(value)
        ? [...value]
        : field === 'policy'
          ? snapshotPlanPolicy(value)
          : field === 'deadline'
            ? snapshotPlanDeadline(value)
            : value
    }
    snapshotNodes.push(snapshot)
  }
  return snapshotNodes
}

function snapshotPlanPolicy(policy) {
  if (!isObject(policy)) return policy
  const keys = Object.keys(policy).sort()
  if (keys.length !== PLAN_POLICY_FIELDS.length
    || keys.some((key, index) => key !== PLAN_POLICY_FIELDS[index])) {
    fail('invalid-concurrency-plan')
  }
  const snapshot = {}
  for (const field of PLAN_POLICY_FIELDS) snapshot[field] = policy[field]
  return snapshot
}

function isPlanPolicy(policy) {
  return isObject(policy)
    && PLAN_POLICY_FIELDS.every((field) => policy[field] === PLAN_POLICY[field])
}

function snapshotPlanDeadline(deadline) {
  if (deadline === undefined || deadline === null) return deadline
  if (!isObject(deadline)
    || Object.keys(deadline).sort().join(',') !== 'endpoint,type') {
    fail('invalid-concurrency-plan')
  }
  const snapshot = { endpoint: deadline.endpoint, type: deadline.type }
  if (snapshot.endpoint !== 'request.deadline'
    || snapshot.type !== 'time.monotonic_instant') {
    fail('invalid-concurrency-plan')
  }
  return snapshot
}

function snapshotPlanEdges(edges) {
  if (!Array.isArray(edges)) return edges
  const snapshotEdges = []
  const length = edges.length
  for (let index = 0; index < length; index += 1) {
    const edge = edges[index]
    if (!isObject(edge)) fail('invalid-concurrency-plan')
    const snapshot = {}
    for (const field of PLAN_EDGE_FIELDS) snapshot[field] = edge[field]
    snapshotEdges.push(snapshot)
  }
  return snapshotEdges
}

function buildRegionShape(plan, regionKey, regionKeys) {
  const joins = plan.nodes.filter((node) => node?.kind === 'join')
  const join = joins.find((node) => node.id === `${regionKey}.join`)
  if (join === undefined || !Array.isArray(join.members) || join.members.length < 2) {
    fail('invalid-concurrency-plan-shape')
  }
  const tasks = new Map()
  const effects = new Map()
  const steps = new Map()
  const childRegions = new Map()
  for (const member of join.members) {
    if (!isName(member) || tasks.has(member)) fail('invalid-concurrency-plan-branch')
    const taskId = `${regionKey}.branch.${member}`
    const task = plan.nodes.find((node) => node.kind === 'task-scope' && node.id === taskId)
    if (task === undefined) fail('invalid-concurrency-plan-branch', { branch: member })
    tasks.set(member, task)
    const branchEffects = plan.nodes
      .filter((node) => node.kind === 'effect-occurrence'
        && node.id.startsWith(`${taskId}.effect.`))
      .map((node) => {
        const effect = node.id.slice(`${taskId}.effect.`.length)
        if (!isName(effect) || effect.includes('.')) {
          fail('invalid-concurrency-plan-effect', { branch: member })
        }
        if (!['cooperative', 'complete-before-join'].includes(node.cancellation)) {
          fail('invalid-concurrency-plan-effect', { branch: member, effect })
        }
        return { ...node, effect }
      })
    const directChildren = [...regionKeys]
      .filter((key) => key.startsWith(`${taskId}.par.`))
      .filter((key) => !key.slice(`${taskId}.par.`.length).includes('.'))
      .sort()
    childRegions.set(member, directChildren)
    const stepById = new Map([
      ...branchEffects.map((effect) => [effect.id, {
        effect: effect.effect,
        kind: 'effect',
        node: effect,
      }]),
      ...directChildren.map((key) => [key, {
        kind: 'region',
        regionId: key.slice(`${taskId}.par.`.length),
        regionKey: key,
      }]),
    ])
    const nextById = new Map()
    for (const edge of plan.edges) {
      if (edge.kind !== 'order' || !stepById.has(edge.to)) continue
      if (edge.from !== taskId && !stepById.has(edge.from)) continue
      if (nextById.has(edge.from)) fail('ambiguous-concurrency-effect-order', {
        branch: member,
      })
      nextById.set(edge.from, edge.to)
    }
    const orderedSteps = []
    let previous = taskId
    while (nextById.has(previous)) {
      const next = nextById.get(previous)
      if (orderedSteps.some((step) => step.id === next)) fail('cyclic-concurrency-effect-order', {
        branch: member,
      })
      orderedSteps.push({ ...stepById.get(next), id: next })
      previous = next
    }
    if (orderedSteps.length !== stepById.size) {
      fail('disconnected-concurrency-effect-order', { branch: member })
    }
    steps.set(member, orderedSteps)
    effects.set(member, orderedSteps
      .filter(({ kind }) => kind === 'effect')
      .map(({ node }) => node))
  }
  const parent = parentRegion(regionKey)
  return {
    branchNames: [...join.members],
    childRegions,
    deadlineDeclared: plan.nodes.find((node) => node.id === regionKey).deadline !== null,
    effects,
    key: regionKey,
    parentBranch: parent?.branch ?? null,
    parentRegionKey: parent?.regionKey ?? null,
    regionId: scopePath(regionKey).at(-1),
    scopePath: scopePath(regionKey),
    steps,
  }
}

function parentRegion(regionKey) {
  const lastBranch = regionKey.lastIndexOf('.branch.')
  const lastPar = regionKey.lastIndexOf('.par.')
  if (lastBranch < 0 || lastPar <= lastBranch) return null
  return {
    branch: regionKey.slice(lastBranch + '.branch.'.length, lastPar),
    regionKey: regionKey.slice(0, lastBranch),
  }
}

function scopePath(regionKey) {
  const parts = regionKey.split('.')
  const result = [parts[1]]
  for (let index = 2; index < parts.length; index += 4) {
    result.push(parts[index + 1], parts[index + 3])
  }
  return result
}

function createRuntime(shape, plan, options) {
  if (!isObject(options)) fail('invalid-concurrency-options')
  let branches
  try {
    branches = options.branches
  } catch {
    fail('invalid-concurrency-options')
  }
  if (!(branches instanceof Map)) fail('invalid-concurrency-runners')
  const runnerMap = snapshotRunners(shape, branches)
  let deadline
  try {
    deadline = options.deadline
  } catch {
    fail('invalid-concurrency-options')
  }
  if (shape.deadlineDeclared && !Number.isFinite(deadline)) {
    fail('missing-explicit-concurrency-deadline')
  }
  if (deadline !== undefined
    && (!Number.isFinite(deadline) || deadline < 0)) {
    fail('invalid-concurrency-deadline')
  }
  let parentSignal
  try {
    parentSignal = options.parentSignal
  } catch {
    fail('invalid-concurrency-options')
  }
  const parentSignalCapabilities = parentSignal === undefined
    ? null
    : snapshotParentSignal(parentSignal)
  let maxConcurrentBranchesOption
  try {
    maxConcurrentBranchesOption = options.maxConcurrentBranches
  } catch {
    fail('invalid-concurrency-options')
  }
  if (maxConcurrentBranchesOption !== undefined
    && (!Number.isSafeInteger(maxConcurrentBranchesOption)
      || maxConcurrentBranchesOption < 1)) {
    fail('invalid-concurrency-max-concurrent-branches')
  }
  const maxConcurrentBranches = maxConcurrentBranchesOption === undefined
    ? Infinity
    : maxConcurrentBranchesOption
  let nowOption
  let setTimeoutOption
  let clearTimeoutOption
  try {
    nowOption = options.now
    setTimeoutOption = options.setTimeoutImpl
    clearTimeoutOption = options.clearTimeoutImpl
  } catch {
    fail('invalid-concurrency-options')
  }
  const now = nowOption ?? defaultNow
  const setTimeoutImpl = setTimeoutOption ?? setTimeout
  const clearTimeoutImpl = clearTimeoutOption ?? clearTimeout
  if (typeof now !== 'function'
    || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function') {
    fail('invalid-concurrency-clock')
  }

  const controller = new AbortController()
  const statuses = new Map(shape.branchNames.map((name) => [name, 'spawned']))
  const outcomes = {}
  const trace = []
  const schedulerRegions = []
  const executionStates = new Map(shape.branchNames.map((name) => [
    name,
    { index: 0, started: new Set() },
  ]))
  let cancelReason = null
  let hostFault = false
  let fatalError = null
  let deadlineTimer = null
  let parentListener = null

  const emit = (event) => trace.push({ ...event, kind: event.kind, ordinal: trace.length })
  const removeParentListener = () => {
    if (parentSignalCapabilities === null || parentListener === null) return true
    const listener = parentListener
    parentListener = null
    try {
      parentSignalCapabilities.remove('abort', listener)
      return true
    } catch {
      return false
    }
  }
  const readEffectClock = () => {
    try {
      const value = now()
      if (!Number.isFinite(value) || value < 0) fail('invalid-concurrency-clock')
      return value
    } catch {
      fail('invalid-concurrency-clock')
    }
  }
  const cancel = (reason) => {
    if (cancelReason === null) {
      cancelReason = reason
      emit({ kind: 'region-cancel', reason })
    }
    if (!controller.signal.aborted) controller.abort()
  }
  const fault = (branch) => {
    hostFault = true
    if (statuses.get(branch) === 'spawned') {
      statuses.set(branch, 'host-fault')
      emit({ branch, fault_ref: `host-fault.${branch}`, kind: 'branch-host-fault' })
    }
    if (!controller.signal.aborted) controller.abort()
  }
  const branchCancellationReason = () => cancelReason ?? (hostFault ? 'host-fault' : 'parent')

  const runBoundedBranches = (names, runBranch, signal, scopePath) => new Promise((resolve) => {
    let active = 0
    let next = 0
    let settled = false
    const report = {
      admitted: [],
      queued_cancelled: [],
      scope_path: [...scopePath],
    }
    schedulerRegions.push(report)
    const finish = () => {
      if (!settled && active === 0 && next === names.length) {
        settled = true
        signal.removeEventListener('abort', cancelQueued)
        resolve()
      }
    }
    const cancelQueued = () => {
      while (next < names.length) {
        report.queued_cancelled.push(names[next])
        void runBranch(names[next])
        next += 1
      }
      finish()
    }
    const pump = () => {
      if (signal.aborted) {
        cancelQueued()
        return
      }
      while (active < maxConcurrentBranches
        && next < names.length
        && !signal.aborted) {
        const branch = names[next]
        next += 1
        active += 1
        report.admitted.push(branch)
        Promise.resolve(runBranch(branch)).then(() => {
          active -= 1
          pump()
          finish()
        }, () => {
          active -= 1
          pump()
          finish()
        })
      }
      if (signal.aborted) cancelQueued()
      finish()
    }
    signal.addEventListener('abort', cancelQueued, { once: true })
    pump()
  })

  const runEffect = async (branch, effectName, operation) => {
    const state = executionStates.get(branch)
    const step = shape.steps.get(branch)[state.index]
    const effect = step?.node
    if (controller.signal.aborted) throw cancellationError()
    if (step?.kind !== 'effect'
      || effect.effect !== effectName
      || state.started.has(effectName)) {
      fail('invalid-concurrency-effect-runner', { branch, effect: effectName })
    }
    if (typeof operation !== 'function') fail('invalid-concurrency-operation', {
      branch,
      effect: effectName,
    })
    state.started.add(effectName)
    state.index += 1
    emit({ branch, effect: effectName, kind: 'effect-start' })
    let aborted = controller.signal.aborted
    const onAbort = () => { aborted = true }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    let cancellationRecorded = false
    try {
      const startedAt = readEffectClock()
      const value = await Promise.resolve().then(() => operation({
        branch,
        effect: effectName,
        signal: controller.signal,
      }))
      if (aborted && effect.cancellation === 'cooperative') {
        emit({ branch, effect: effectName, kind: 'effect-cancelled' })
        cancellationRecorded = true
        throw cancellationError()
      }
      emit({
        branch,
        cancel_latency_ms: aborted
          ? nonNegativeLatency(readEffectClock() - startedAt)
          : null,
        effect: effectName,
        kind: 'effect-complete',
      })
      return value
    } catch (error) {
      if (aborted && effect.cancellation === 'cooperative') {
        if (!cancellationRecorded) {
          emit({ branch, effect: effectName, kind: 'effect-cancelled' })
        }
        throw cancellationError()
      }
      throw error
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  const runNested = async (branch, regionId, runners) => {
    if (!isName(regionId)) fail('unknown-nested-concurrency-region', {
      branch,
      region: regionId,
    })
    const state = executionStates.get(branch)
    const step = shape.steps.get(branch)[state.index]
    if (step?.kind !== 'region' || step.regionId !== regionId) {
      fail('unknown-nested-concurrency-region', { branch, region: regionId })
    }
    const region = shape.regions.get(step.regionKey)
    if (region === undefined || region.parentBranch !== branch) {
      fail('unknown-nested-concurrency-region', { branch, region: regionId })
    }
    state.index += 1
    return runChildRegion(region, runners, controller)
  }

  const runChildRegion = async (region, runners, parentController) => {
    if (region.deadlineDeclared) fail('unsupported-nested-concurrency-deadline', {
      region: region.regionId,
    })
    const runnerMap = snapshotRunners(region, runners)
    const childController = new AbortController()
    const childStatuses = new Map(region.branchNames.map((name) => [name, 'spawned']))
    const childOutcomes = {}
    const childStates = new Map(region.branchNames.map((name) => [
      name,
      { index: 0, started: new Set() },
    ]))
    let childCancelReason = null
    let childHostFault = false
    let childFatalError = null
    const emitChild = (event) => emit({ ...event, scope_path: region.scopePath })
    const cancelChild = () => {
      if (childCancelReason === null) {
        childCancelReason = 'parent'
        emitChild({ kind: 'region-cancel', reason: 'parent' })
      }
      if (!childController.signal.aborted) childController.abort()
    }
    const childFault = (branch) => {
      childHostFault = true
      if (childStatuses.get(branch) === 'spawned') {
        childStatuses.set(branch, 'host-fault')
        emitChild({
          branch,
          fault_ref: `host-fault.${branch}`,
          kind: 'branch-host-fault',
        })
      }
      if (!childController.signal.aborted) childController.abort()
    }
    const childCancellationReason = () => (
      childCancelReason ?? (childHostFault ? 'host-fault' : 'parent')
    )
    const runChildEffect = async (branch, effectName, operation) => {
      const state = childStates.get(branch)
      const step = region.steps.get(branch)[state.index]
      const effect = step?.node
      if (childController.signal.aborted) throw cancellationError()
      if (step?.kind !== 'effect'
        || effect.effect !== effectName
        || state.started.has(effectName)) {
        fail('invalid-concurrency-effect-runner', { branch, effect: effectName })
      }
      if (typeof operation !== 'function') fail('invalid-concurrency-operation', {
        branch,
        effect: effectName,
      })
      state.started.add(effectName)
      state.index += 1
      emitChild({ branch, effect: effectName, kind: 'effect-start' })
      let aborted = childController.signal.aborted
      const onAbort = () => { aborted = true }
      childController.signal.addEventListener('abort', onAbort, { once: true })
      let cancellationRecorded = false
      try {
        const startedAt = readEffectClock()
        const value = await Promise.resolve().then(() => operation({
          branch,
          effect: effectName,
          signal: childController.signal,
        }))
        if (aborted && effect.cancellation === 'cooperative') {
          emitChild({ branch, effect: effectName, kind: 'effect-cancelled' })
          cancellationRecorded = true
          throw cancellationError()
        }
        emitChild({
          branch,
          cancel_latency_ms: aborted
            ? nonNegativeLatency(readEffectClock() - startedAt)
            : null,
          effect: effectName,
          kind: 'effect-complete',
        })
        return value
      } catch (error) {
        if (aborted && effect.cancellation === 'cooperative') {
          if (!cancellationRecorded) {
            emitChild({ branch, effect: effectName, kind: 'effect-cancelled' })
          }
          throw cancellationError()
        }
        throw error
      } finally {
        childController.signal.removeEventListener('abort', onAbort)
      }
    }
    const runChildNested = async (branch, regionId, nestedRunners) => {
      if (!isName(regionId)) fail('unknown-nested-concurrency-region', {
        branch,
        region: regionId,
      })
      const state = childStates.get(branch)
      const step = region.steps.get(branch)[state.index]
      if (step?.kind !== 'region' || step.regionId !== regionId) {
        fail('unknown-nested-concurrency-region', { branch, region: regionId })
      }
      const childRegion = shape.regions.get(step.regionKey)
      if (childRegion === undefined
        || childRegion.parentRegionKey !== region.key
        || childRegion.parentBranch !== branch) {
        fail('unknown-nested-concurrency-region', { branch, region: regionId })
      }
      state.index += 1
      return runChildRegion(childRegion, nestedRunners, childController)
    }
    const runChildBranch = async (branch) => {
      if (childController.signal.aborted) {
        childStatuses.set(branch, 'cancelled')
        emitChild({
          branch,
          kind: 'branch-cancelled',
          reason: childCancellationReason(),
        })
        return
      }
      try {
        const value = await runnerMap.get(branch)({
          branch,
          runNested: (nestedRegion, nestedRunners) => (
            runChildNested(branch, nestedRegion, nestedRunners)
          ),
          runEffect: (effect, operation) => runChildEffect(branch, effect, operation),
          signal: childController.signal,
        })
        if (childController.signal.aborted) {
          childStatuses.set(branch, 'cancelled')
          emitChild({
            branch,
            kind: 'branch-cancelled',
            reason: childCancellationReason(),
          })
        } else {
          if (childStates.get(branch).index !== region.steps.get(branch).length) {
            fail('concurrency-branch-missing-effect', { branch })
          }
          childStatuses.set(branch, 'completed')
          childOutcomes[branch] = value
          emitChild({ branch, kind: 'branch-complete' })
        }
      } catch (error) {
        if (error?.diagnostic !== undefined) {
          childFatalError ??= error
          if (!childController.signal.aborted) childController.abort()
          return
        }
        if (error?.[RUNTIME_ERROR] === 'cancelled' || childController.signal.aborted) {
          childStatuses.set(branch, 'cancelled')
          emitChild({
            branch,
            kind: 'branch-cancelled',
            reason: childCancellationReason(),
          })
        } else {
          childFault(branch)
        }
      }
    }

    for (const branch of region.branchNames) {
      emitChild({ branch, kind: 'branch-spawn' })
    }
    parentController.signal.addEventListener('abort', cancelChild, { once: true })
    if (parentController.signal.aborted) cancelChild()
    try {
      await runBoundedBranches(
        region.branchNames,
        runChildBranch,
        childController.signal,
        region.scopePath,
      )
      if (childFatalError !== null) throw childFatalError
      const outcome = childHostFault
        ? 'host-fault'
        : [...childStatuses.values()].every((status) => status === 'cancelled')
          ? 'cancelled'
          : 'joined'
      emitChild({ kind: 'region-exit', outcome })
      if (childHostFault) throw nestedHostFault()
      return { branches: childOutcomes, outcome }
    } finally {
      parentController.signal.removeEventListener('abort', cancelChild)
    }
  }

  const runBranch = async (branch) => {
    if (controller.signal.aborted) {
      statuses.set(branch, 'cancelled')
      emit({ branch, kind: 'branch-cancelled', reason: branchCancellationReason() })
      return
    }
    try {
      const value = await runnerMap.get(branch)({
        branch,
        runNested: (region, runners) => runNested(branch, region, runners),
        runEffect: (effect, operation) => runEffect(branch, effect, operation),
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        statuses.set(branch, 'cancelled')
        emit({ branch, kind: 'branch-cancelled', reason: branchCancellationReason() })
      } else {
        if (executionStates.get(branch).index !== shape.steps.get(branch).length) {
          fail('concurrency-branch-missing-effect', { branch })
        }
        statuses.set(branch, 'completed')
        outcomes[branch] = value
        emit({ branch, kind: 'branch-complete' })
      }
    } catch (error) {
      if (error?.diagnostic !== undefined) {
        fatalError ??= error
        if (!controller.signal.aborted) controller.abort()
        return
      }
      if (error?.[RUNTIME_ERROR] === 'nested-host-fault') {
        fault(branch)
        return
      }
      if (error?.[RUNTIME_ERROR] === 'cancelled' || controller.signal.aborted) {
        statuses.set(branch, 'cancelled')
        emit({ branch, kind: 'branch-cancelled', reason: branchCancellationReason() })
      } else {
        fault(branch)
      }
    }
  }

  return {
    async run() {
      let deadlineDelay = null
      if (deadline !== undefined) {
        let current
        try {
          current = now()
        } catch {
          fail('invalid-concurrency-clock')
        }
        if (!Number.isFinite(current) || current < 0) {
          fail('invalid-concurrency-clock')
        }
        deadlineDelay = Math.max(0, deadline - current)
      }
      for (const branch of shape.branchNames) emit({ branch, kind: 'branch-spawn' })
      if (parentSignalCapabilities !== null) {
        parentListener = () => cancel('parent')
        try {
          parentSignalCapabilities.add('abort', parentListener, { once: true })
        } catch {
          removeParentListener()
          fail('invalid-concurrency-parent-signal')
        }
        if (parentSignalCapabilities.aborted) cancel('parent')
      }
      if (deadline !== undefined) {
        try {
          deadlineTimer = setTimeoutImpl(() => cancel('deadline'), deadlineDelay)
        } catch {
          removeParentListener()
          fail('invalid-concurrency-clock')
        }
      }
      try {
        await runBoundedBranches(
          shape.branchNames,
          runBranch,
          controller.signal,
          [shape.regionId],
        )
        if (fatalError !== null) throw fatalError
        const outcome = hostFault
          ? 'host-fault'
          : [...statuses.values()].every((status) => status === 'cancelled')
            ? 'cancelled'
            : 'joined'
        emit({ kind: 'region-exit', outcome })
        const result = {
          branches: outcomes,
          ok: true,
          outcome,
          scheduler: {
            max_concurrent_branches: Number.isFinite(maxConcurrentBranches)
              ? maxConcurrentBranches
              : null,
            policy: 'fifo',
            regions: schedulerRegions
              .map((region) => ({
                admitted: [...region.admitted],
                queued_cancelled: [...region.queued_cancelled],
                scope_path: [...region.scope_path],
              }))
              .sort(compareSchedulerRegion),
            schema: SCHEDULER_SCHEMA,
          },
          trace: { events: trace, region_id: shape.regionId, schema: TRACE_SCHEMA },
        }
        result.verification = verifyConcurrencyTrace(plan, result.trace)
        if (!result.verification.ok) {
          return {
            diagnostics: [{ code: 'runtime-generated-invalid-trace' }],
            ok: false,
            trace: result.trace,
            verification: result.verification,
          }
        }
        return result
      } finally {
        let timerCleanupFailed = false
        if (deadlineTimer !== null) {
          try {
            clearTimeoutImpl(deadlineTimer)
          } catch {
            timerCleanupFailed = true
          }
        }
        const parentCleanupFailed = !removeParentListener()
        if (timerCleanupFailed) fail('invalid-concurrency-clock')
        if (parentCleanupFailed) fail('invalid-concurrency-parent-signal')
      }
    },
  }
}

function cancellationError() {
  return { [RUNTIME_ERROR]: 'cancelled' }
}

function nestedHostFault() {
  return { [RUNTIME_ERROR]: 'nested-host-fault' }
}

function snapshotRunners(shape, runners) {
  if (!(runners instanceof Map)) fail('invalid-concurrency-runners')
  let entries
  try {
    entries = [...Map.prototype.entries.call(runners)]
  } catch {
    fail('invalid-concurrency-runners')
  }
  const names = new Set(shape.branchNames)
  const snapshot = new Map()
  for (const [name, runner] of entries) {
    if (!names.has(name) || typeof runner !== 'function') {
      fail('unknown-concurrency-runner', { branch: name })
    }
    snapshot.set(name, runner)
  }
  if (snapshot.size !== names.size) fail('missing-concurrency-runner')
  return snapshot
}

function defaultNow() {
  return typeof performance?.now === 'function' ? performance.now() : Date.now()
}

function snapshotParentSignal(value) {
  try {
    if (value === null || typeof value !== 'object') {
      fail('invalid-concurrency-parent-signal')
    }
    const add = value.addEventListener
    const remove = value.removeEventListener
    const aborted = value.aborted
    if (typeof add !== 'function'
      || typeof remove !== 'function'
      || typeof aborted !== 'boolean') {
      fail('invalid-concurrency-parent-signal')
    }
    return {
      aborted,
      add: Function.prototype.bind.call(add, value),
      remove: Function.prototype.bind.call(remove, value),
    }
  } catch {
    fail('invalid-concurrency-parent-signal')
  }
}

function nonNegativeLatency(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function compareSchedulerRegion(left, right) {
  return Buffer.compare(
    Buffer.from(left.scope_path.join('\u0000'), 'utf8'),
    Buffer.from(right.scope_path.join('\u0000'), 'utf8'),
  )
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]*$/u.test(value)
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), {
    diagnostic: { code, ...details },
  })
}
