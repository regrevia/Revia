import assert from 'node:assert/strict'
import test from 'node:test'

import {
  businessFunctionDigest,
  validateBusinessFunction,
} from '../src/toolchain/business-function.js'

const declared = (character) => ({
  arguments: [],
  declaration_digest: `sha256:${character.repeat(64)}`,
  kind: 'declared',
})

function contract() {
  return {
    body: {
      calls: [],
      capability_calls: [{
        capability: {
          instance: '@expense_db',
          member: 'read',
          reference: 'db.read@0.1.0',
        },
        error_type: declared('c'),
        id: 'load',
        input_type: declared('a'),
        node_uid: `${'d'.repeat(25)}e`,
        output_type: declared('b'),
        resource: { access: 'read', constructor: 'expense_db' },
      }],
      control_flow: {
        kind: 'result-flow',
        propagation: false,
        schema: 're.control-flow-contract@0.1.0',
        uses: [{ kind: 'match', variants: ['err', 'ok'] }],
        value: {
          endpoint: 'load.result',
          type: { kind: 'sum', variants: ['err', 'ok'] },
        },
      },
      effect_edges: [{
        access: 'read',
        call: 'load',
        from: 'request',
        resource: 'expense_db',
        to: 'load',
      }],
    },
    error_type: declared('c'),
    input_type: declared('a'),
    module: 'agent.expense.intake',
    name: 'review',
    output_type: declared('b'),
    schema: 're.function-declaration@0.1.0',
  }
}

test('business function freezes typed signature, control flow, capability, and effect edges', () => {
  const first = validateBusinessFunction(contract())
  const reordered = contract()
  reordered.body.control_flow.uses[0].variants.reverse()

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics))
  assert.equal(validateBusinessFunction(reordered).ok, true)
  assert.equal(businessFunctionDigest(reordered), businessFunctionDigest(contract()))
  assert.equal(first.value.body.control_flow.construct, 'result-flow')
})

test('business function rejects nonexhaustive flow and mismatched effect authority', () => {
  const nonexhaustive = contract()
  nonexhaustive.body.control_flow.uses[0].variants = ['ok']
  const flow = validateBusinessFunction(nonexhaustive)
  assert.equal(flow.ok, false)
  assert.equal(flow.diagnostics[0].code, 'invalid-function-control-flow')

  const mismatched = contract()
  mismatched.body.effect_edges[0].resource = 'other_db'
  const effect = validateBusinessFunction(mismatched)
  assert.equal(effect.ok, false)
  assert.equal(effect.diagnostics[0].code, 'function-effect-edge-mismatch')
})
