import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { lowerControlFlow } from '../src/toolchain/control-flow-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/control-flow-corpus.json', import.meta.url),
  'utf8',
))
const schema = 're.control-flow-contract@0.1.0'
const resultType = { kind: 'sum', variants: ['ok', 'err'] }

test('every control-flow attack executes against the lowering interface', () => {
  assert.equal(corpus.schema, 're.control-flow-corpus@0.1.0')
  assert.equal(corpus.status, 'executable-contract')
  for (const entry of corpus.cases) {
    const result = lowerControlFlow(contractFor(entry.shape))
    if (entry.expected.startsWith('accept-')) {
      assert.equal(result.ok, true, entry.id)
      assert.equal(result.graph.construct, entry.expected.slice('accept-'.length), entry.id)
      assert.equal(result.graph.schema, 're.control-flow-graph@0.1.0', entry.id)
    } else {
      assert.equal(result.ok, false, entry.id)
      assert.equal(
        result.diagnostics[0].code,
        entry.expected.slice('reject-'.length),
        entry.id,
      )
    }
  }
})

test('match lowering is exhaustive, priority-explicit, pure, and order independent', () => {
  const first = matchContract()
  const second = structuredClone(first)
  second.input.type.variants.reverse()
  second.arms.reverse()
  for (const arm of second.arms) arm.guard?.nodes.reverse()
  assert.deepEqual(lowerControlFlow(second), lowerControlFlow(first))

  const graph = lowerControlFlow(first).graph
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'match-dispatch').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'merge').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'region').length, 3)

  const missingFallback = structuredClone(first)
  missingFallback.arms = missingFallback.arms.filter(
    ({ priority, variant }) => !(variant === 'ok' && priority === 1),
  )
  assert.equal(
    lowerControlFlow(missingFallback).diagnostics[0].code,
    'match-variant-missing-fallback',
  )
})

test('loop lowering has one typed header, next merge, backedge, and exit merge', () => {
  const result = lowerControlFlow(loopContract())
  assert.equal(result.ok, true)
  assert.equal(result.graph.edges.filter(({ backedge }) => backedge === true).length, 1)
  assert.deepEqual(
    result.graph.nodes.map(({ kind }) => kind).sort(),
    ['loop-header', 'merge', 'merge', 'region'],
  )

  const invalid = loopContract()
  invalid.exits[0].kind = 'return'
  assert.equal(lowerControlFlow(invalid).diagnostics[0].code, 'return-inside-loop')
})

test('result values require an explicit exact consumer and have no V1 propagation sugar', () => {
  const explicit = resultFlow([{ kind: 'match', variants: ['ok', 'err'] }])
  assert.equal(lowerControlFlow(explicit).ok, true)

  const orderOnly = resultFlow([{ kind: 'after' }])
  assert.equal(lowerControlFlow(orderOnly).diagnostics[0].code, 'unconsumed-result')

  const propagation = resultFlow([{ kind: 'match', variants: ['err', 'ok'] }])
  propagation.propagation = true
  assert.equal(
    lowerControlFlow(propagation).diagnostics[0].code,
    'unsupported-v1-result-propagation-sugar',
  )
})

test('function calls form a DAG and cannot be confused with Module cycles', () => {
  const acyclic = functionCalls([{ from: 'main', to: 'helper' }])
  assert.equal(lowerControlFlow(acyclic).ok, true)
  const direct = functionCalls([{ from: 'main', to: 'main' }])
  assert.equal(
    lowerControlFlow(direct).diagnostics[0].code,
    'recursive-function-not-supported-v1',
  )
  const mutual = functionCalls([
    { from: 'main', to: 'helper' },
    { from: 'helper', to: 'main' },
  ])
  assert.equal(
    lowerControlFlow(mutual).diagnostics[0].code,
    'recursive-function-not-supported-v1',
  )
  const duplicate = functionCalls([
    { from: 'main', to: 'helper' },
    { from: 'main', to: 'helper' },
  ])
  assert.equal(lowerControlFlow(duplicate).diagnostics[0].code, 'duplicate-function-call')
})

