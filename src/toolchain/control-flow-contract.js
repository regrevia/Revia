import { Buffer } from 'node:buffer'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const ID = /^[a-z][a-z0-9_.-]*$/
const SCHEMA = 're.control-flow-contract@0.1.0'
const GRAPH_SCHEMA = 're.control-flow-graph@0.1.0'

export function lowerControlFlow(input) {
  try {
    assertObject(input, 'invalid-control-flow-contract')
    if (input.schema !== SCHEMA) fail('unsupported-control-flow-contract')
    let graph
    if (input.kind === 'match') graph = lowerMatch(input)
    else if (input.kind === 'loop') graph = lowerLoop(input)
    else if (input.kind === 'result-flow') graph = lowerResultFlow(input)
    else if (input.kind === 'function-call-graph') graph = lowerFunctionCalls(input)
    else if (input.kind === 'state-machine') graph = lowerStateMachine(input)
    else fail('unsupported-control-flow-kind', { kind: input.kind })
    return { graph: canonicalGraph(graph), ok: true }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-control-flow-contract' }],
      ok: false,
    }
  }
}

function lowerMatch(input) {
  exactFields(input, ['arms', 'input', 'kind', 'output_type', 'schema'], 'match-contract')
  assertObject(input.input, 'invalid-match-input')
  exactFields(input.input, ['endpoint', 'type'], 'match-input')
  named(input.input.endpoint, 'invalid-match-input-endpoint')
  const variants = closedVariants(input.input.type, 'match')
  if (!Array.isArray(input.arms)) fail('invalid-match-arm-set')
  const arms = input.arms.map((arm) => normalizeMatchArm(arm, input.output_type, variants))
  const identities = new Set()
  for (const arm of arms) {
    const identity = `${arm.variant}:${arm.priority}`
    if (identities.has(identity)) fail('duplicate-match-arm', { identity })
    identities.add(identity)
  }
  for (const variant of variants) {
    const selected = arms
      .filter((arm) => arm.variant === variant)
      .sort((left, right) => left.priority - right.priority)
    if (selected.length === 0) fail('non-exhaustive-match', { missing: [variant] })
    selected.forEach((arm, index) => {
      if (arm.priority !== index) fail('non-contiguous-match-priority', { variant })
      const fallback = index === selected.length - 1
      if (fallback !== (arm.guard === undefined)) {
        fail(fallback ? 'match-variant-missing-fallback' : 'match-arm-after-fallback', {
          priority: arm.priority,
          variant,
        })
      }
    })
  }
  const ordered = [...arms].sort(compareVariantPriority)
  const nodes = [{
    id: 'match.dispatch',
    input: input.input.endpoint,
    kind: 'match-dispatch',
    variants,
  }]
  const edges = [{ from: input.input.endpoint, kind: 'value', to: 'match.dispatch' }]
  for (const arm of ordered) {
    const region = `match.arm.${arm.variant}.${arm.priority}`
    nodes.push({
      id: region,
      kind: 'region',
      priority: arm.priority,
      variant: arm.variant,
      ...(arm.guard === undefined ? {} : { guard_root: `${region}.guard.${arm.guard.root}` }),
    })
    edges.push({ from: 'match.dispatch', kind: 'control', to: region })
    if (arm.guard !== undefined) {
      for (const node of arm.guard.nodes) {
        const nodeId = `${region}.guard.${node.id}`
        nodes.push({ ...node, id: nodeId })
        for (const endpoint of node.inputs) {
          edges.push({
            from: `${region}.guard.${endpoint}`,
            kind: 'value',
            region,
            to: nodeId,
          })
        }
      }
      edges.push({
        from: `${region}.guard.${arm.guard.root}`,
        kind: 'guard',
        region,
        to: region,
      })
    }
    edges.push({ from: arm.output.endpoint, kind: 'value', region, to: 'match.merge' })
  }
  nodes.push({ id: 'match.merge', kind: 'merge', type: input.output_type })
  return { construct: 'match', edges, nodes, output: 'match.merge' }
}

