import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBusinessFunction } from '../src/toolchain/business-function-executor.js'
import { typeDeclarationDigest } from '../src/toolchain/type-contract.js'

const profile = {
  digest: `sha256:${'9'.repeat(64)}`,
  id: 'server-minimum@0.1.0',
  schema: 're.server-profile@0.1.0',
}

const currencyDeclaration = declaration('currency', {
  kind: 'sum',
  variants: [
    { name: 'usd' },
    { name: 'cny' },
  ],
})
const currencyType = {
  arguments: [],
  declaration_digest: typeDeclarationDigest(currencyDeclaration),
  kind: 'declared',
}

const declarations = [
  currencyDeclaration,
  declaration('input', {
    fields: [
      { name: 'amount', type: { kind: 'decimal', scale: 2 } },
      { name: 'currency', type: currencyType },
    ],
    kind: 'record',
  }),
  declaration('result', {
    fields: [
      { name: 'approved', type: { kind: 'primitive', name: 'bool' } },
      { name: 'currency', type: currencyType },
    ],
    kind: 'record',
  }),
  declaration('error', {
    fields: [
      { name: 'type', type: { kind: 'primitive', name: 'text.utf8' } },
      { name: 'variant', type: { kind: 'primitive', name: 'text.utf8' } },
    ],
    kind: 'record',
  }),
]

const type = (name) => ({
  arguments: [],
  declaration_digest: typeDeclarationDigest(
    declarations.find((entry) => entry.name === name),
  ),
  kind: 'declared',
})

function businessFunction() {
  return {
    body: {
      calls: [],
      capability_calls: [{
        capability: {
          instance: '@expense_db',
          member: 'read',
          reference: 'db.read@0.1.0',
        },
        error_type: type('error'),
        id: 'expense_db_read',
        input_type: type('input'),
        node_uid: `${'d'.repeat(25)}e`,
        output_type: type('result'),
        resource: { access: 'read', constructor: 'expense_db' },
      }],
      control_flow: {
        construct: 'result-flow',
        edges: [{
          consumer: true,
          from: 'expense_db_read.result',
          kind: 'value',
          to: 'result.use.0',
        }],
        nodes: [
          {
            id: 'expense_db_read.result',
            kind: 'result-value',
            type: { kind: 'sum', variants: ['err', 'ok'] },
          },
          { id: 'result.use.0', kind: 'match', variants: ['err', 'ok'] },
        ],
        output: null,
        schema: 're.control-flow-graph@0.1.0',
      },
      effect_edges: [{
        access: 'read',
        call: 'expense_db_read',
        from: 'request',
        resource: 'expense_db',
        to: 'expense_db_read',
      }],
    },
    error_type: type('error'),
    input_type: type('input'),
    module: 'agent.expense.intake',
    name: 'review',
    output_type: type('result'),
    schema: 're.function-declaration@0.1.0',
  }
}

function adapterContract() {
  return {
    agent: 'agent.expense.intake',
    capability: {
      instance: '@expense_db',
      member: 'read',
      reference: 'db.read@0.1.0',
    },
    cancellation: { mode: 'cooperative', supported: true },
    deadline: { max_ms: 0, required: false },
    error_type: { kind: 'type', name: 'agent.expense.intake.error' },
    error_variants: ['transient', 'unavailable'],
    features: ['cancellation'],
    input_type: { kind: 'type', name: 'agent.expense.intake.input' },
    module: 'agent.expense.intake',
    node_uid: `${'d'.repeat(25)}e`,
    output_type: { kind: 'type', name: 'agent.expense.intake.result' },
    profile,
    request_type: { kind: 'type', name: 'agent.expense.intake.input' },
    resource: { access: 'read', constructor: 'expense_db' },
    schema: 're.agent-adapter-contract@0.1.0',
  }
}

test('business executor validates concrete input before invoking the host', async () => {
  for (const input of [
    { amount: '125.0', currency: { variant: 'usd' } },
    { amount: '125.00', currency: 'USD' },
    { amount: '125.00', currency: { variant: 'eur' } },
    { amount: '125.00', currency: { variant: 'usd', value: 'legacy' } },
  ]) {
    let calls = 0
    const result = await executeBusinessFunction({
      adapter: adapter(() => {
        calls += 1
        return ok({ approved: true, currency: { variant: 'usd' } })
      }),
      adapter_contract: adapterContract(),
      declarations,
      function_declaration: businessFunction(),
      input,
      request_id: 'expense-1:1',
    })

    assert.equal(result.ok, false)
    assert.equal(result.diagnostics[0].code, 'business-function-input-invalid')
    assert.equal(calls, 0)
  }
})

test('business executor exact-binds capability types and returns typed host evidence', async () => {
  let observed = null
  const result = await executeBusinessFunction({
    adapter: adapter((input) => {
      observed = input
      return ok({ approved: true, currency: { variant: 'usd' } })
    }),
    adapter_contract: adapterContract(),
    declarations,
    function_declaration: businessFunction(),
    input: { currency: { variant: 'usd' }, amount: '125.00' },
    request_id: 'expense-1:1',
  })

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics))
  assert.deepEqual(observed, {
    amount: '125.00',
    currency: { variant: 'usd' },
  })
  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.equal(result.value.schema, 're.business-function-execution@0.1.0')
  assert.deepEqual(result.value.trace.map(({ call }) => call), ['expense_db_read'])

  const drifted = adapterContract()
  drifted.output_type.name = 'agent.expense.intake.input'
  const rejected = await executeBusinessFunction({
    adapter: adapter(() => ok({
      approved: true,
      currency: { variant: 'usd' },
    })),
    adapter_contract: drifted,
    declarations,
    function_declaration: businessFunction(),
    input: { amount: '125.00', currency: { variant: 'usd' } },
    request_id: 'expense-1:1',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.diagnostics[0].code, 'business-function-capability-type-mismatch')

  const legacyOutput = await executeBusinessFunction({
    adapter: adapter(() => ok({ approved: true, currency: 'USD' })),
    adapter_contract: adapterContract(),
    declarations,
    function_declaration: businessFunction(),
    input: { amount: '125.00', currency: { variant: 'usd' } },
    request_id: 'expense-1:1',
  })
  assert.equal(legacyOutput.ok, false)
  assert.equal(
    legacyOutput.diagnostics[0].code,
    'business-function-output-invalid',
  )
})

test('business executor cannot bypass a body without a declared capability call', async () => {
  let calls = 0
  const declaration = businessFunction()
  declaration.body.capability_calls = []
  declaration.body.effect_edges = []
  const result = await executeBusinessFunction({
    adapter: adapter(() => {
      calls += 1
      return ok({ approved: true, currency: { variant: 'usd' } })
    }),
    adapter_contract: adapterContract(),
    declarations,
    function_declaration: declaration,
    input: { amount: '125.00', currency: { variant: 'usd' } },
    request_id: 'expense-1:1',
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'unsupported-business-function-body')
  assert.equal(calls, 0)
})

function declaration(name, body) {
  return {
    body,
    module: 'agent.expense.intake',
    name,
    parameters: [],
    schema: 're.type-declaration@0.1.0',
  }
}

function adapter(invoke) {
  return {
    invoke: (_operation, input) => invoke(input),
    profileIdentity: () => profile,
  }
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}
