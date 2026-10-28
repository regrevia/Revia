import { createHash } from 'node:crypto'

import { lowerControlFlow } from './control-flow-contract.js'
import { validateTypeReference } from './type-contract.js'

const CONTRACT_SCHEMA = 're.agent-contract@0.1.0'
const LIFECYCLE_SCHEMA = 're.agent-lifecycle@0.1.0'
const CONTROL_FLOW_SCHEMA = 're.control-flow-contract@0.1.0'
const SEMANTIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const NAME = /^[a-z][a-z0-9_]*$/
const TERMINAL_OUTCOMES = new Set(['cancelled', 'failed', 'stopped', 'succeeded'])
const CONTRACT_FIELDS = [
  'agent',
  'error_type',
  'events',
  'identity_type',
  'initial_state',
  'input_type',
  'module',
  'output_type',
  'retryable_states',
  'schema',
  'states',
  'terminal_states',
  'transitions',
]

export function validateAgentContract(input) {
  try {
    const contract = normalizeAgentContract(input)
    const lowered = lowerControlFlow(stateMachineContract(contract))
    if (!lowered.ok) fail('invalid-agent-state-machine', {
      state_machine_diagnostics: lowered.diagnostics,
    })
    return {
      ok: true,
      value: {
        agent: contract.agent,
        contract,
        contract_digest: digest(contract),
        module: contract.module,
        schema: LIFECYCLE_SCHEMA,
        state_machine: lowered.graph,
        terminal_states: contract.terminal_states,
        transitions: contract.transitions,
      },
    }
  } catch (error) {
    return rejected(error)
  }
}

export function agentContractDigest(input) {
  return digest(normalizeAgentContract(input))
}

export function applyAgentEvent(input, snapshot, event) {
  const validation = validateAgentContract(input)
  if (!validation.ok) return validation
  try {
    assertObject(snapshot, 'invalid-agent-snapshot')
    exactFields(snapshot, ['agent', 'state'], 'agent-snapshot')
    const contract = validation.value.contract
    if (snapshot.agent !== contract.agent) {
      fail('agent-identity-mismatch', {
        actual: snapshot.agent,
        expected: contract.agent,
      })
    }
    if (!contract.states.includes(snapshot.state)) {
      fail('agent-state-not-found', { state: snapshot.state })
    }
    if (!contract.events.includes(event)) {
      fail('agent-event-not-found', { event })
    }
    if (contract.terminal_states.some(({ state }) => state === snapshot.state)) {
      fail('agent-terminal-state', { state: snapshot.state })
    }
    const transition = contract.transitions.find(
      ({ event: candidate, from }) => from === snapshot.state && candidate === event,
    )
    if (transition === undefined) {
      fail('illegal-agent-transition', { event, state: snapshot.state })
    }
    return {
      ok: true,
      value: {
        agent: contract.agent,
        event,
        from: snapshot.state,
        state: transition.to,
      },
    }
  } catch (error) {
    return rejected(error)
  }
}

function normalizeAgentContract(input) {
  assertObject(input, 'invalid-agent-contract')
  exactFields(input, CONTRACT_FIELDS, 'agent-contract')
  if (input.schema !== CONTRACT_SCHEMA) fail('unsupported-agent-contract')
  if (!SEMANTIC_NAME.test(input.agent)) fail('invalid-agent-name', { agent: input.agent })
  if (!SEMANTIC_NAME.test(input.module)) fail('invalid-agent-module', { module: input.module })
  const states = uniqueNames(input.states, 'agent-state')
  const events = uniqueNames(input.events, 'agent-event')
  if (!states.includes(input.initial_state)) {
    fail('agent-initial-state-not-found', { state: input.initial_state })
  }
  const identityType = agentType(input.identity_type, 'identity')
  const inputType = agentType(input.input_type, 'input')
  const outputType = agentType(input.output_type, 'output')
  const errorType = agentType(input.error_type, 'error')
  const terminalStates = normalizeTerminalStates(input.terminal_states, states)
  const terminalNames = new Set(terminalStates.map(({ state }) => state))
  if (terminalNames.has(input.initial_state)) fail('agent-initial-state-terminal')
  const retryableStates = uniqueNames(input.retryable_states, 'agent-retryable-state', true)
  for (const state of retryableStates) {
    if (!states.includes(state)) fail('agent-retryable-state-not-found', { state })
    if (terminalNames.has(state)) fail('terminal-agent-state-retryable', { state })
  }
  const transitions = normalizeTransitions(input.transitions, states, events, terminalNames)
  const reachable = reachableStates(input.initial_state, transitions)
  const unreachable = states.filter((state) => !reachable.has(state))
  if (unreachable.length > 0) fail('unreachable-agent-state', { states: unreachable })
  const nonterminal = states.filter((state) => !terminalNames.has(state))
  const missingOutgoing = nonterminal.filter(
    (state) => !transitions.some(({ from }) => from === state),
  )
  if (missingOutgoing.length > 0) {
    fail('agent-state-missing-transition', { states: missingOutgoing })
  }
  return {
    agent: input.agent,
    error_type: errorType,
    events,
    identity_type: identityType,
    initial_state: input.initial_state,
    input_type: inputType,
    module: input.module,
    output_type: outputType,
    retryable_states: retryableStates,
    schema: CONTRACT_SCHEMA,
    states,
    terminal_states: terminalStates,
    transitions,
  }
}