function normalizeMatchArm(arm, outputType, variants) {
  assertObject(arm, 'invalid-match-arm')
  exactFields(arm, ['guard', 'output', 'priority', 'variant'], 'match-arm', ['guard'])
  if (!variants.includes(arm.variant)) fail('unknown-match-variant', { variant: arm.variant })
  if (!Number.isInteger(arm.priority) || arm.priority < 0) {
    fail('invalid-match-priority', { priority: arm.priority })
  }
  const output = typedEndpoint(arm.output, 'match-arm-output')
  if (!same(output.type, outputType)) fail('match-arm-type-mismatch', { variant: arm.variant })
  return {
    output,
    priority: arm.priority,
    variant: arm.variant,
    ...(arm.guard === undefined ? {} : { guard: normalizeGuard(arm.guard) }),
  }
}

function normalizeGuard(guard) {
  assertObject(guard, 'invalid-match-guard')
  exactFields(guard, ['nodes', 'root'], 'match-guard')
  named(guard.root, 'invalid-guard-root')
  if (!Array.isArray(guard.nodes) || guard.nodes.length === 0) fail('invalid-guard-node-set')
  const nodes = new Map()
  for (const node of guard.nodes) {
    assertObject(node, 'invalid-guard-node')
    named(node.id, 'invalid-guard-node-id')
    if (nodes.has(node.id)) fail('duplicate-guard-node', { id: node.id })
    if (node.kind === 'effect-call') fail('effect-in-match-guard', { id: node.id })
    if (node.kind === 'input') {
      exactFields(node, ['id', 'kind', 'type'], 'guard-input')
      nodes.set(node.id, { id: node.id, inputs: [], kind: node.kind, type: node.type })
    } else if (node.kind === 'literal') {
      exactFields(node, ['id', 'kind', 'type', 'value'], 'guard-literal')
      nodes.set(node.id, {
        id: node.id, inputs: [], kind: node.kind, type: node.type, value: node.value,
      })
    } else if (node.kind === 'pure-call') {
      exactFields(node, ['id', 'inputs', 'kind', 'operation_digest', 'type'], 'guard-call')
      if (!DIGEST.test(node.operation_digest)) fail('guard-call-requires-exact-operation')
      if (!Array.isArray(node.inputs)) fail('invalid-guard-call-inputs')
      nodes.set(node.id, {
        id: node.id,
        inputs: [...node.inputs],
        kind: node.kind,
        operation_digest: node.operation_digest,
        type: node.type,
      })
    } else {
      fail('unsupported-guard-node-kind', { kind: node.kind })
    }
  }
  const root = nodes.get(guard.root)
  if (root === undefined) fail('guard-root-not-found')
  if (root.type !== 'bool') fail('guard-root-must-be-bool')
  const visited = new Set()
  const visiting = new Set()
  const visit = (id) => {
    if (visiting.has(id)) fail('guard-value-cycle')
    if (visited.has(id)) return
    const node = nodes.get(id)
    if (node === undefined) fail('guard-input-not-found', { endpoint: id })
    visiting.add(id)
    for (const endpoint of node.inputs) visit(endpoint)
    visiting.delete(id)
    visited.add(id)
  }
  visit(guard.root)
  if (visited.size !== nodes.size) fail('unused-guard-node')
  return {
    nodes: [...nodes.values()].sort(compareId),
    root: guard.root,
  }
}

