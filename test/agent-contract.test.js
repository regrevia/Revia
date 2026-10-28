import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  agentContractDigest,
  applyAgentEvent,
  validateAgentContract,
} from '../src/toolchain/agent-contract.js'

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/agent-lifecycle-corpus.json', import.meta.url), 'utf8'),
)

test('agent lifecycle contract is typed, closed, and declaration-order independent', () => {
  const first = validateAgentContract(fixture.contract)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.schema, 're.agent-lifecycle@0.1.0')
  assert.equal(first.value.contract.agent, 'agent.expense.intake')
  assert.equal(first.value.state_machine.construct, 'state-machine')
  assert.equal(first.value.terminal_states.length, 4)
  assert.equal(first.value.transitions.length, 15)

  const reordered = structuredClone(fixture.contract)
  reordered.states.reverse()
  reordered.events.reverse()
  reordered.terminal_states.reverse()
  reordered.transitions.reverse()
  reordered.retryable_states.reverse()
  assert.deepEqual(validateAgentContract(reordered), first)
  assert.equal(agentContractDigest(reordered), agentContractDigest(fixture.contract))
})

test('agent lifecycle event application rejects illegal and terminal transitions', () => {
  assert.deepEqual(
    applyAgentEvent(fixture.contract, { agent: 'agent.expense.intake', state: 'created' }, 'ready'),
    {
      ok: true,
      value: {
        agent: 'agent.expense.intake',
        event: 'ready',
        from: 'created',
        state: 'ready',
      },
    },
  )
  assert.equal(
    applyAgentEvent(
      fixture.contract,
      { agent: 'agent.expense.intake', state: 'created' },
      'task_succeeded',
    ).diagnostics[0].code,
    'illegal-agent-transition',
  )
  assert.equal(
    applyAgentEvent(
      fixture.contract,
      { agent: 'agent.expense.intake', state: 'succeeded' },
      'shutdown',
    ).diagnostics[0].code,
    'agent-terminal-state',
  )
})

test('agent lifecycle rejects duplicate identity and malformed transition authority', () => {
  const duplicateState = structuredClone(fixture.contract)
  duplicateState.states.push('ready')
  assert.equal(validateAgentContract(duplicateState).diagnostics[0].code, 'duplicate-agent-state')

  const duplicateTransition = structuredClone(fixture.contract)
  duplicateTransition.transitions.push(structuredClone(duplicateTransition.transitions[0]))
  assert.equal(
    validateAgentContract(duplicateTransition).diagnostics[0].code,
    'duplicate-agent-transition',
  )

  const terminalTransition = structuredClone(fixture.contract)
  terminalTransition.transitions.push({
    event: 'shutdown',
    from: 'succeeded',
    to: 'stopped',
  })
  assert.equal(
    validateAgentContract(terminalTransition).diagnostics[0].code,
    'terminal-agent-state-has-transition',
  )

  const extraField = structuredClone(fixture.contract)
  extraField.runtime = 'implicit'
  assert.equal(
    validateAgentContract(extraField).diagnostics[0].code,
    'unexpected-agent-contract-field',
  )
})

test('agent lifecycle rejects unknown, unreachable, and untyped declarations', () => {
  const unknownTarget = structuredClone(fixture.contract)
  unknownTarget.transitions[0].to = 'missing'
  assert.equal(
    validateAgentContract(unknownTarget).diagnostics[0].code,
    'agent-transition-state-not-found',
  )

  const unreachable = structuredClone(fixture.contract)
  unreachable.states.push('orphaned')
  assert.equal(
    validateAgentContract(unreachable).diagnostics[0].code,
    'unreachable-agent-state',
  )

  const invalidType = structuredClone(fixture.contract)
  invalidType.input_type = { kind: 'exception' }
  assert.equal(
    validateAgentContract(invalidType).diagnostics[0].code,
    'invalid-agent-input-type',
  )
})