test('state-machine lowering exhausts State x Event and consumes command results', () => {
  const first = machineContract()
  const second = structuredClone(first)
  second.state_variants.reverse()
  second.event_variants.reverse()
  second.cases.reverse()
  second.command_contracts[0].result_variants.reverse()
  assert.deepEqual(lowerControlFlow(second), lowerControlFlow(first))

  const graph = lowerControlFlow(first).graph
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'loop-header').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'match-dispatch').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'region').length, 4)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'state-value').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'event-input').length, 1)
  assert.equal(graph.nodes.filter(({ kind }) => kind === 'command-contract').length, 1)
  assert.equal(graph.edges.filter(({ kind }) => kind === 'result-event-map').length, 2)
  assert.deepEqual(
    graph.edges
      .filter(({ kind }) => kind === 'result-event-map')
      .map(({ event, from, result_variant, to }) => ({
        event,
        from,
        result_variant,
        to,
      })),
    [
      {
        event: 'complete',
        from: 'machine.command.run',
        result_variant: 'err',
        to: 'machine.event-input',
      },
      {
        event: 'start',
        from: 'machine.command.run',
        result_variant: 'ok',
        to: 'machine.event-input',
      },
    ],
  )
  assert.equal(graph.output, 'machine.exit-merge')
  assert.deepEqual(
    graph.nodes.find(({ id }) => id === graph.output).type,
    { error: 'machine_error', kind: 'result', ok: 'done' },
  )
  assert.deepEqual(
    graph.edges.filter(({ to }) => to === graph.output).map(({ variant }) => variant),
    ['ok'],
  )

  const failing = machineContract()
  failing.cases.at(-1).decision = {
    kind: 'error',
    value: { endpoint: 'machine.failure', type: 'machine_error' },
  }
  assert.deepEqual(
    lowerControlFlow(failing).graph.edges
      .filter(({ to }) => to === 'machine.exit-merge')
      .map(({ variant }) => variant),
    ['err'],
  )

  const missing = machineContract()
  missing.cases.pop()
  assert.equal(
    lowerControlFlow(missing).diagnostics[0].code,
    'non-exhaustive-transition-matrix',
  )

  const incompleteCommand = machineContract()
  delete incompleteCommand.command_contracts[0].event_map.err
  assert.equal(
    lowerControlFlow(incompleteCommand).diagnostics[0].code,
    'incomplete-command-result-map',
  )

  const endless = machineContract()
  endless.cases.at(-1).decision = { kind: 'next', state: 'idle' }
  assert.equal(
    lowerControlFlow(endless).diagnostics[0].code,
    'machine-missing-terminal-decision',
  )

  const unused = machineContract()
  delete unused.cases[0].decision.command
  assert.equal(lowerControlFlow(unused).diagnostics[0].code, 'unused-command-contract')
})

test('Agent Relay lifecycle uses a closed State x Event contract', () => {
  const first = lowerControlFlow(agentRelayContract())
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(
    first.graph.nodes.filter(({ kind }) => kind === 'region').length,
    28,
  )
  assert.equal(
    first.graph.nodes.find(({ id }) => id === 'machine.dispatch').variants.length,
    28,
  )
  assert.equal(
    first.graph.edges.filter(({ kind }) => kind === 'result-event-map').length,
    2,
  )

  const reordered = agentRelayContract()
  reordered.state_variants.reverse()
  reordered.event_variants.reverse()
  reordered.cases.reverse()
  reordered.command_contracts[0].result_variants.reverse()
  assert.deepEqual(lowerControlFlow(reordered), first)

  const missing = agentRelayContract()
  missing.cases.pop()
  assert.equal(
    lowerControlFlow(missing).diagnostics[0].code,
    'non-exhaustive-transition-matrix',
  )
})

test('Agent Relay lifecycle has a stable graph digest and terminal identity', () => {
  const baseline = lowerControlFlow(agentRelayContract())
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(baseline.graph))
      .digest('hex'),
    '7786089847a2e7e64f8fd7fab5032c5c5cb49de9c7ed1d3bb1e7371473c65167',
  )

  const mutated = agentRelayContract()
  const terminal = mutated.cases.find(
    ({ decision, event, state }) => (
      state === 'succeeded' && event === 'agent_result' && decision.kind === 'done'
    ),
  )
  terminal.decision.value.endpoint = 'relay.succeeded.mutated'
  const changed = lowerControlFlow(mutated)
  assert.equal(changed.ok, true)
  assert.notDeepEqual(changed.graph, baseline.graph)
})