function lowerLoop(input) {
  exactFields(input, [
    'exits', 'initial', 'kind', 'output_type', 'schema', 'state_type',
  ], 'loop-contract')
  const initial = typedEndpoint(input.initial, 'loop-initial')
  if (!same(initial.type, input.state_type)) fail('loop-initial-state-type-mismatch')
  if (!Array.isArray(input.exits)) fail('invalid-loop-exit-set')
  const seen = new Set()
  const exits = input.exits.map((exit) => {
    assertObject(exit, 'invalid-loop-exit')
    exactFields(exit, ['id', 'kind', 'value'], 'loop-exit')
    named(exit.id, 'invalid-loop-exit-id')
    if (seen.has(exit.id)) fail('duplicate-loop-exit', { id: exit.id })
    seen.add(exit.id)
    if (exit.kind === 'return') fail('return-inside-loop')
    if (!['done', 'next'].includes(exit.kind)) fail('unsupported-loop-exit', { kind: exit.kind })
    const value = typedEndpoint(exit.value, 'loop-exit-value')
    const expected = exit.kind === 'next' ? input.state_type : input.output_type
    if (!same(value.type, expected)) fail(`${exit.kind}-value-type-mismatch`, { id: exit.id })
    return { id: exit.id, kind: exit.kind, value }
  }).sort(compareId)
  if (!exits.some(({ kind }) => kind === 'next')) fail('loop-missing-next')
  if (!exits.some(({ kind }) => kind === 'done')) fail('loop-missing-done')
  const nodes = [
    { id: 'loop.header', kind: 'loop-header', type: input.state_type },
    { id: 'loop.body', kind: 'region' },
    { id: 'loop.next-merge', kind: 'merge', type: input.state_type },
    { id: 'loop.exit-merge', kind: 'merge', type: input.output_type },
  ]
  const edges = [
    { from: initial.endpoint, kind: 'value', role: 'initial', to: 'loop.header' },
    { from: 'loop.header', kind: 'control', to: 'loop.body' },
    { backedge: true, from: 'loop.next-merge', kind: 'value', to: 'loop.header' },
  ]
  for (const exit of exits) {
    edges.push({
      from: exit.value.endpoint,
      kind: 'value',
      region: 'loop.body',
      to: exit.kind === 'next' ? 'loop.next-merge' : 'loop.exit-merge',
    })
  }
  return { construct: 'loop', edges, nodes, output: 'loop.exit-merge' }
}

function lowerResultFlow(input) {
  exactFields(input, ['kind', 'propagation', 'schema', 'uses', 'value'], 'result-flow')
  if (input.propagation !== false) fail('unsupported-v1-result-propagation-sugar')
  const value = typedEndpoint(input.value, 'result-value')
  const variants = closedVariants(value.type, 'result')
  if (!same(variants, ['err', 'ok'])) fail('invalid-result-type')
  if (!Array.isArray(input.uses)) fail('invalid-result-use-set')
  let consumers = 0
  const uses = input.uses.map((use, index) => {
    assertObject(use, 'invalid-result-use')
    if (use.kind === 'after') {
      exactFields(use, ['kind'], 'result-after-use')
      return { id: `result.use.${index}`, kind: 'after' }
    }
    if (use.kind === 'drop') fail('unconsumed-result')
    if (use.kind === 'match') {
      exactFields(use, ['kind', 'variants'], 'result-match-use')
      const matched = uniqueNames(use.variants, 'result-match-variant')
      if (!same(matched, ['err', 'ok'])) {
        fail('non-exhaustive-result-match')
      }
      consumers += 1
      return { id: `result.use.${index}`, kind: 'match', variants: ['err', 'ok'] }
    }
    if (use.kind === 'pass' || use.kind === 'return') {
      exactFields(use, ['expected_type', 'kind'], `result-${use.kind}-use`)
      if (!same(use.expected_type, value.type)) fail('result-use-type-mismatch', { kind: use.kind })
      consumers += 1
      return { id: `result.use.${index}`, kind: use.kind, type: use.expected_type }
    }
    fail('unsupported-result-use', { kind: use.kind })
  })
  if (consumers === 0) fail('unconsumed-result')
  return {
    construct: 'result-flow',
    edges: uses.map(({ id, kind }) => ({
      consumer: ['match', 'pass', 'return'].includes(kind),
      from: value.endpoint,
      kind: kind === 'after' ? 'order' : 'value',
      to: id,
    })),
    nodes: [
      { id: value.endpoint, kind: 'result-value', type: value.type },
      ...uses,
    ],
    output: null,
  }
}