function normalizeTerminalStates(input, states) {
  if (!Array.isArray(input) || input.length === 0) fail('invalid-agent-terminal-state-set')
  const seenStates = new Set()
  const seenOutcomes = new Set()
  const terminalStates = input.map((entry) => {
    assertObject(entry, 'invalid-agent-terminal-state')
    exactFields(entry, ['outcome', 'state'], 'agent-terminal-state')
    if (!states.includes(entry.state)) fail('agent-terminal-state-not-found', { state: entry.state })
    if (!TERMINAL_OUTCOMES.has(entry.outcome)) {
      fail('invalid-agent-terminal-outcome', { outcome: entry.outcome })
    }
    if (seenStates.has(entry.state)) fail('duplicate-agent-terminal-state', { state: entry.state })
    if (seenOutcomes.has(entry.outcome)) {
      fail('duplicate-agent-terminal-outcome', { outcome: entry.outcome })
    }
    seenStates.add(entry.state)
    seenOutcomes.add(entry.outcome)
    return { outcome: entry.outcome, state: entry.state }
  }).sort(compareState)
  for (const required of TERMINAL_OUTCOMES) {
    if (!seenOutcomes.has(required)) fail('missing-agent-terminal-outcome', { outcome: required })
  }
  return terminalStates
}

function normalizeTransitions(input, states, events, terminalStates) {
  if (!Array.isArray(input) || input.length === 0) fail('invalid-agent-transition-set')
  const pairs = new Set()
  return input.map((entry) => {
    assertObject(entry, 'invalid-agent-transition')
    exactFields(entry, ['event', 'from', 'to'], 'agent-transition')
    if (!states.includes(entry.from) || !states.includes(entry.to)) {
      fail('agent-transition-state-not-found', { from: entry.from, to: entry.to })
    }
    if (!events.includes(entry.event)) fail('agent-transition-event-not-found', { event: entry.event })
    if (terminalStates.has(entry.from)) {
      fail('terminal-agent-state-has-transition', { state: entry.from })
    }
    const pair = `${entry.from}:${entry.event}`
    if (pairs.has(pair)) fail('duplicate-agent-transition', { event: entry.event, state: entry.from })
    pairs.add(pair)
    return { event: entry.event, from: entry.from, to: entry.to }
  }).sort(compareTransition)
}

function stateMachineContract(contract) {
  const transitionByPair = new Map(
    contract.transitions.map((entry) => [`${entry.from}:${entry.event}`, entry]),
  )
  const terminalByState = new Map(
    contract.terminal_states.map((entry) => [entry.state, entry.outcome]),
  )
  const cases = []
  for (const state of contract.states) {
    for (const event of contract.events) {
      const transition = transitionByPair.get(`${state}:${event}`)
      if (transition !== undefined) {
        cases.push({
          decision: { kind: 'next', state: transition.to },
          event,
          state,
        })
        continue
      }
      const outcome = terminalByState.get(state)
      const succeeded = outcome === 'succeeded'
      cases.push({
        decision: {
          kind: succeeded ? 'done' : 'error',
          value: {
            endpoint: succeeded
              ? `agent.${state}.${event}.output`
              : `agent.${state}.${event}.error`,
            type: succeeded ? contract.output_type : contract.error_type,
          },
        },
        event,
        state,
      })
    }
  }
  return {
    cases,
    command_contracts: [],
    done_type: contract.output_type,
    error_type: contract.error_type,
    event_variants: contract.events,
    initial_state: contract.initial_state,
    kind: 'state-machine',
    schema: CONTROL_FLOW_SCHEMA,
    state_variants: contract.states,
  }
}

function agentType(input, label) {
  const result = validateTypeReference(input)
  if (!result.ok) {
    fail(`invalid-agent-${label}-type`, { type_diagnostics: result.diagnostics })
  }
  return result.value
}

function reachableStates(initial, transitions) {
  const reachable = new Set([initial])
  let changed = true
  while (changed) {
    changed = false
    for (const transition of transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to)
        changed = true
      }
    }
  }
  return reachable
}

function uniqueNames(input, label, allowEmpty = false) {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    fail(`invalid-${label}-set`)
  }
  const values = [...input]
  for (const value of values) {
    if (!NAME.test(value)) fail(`invalid-${label}`, { value })
  }
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`)
  return values.sort(compareText)
}

function exactFields(input, expected, label) {
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    const unexpected = actual.find((field) => !wanted.includes(field))
    fail(
      unexpected === undefined ? `missing-${label}-field` : `unexpected-${label}-field`,
      unexpected === undefined ? {} : { field: unexpected },
    )
  }
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
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

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function compareState(left, right) {
  return compareText(left.state, right.state)
}

function compareTransition(left, right) {
  return compareText(left.from, right.from) ||
    compareText(left.event, right.event) ||
    compareText(left.to, right.to)
}

function fail(code, detail = {}) {
  const error = new Error(code)
  error.diagnostic = { code, ...detail }
  throw error
}

function rejected(error) {
  return {
    diagnostics: [error?.diagnostic ?? { code: 'malformed-agent-contract' }],
    ok: false,
  }
}