test('graph mutations cannot preserve a valid lowering digest', () => {
  const baseline = lowerControlFlow(machineContract())
  const commandMutation = machineContract()
  commandMutation.command_contracts[0].event_map.ok = 'complete'
  assert.equal(lowerControlFlow(commandMutation).ok, false)

  const identityMutation = machineContract()
  identityMutation.cases.at(-1).decision.value.endpoint = 'machine.output.changed'
  const mutated = lowerControlFlow(identityMutation)
  assert.equal(mutated.ok, true)
  assert.notDeepEqual(mutated.graph, baseline.graph)

  const sourceMutation = machineContract()
  sourceMutation.event_source = 'untrusted.host.event'
  assert.equal(lowerControlFlow(sourceMutation).ok, false)
  assert.equal(
    lowerControlFlow(sourceMutation).diagnostics[0].code,
    'unexpected-state-machine-contract-field',
  )
})

test('valid control-flow contracts have fixed lowering graph digests', () => {
  const contracts = {
    function_calls: functionCalls([{ from: 'main', to: 'helper' }]),
    loop: loopContract(),
    match: matchContract(),
    result: resultFlow([{ kind: 'match', variants: ['ok', 'err'] }]),
    state_machine: machineContract(),
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(contracts).map(([name, contract]) => [
      name,
      createHash('sha256')
        .update(JSON.stringify(lowerControlFlow(contract).graph))
        .digest('hex'),
    ])),
    {
      function_calls: '49099b2b027f67ef446117df2f8a50de7b703a166d5ad5a5cd1479c905960fc1',
      loop: '10b2462bc0875af01f075d621c582b02bbaa3fb7127a5a648224996d35271d0a',
      match: '0eab2841d8188393c11ce8f1303cd28bb492c9e44d494e72dc0f33dd108982ca',
      result: 'fffb10856de6a35491c52092b43d9b8b6279f938e599b657912d15e9561375a1',
      state_machine: 'b253970513888634d77bd86750000dafd21b54c4689e4663bbd66024cf5bfbdb',
    },
  )
})

test('malformed nested contracts fail closed without exposing host exceptions', () => {
  const cyclic = loopContract()
  cyclic.state_type = cyclic
  const inputs = [null, [], { schema }, cyclic]
  for (const input of inputs) {
    const result = lowerControlFlow(input)
    assert.equal(result.ok, false)
    assert.match(result.diagnostics[0].code, /^[a-z][a-z0-9-]*$/u)
    assert.equal(Object.hasOwn(result.diagnostics[0], 'message'), false)
    assert.equal(Object.hasOwn(result.diagnostics[0], 'stack'), false)
  }
})

function contractFor(shape) {
  if (shape === 'recursive-function') {
    return functionCalls([{ from: 'main', to: 'main' }])
  }
  if (shape === 'guard-with-effect') {
    const contract = matchContract()
    contract.arms.find(({ guard }) => guard !== undefined).guard.nodes[2].kind = 'effect-call'
    return contract
  }
  if (shape === 'result-unmatched') return resultFlow([{ kind: 'after' }])
  if (shape === 'result-region-crosses-loop') {
    const contract = resultFlow([{ kind: 'match', variants: ['err', 'ok'] }])
    contract.propagation = true
    return contract
  }
  if (shape === 'match-lowering') return matchContract()
  if (shape === 'loop-lowering') return loopContract()
  if (shape === 'typed-state-transition') return machineContract()
  if (shape === 'agent-relay-lifecycle') return agentRelayContract()
  if (shape === 'agent-relay-result-map-collision') {
    const contract = agentRelayContract()
    contract.command_contracts[0].event_map.err = contract.command_contracts[0].event_map.ok
    return contract
  }
  if (shape === 'effect-in-transition') {
    const contract = machineContract()
    contract.cases[0].decision.effect = 'stdout.write'
    return contract
  }
  throw new Error(`unknown control-flow shape: ${shape}`)
}

function matchContract() {
  const boolGuard = {
    nodes: [
      { id: 'value', kind: 'input', type: 'int' },
      { id: 'zero', kind: 'literal', type: 'int', value: '0' },
      {
        id: 'positive',
        inputs: ['value', 'zero'],
        kind: 'pure-call',
        operation_digest: `sha256:${'a'.repeat(64)}`,
        type: 'bool',
      },
    ],
    root: 'positive',
  }
  return {
    arms: [
      {
        output: { endpoint: 'status.err', type: 'process.status' },
        priority: 0,
        variant: 'err',
      },
      {
        guard: boolGuard,
        output: { endpoint: 'status.ok.positive', type: 'process.status' },
        priority: 0,
        variant: 'ok',
      },
      {
        output: { endpoint: 'status.ok.fallback', type: 'process.status' },
        priority: 1,
        variant: 'ok',
      },
    ],
    input: { endpoint: 'write.result', type: resultType },
    kind: 'match',
    output_type: 'process.status',
    schema,
  }
}