function lowerFunctionCalls(input) {
  exactFields(input, ['calls', 'functions', 'kind', 'schema'], 'function-call-contract')
  const functions = uniqueNames(input.functions, 'function')
  if (!Array.isArray(input.calls)) fail('invalid-function-call-set')
  const known = new Set(functions)
  const callsByPair = new Map()
  for (const call of input.calls) {
    assertObject(call, 'invalid-function-call')
    exactFields(call, ['from', 'to'], 'function-call')
    if (!known.has(call.from) || !known.has(call.to)) fail('function-call-target-not-found')
    const pair = `${call.from}:${call.to}`
    if (callsByPair.has(pair)) fail('duplicate-function-call', { pair })
    callsByPair.set(pair, { from: call.from, kind: 'call', to: call.to })
  }
  const calls = [...callsByPair.values()].sort(compareEdge)
  const adjacency = new Map(functions.map((name) => [name, []]))
  for (const call of calls) adjacency.get(call.from).push(call.to)
  const visited = new Set()
  const visiting = new Set()
  const visit = (name) => {
    if (visiting.has(name)) fail('recursive-function-not-supported-v1', { function: name })
    if (visited.has(name)) return
    visiting.add(name)
    for (const target of adjacency.get(name)) visit(target)
    visiting.delete(name)
    visited.add(name)
  }
  for (const name of functions) visit(name)
  return {
    construct: 'function-call-graph',
    edges: calls,
    nodes: functions.map((id) => ({ id, kind: 'function' })),
    output: null,
  }
}

function lowerStateMachine(input) {
  exactFields(input, [
    'cases', 'command_contracts', 'done_type', 'error_type', 'event_variants',
    'initial_state', 'kind', 'schema', 'state_variants',
  ], 'state-machine-contract')
  const states = uniqueNames(input.state_variants, 'state-variant')
  const events = uniqueNames(input.event_variants, 'event-variant')
  if (input.done_type === undefined) fail('invalid-machine-done-type')
  if (input.error_type === undefined) fail('invalid-machine-error-type')
  if (!states.includes(input.initial_state)) fail('initial-state-not-found')
  const commands = normalizeCommands(input.command_contracts, events)
  if (!Array.isArray(input.cases)) fail('invalid-transition-case-set')
  const pairs = new Set()
  const cases = input.cases.map((entry) => {
    assertObject(entry, 'invalid-transition-case')
    exactFields(entry, ['decision', 'event', 'state'], 'transition-case')
    if (!states.includes(entry.state)) fail('transition-state-not-found', { state: entry.state })
    if (!events.includes(entry.event)) fail('transition-event-not-found', { event: entry.event })
    const pair = `${entry.state}:${entry.event}`
    if (pairs.has(pair)) fail('duplicate-transition-case', { pair })
    pairs.add(pair)
    return {
      decision: normalizeDecision(entry.decision, input, states, commands),
      event: entry.event,
      state: entry.state,
    }
  }).sort(compareStateEvent)
  const missing = []
  for (const state of states) {
    for (const event of events) {
      if (!pairs.has(`${state}:${event}`)) missing.push(`${state}:${event}`)
    }
  }
  if (missing.length > 0) fail('non-exhaustive-transition-matrix', { missing })
  const reachable = new Set([input.initial_state])
  let changed = true
  while (changed) {
    changed = false
    for (const entry of cases) {
      const target = entry.decision.kind === 'next' ? entry.decision.state : undefined
      if (reachable.has(entry.state) && target !== undefined && !reachable.has(target)) {
        reachable.add(target)
        changed = true
      }
    }
  }
  const unreachable = states.filter((state) => !reachable.has(state))
  if (unreachable.length > 0) fail('unreachable-machine-state', { states: unreachable })
  if (!cases.some(({ decision }) => ['done', 'error'].includes(decision.kind))) {
    fail('machine-missing-terminal-decision')
  }
  const usedCommands = new Set(cases.flatMap(({ decision }) => (
    decision.command === undefined ? [] : [decision.command.variant]
  )))
  const unusedCommands = [...commands.keys()].filter((variant) => !usedCommands.has(variant))
  if (unusedCommands.length > 0) fail('unused-command-contract', { variants: unusedCommands })
  const stateType = { kind: 'sum', variants: states }
  const eventType = { kind: 'sum', variants: events }
  const resultType = {
    error: input.error_type,
    kind: 'result',
    ok: input.done_type,
  }
  const nodes = [
    {
      id: 'machine.initial-state',
      kind: 'state-value',
      type: stateType,
      variant: input.initial_state,
    },
    {
      id: 'machine.loop-header',
      kind: 'loop-header',
      type: stateType,
    },
    { id: 'machine.event-input', kind: 'event-input', type: eventType },
    {
      id: 'machine.dispatch',
      kind: 'match-dispatch',
      variants: cases.map(caseId),
    },
    ...[...commands.values()].map((command) => ({
      ...command,
      id: `machine.command.${command.variant}`,
      kind: 'command-contract',
    })),
    ...cases.map((entry) => ({
      decision: entry.decision,
      event: entry.event,
      id: `machine.case.${entry.state}.${entry.event}`,
      kind: 'region',
      state: entry.state,
    })),
    {
      id: 'machine.next-merge',
      kind: 'merge',
      type: stateType,
    },
    { id: 'machine.exit-merge', kind: 'merge', type: resultType },
  ]
  const edges = [
    {
      from: 'machine.initial-state', kind: 'value', role: 'initial', to: 'machine.loop-header',
    },
    { from: 'machine.loop-header', kind: 'value', role: 'state', to: 'machine.dispatch' },
    { from: 'machine.event-input', kind: 'value', role: 'event', to: 'machine.dispatch' },
    { backedge: true, from: 'machine.next-merge', kind: 'value', to: 'machine.loop-header' },
    ...[...commands.values()].flatMap((command) => command.result_variants.map((result_variant) => ({
      event: command.event_map[result_variant],
      from: `machine.command.${command.variant}`,
      kind: 'result-event-map',
      result_variant,
      to: 'machine.event-input',
    }))),
  ]
  for (const entry of cases) {
    const region = `machine.case.${entry.state}.${entry.event}`
    edges.push({ from: 'machine.dispatch', kind: 'control', to: region })
    if (entry.decision.kind === 'next') {
      edges.push({ from: region, kind: 'value', to: 'machine.next-merge' })
      if (entry.decision.command !== undefined) {
        edges.push({
          from: region,
          kind: 'command',
          to: `machine.command.${entry.decision.command.variant}`,
        })
      }
    } else {
      edges.push({
        from: region,
        kind: 'value',
        to: 'machine.exit-merge',
        variant: entry.decision.kind === 'done' ? 'ok' : 'err',
      })
    }
  }
  return { construct: 'state-machine', edges, nodes, output: 'machine.exit-merge' }
}