function loopContract() {
  return {
    exits: [
      { id: 'continue', kind: 'next', value: { endpoint: 'state.next', type: 'counter' } },
      { id: 'finish', kind: 'done', value: { endpoint: 'total', type: 'int' } },
    ],
    initial: { endpoint: 'state.initial', type: 'counter' },
    kind: 'loop',
    output_type: 'int',
    schema,
    state_type: 'counter',
  }
}

function resultFlow(uses) {
  return {
    kind: 'result-flow',
    propagation: false,
    schema,
    uses,
    value: { endpoint: 'operation.result', type: resultType },
  }
}

function functionCalls(calls) {
  return {
    calls,
    functions: ['main', 'helper'],
    kind: 'function-call-graph',
    schema,
  }
}

function machineContract() {
  return {
    cases: [
      {
        decision: { command: 'run', kind: 'next', state: 'running' },
        event: 'start',
        state: 'idle',
      },
      {
        decision: { kind: 'next', state: 'idle' },
        event: 'complete',
        state: 'idle',
      },
      {
        decision: { kind: 'next', state: 'running' },
        event: 'start',
        state: 'running',
      },
      {
        decision: {
          kind: 'done',
          value: { endpoint: 'machine.output', type: 'done' },
        },
        event: 'complete',
        state: 'running',
      },
    ],
    command_contracts: [{
      event_map: { err: 'complete', ok: 'start' },
      result_variants: ['ok', 'err'],
      variant: 'run',
    }],
    done_type: 'done',
    error_type: 'machine_error',
    event_variants: ['start', 'complete'],
    initial_state: 'idle',
    kind: 'state-machine',
    schema,
    state_variants: ['running', 'idle'],
  }
}

function agentRelayContract() {
  const states = [
    'queued',
    'running',
    'waiting_tool',
    'waiting_agent',
    'succeeded',
    'failed',
    'cancelled',
  ]
  const events = ['dispatch', 'tool_result', 'agent_result', 'cancel']
  const next = (source, target, event, command) => ({
    decision: {
      ...(command === undefined ? {} : { command }),
      kind: 'next',
      state: target,
    },
    event,
    state: source,
  })
  const cases = []
  for (const state of states) {
    for (const event of events) {
      if (state === 'queued' && event === 'dispatch') {
        cases.push(next(state, 'running', event, 'run'))
      } else if (state === 'running' && event === 'tool_result') {
        cases.push(next(state, 'waiting_tool', event))
      } else if (state === 'running' && event === 'agent_result') {
        cases.push(next(state, 'waiting_agent', event))
      } else if (state === 'waiting_tool' && event === 'tool_result') {
        cases.push({
          decision: {
            kind: 'next',
            state: 'succeeded',
          },
          event,
          state,
        })
      } else if (state === 'waiting_agent' && event === 'agent_result') {
        cases.push({
          decision: {
            kind: 'next',
            state: 'succeeded',
          },
          event,
          state,
        })
      } else if (
        event === 'cancel' &&
        !['succeeded', 'failed', 'cancelled'].includes(state)
      ) {
        cases.push({
          ...next(state, 'cancelled', event),
        })
      } else if (state === 'waiting_tool' && event === 'agent_result') {
        cases.push({
          decision: {
            kind: 'next',
            state: 'failed',
          },
          event,
          state,
        })
      } else if (state === 'waiting_agent' && event === 'tool_result') {
        cases.push({
          decision: {
            kind: 'next',
            state: 'failed',
          },
          event,
          state,
        })
      } else if (state === 'succeeded') {
        cases.push({
          decision: {
            kind: 'done',
            value: { endpoint: `relay.succeeded.${event}`, type: 'relay_result' },
          },
          event,
          state,
        })
      } else if (state === 'failed' || state === 'cancelled') {
        cases.push({
          decision: {
            kind: 'error',
            value: { endpoint: `relay.${state}.${event}`, type: 'relay_error' },
          },
          event,
          state,
        })
      } else {
        cases.push(next(state, state, event))
      }
    }
  }
  return {
    cases,
    command_contracts: [{
      event_map: { err: 'agent_result', ok: 'tool_result' },
      result_variants: ['ok', 'err'],
      variant: 'run',
    }],
    done_type: 'relay_result',
    error_type: 'relay_error',
    event_variants: events,
    initial_state: 'queued',
    kind: 'state-machine',
    schema,
    state_variants: states,
  }
}