function normalizeCommands(input, events) {
  if (!Array.isArray(input)) fail('invalid-command-contract-set')
  const commands = new Map()
  for (const command of input) {
    assertObject(command, 'invalid-command-contract')
    exactFields(command, ['event_map', 'result_variants', 'variant'], 'command-contract')
    named(command.variant, 'invalid-command-variant')
    if (commands.has(command.variant)) fail('duplicate-command-contract', { variant: command.variant })
    const results = uniqueNames(command.result_variants, 'command-result-variant')
    assertObject(command.event_map, 'invalid-command-event-map')
    if (!same(Object.keys(command.event_map).sort(compareText), results)) {
      fail('incomplete-command-result-map', { variant: command.variant })
    }
    const mapped = Object.values(command.event_map)
    if (new Set(mapped).size !== mapped.length || mapped.some((event) => !events.includes(event))) {
      fail('invalid-command-result-event-map', { variant: command.variant })
    }
    commands.set(command.variant, {
      event_map: Object.fromEntries(Object.entries(command.event_map).sort(compareEntry)),
      result_variants: results,
      variant: command.variant,
    })
  }
  return commands
}

function normalizeDecision(decision, input, states, commands) {
  assertObject(decision, 'invalid-transition-decision')
  if (Object.hasOwn(decision, 'effect')) fail('effect-in-pure-transition')
  if (decision.kind === 'next') {
    exactFields(decision, ['command', 'kind', 'state'], 'next-decision', ['command'])
    if (!states.includes(decision.state)) fail('next-state-not-found', { state: decision.state })
    if (decision.command !== undefined && !commands.has(decision.command)) {
      fail('command-contract-not-found', { command: decision.command })
    }
    return {
      ...(decision.command === undefined ? {} : { command: commands.get(decision.command) }),
      kind: 'next',
      state: decision.state,
    }
  }
  if (decision.kind === 'done' || decision.kind === 'error') {
    exactFields(decision, ['kind', 'value'], `${decision.kind}-decision`)
    const value = typedEndpoint(decision.value, `${decision.kind}-decision-value`)
    const expected = decision.kind === 'done' ? input.done_type : input.error_type
    if (!same(value.type, expected)) fail(`${decision.kind}-decision-type-mismatch`)
    return { kind: decision.kind, value }
  }
  fail('unsupported-transition-decision', { kind: decision.kind })
}

function typedEndpoint(input, label) {
  assertObject(input, `invalid-${label}`)
  exactFields(input, ['endpoint', 'type'], label)
  named(input.endpoint, `invalid-${label}-endpoint`)
  if (input.type === undefined) fail(`missing-${label}-type`)
  return { endpoint: input.endpoint, type: input.type }
}

function closedVariants(type, label) {
  assertObject(type, `invalid-${label}-sum-type`)
  exactFields(type, ['kind', 'variants'], `${label}-sum-type`)
  if (type.kind !== 'sum') fail(`${label}-requires-closed-sum`)
  return uniqueNames(type.variants, `${label}-variant`)
}

function uniqueNames(input, label) {
  if (!Array.isArray(input) || input.length === 0) fail(`invalid-${label}-set`)
  const values = [...input]
  for (const value of values) named(value, `invalid-${label}`)
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`)
  return values.sort(compareText)
}

function canonicalGraph(graph) {
  return {
    construct: graph.construct,
    edges: [...graph.edges].sort(compareEdge),
    nodes: [...graph.nodes].sort(compareId),
    output: graph.output,
    schema: GRAPH_SCHEMA,
  }
}

function exactFields(value, allowed, label, optional = []) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail(`unexpected-${label}-field`, { field })
  }
  for (const field of allowed) {
    if (!optional.includes(field) && !Object.hasOwn(value, field)) {
      fail(`missing-${label}-field`, { field })
    }
  }
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareId(left, right) {
  return compareText(left.id, right.id)
}

function compareEdge(left, right) {
  return compareText(stableJson(left), stableJson(right))
}

function compareVariantPriority(left, right) {
  return compareText(left.variant, right.variant) || left.priority - right.priority
}

function compareStateEvent(left, right) {
  return compareText(left.state, right.state) || compareText(left.event, right.event)
}

function compareEntry(left, right) {
  return compareText(left[0], right[0])
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function caseId(entry) {
  return `${entry.state}.${entry.event}`
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
