import assert from 'node:assert/strict'
import test from 'node:test'

import { invokeAgentCapability } from '../src/host/agent-adapter-contract.js'

const profile = {
  digest: 'sha256:4ace4315fa907f0bfa8458e88f1d3a10b0a16214e7813b431f6859b43a9b4b2f',
  id: 'server-minimum@0.1.0',
  schema: 're.server-profile@0.1.0',
}

test('business HTTP adapter sends canonical JSON and returns a typed outcome', async () => {
  const module = await import('../src/host/agent-business-http-adapter.js')
    .catch(() => ({}))
  assert.equal(typeof module.AgentBusinessHttpAdapter, 'function')
  let observed
  const adapter = new module.AgentBusinessHttpAdapter({
    contract: contract(),
    endpoint: 'http://127.0.0.1:3210/expense/review',
    profile,
    timeout_ms: 1000,
    transport(request) {
      observed = request
      return JSON.stringify({
        body: JSON.stringify({
          kind: 'ok',
          value: { approved: true, currency: 'usd' },
        }),
        status: 200,
      })
    },
  })

  const result = await invokeAgentCapability(
    contract(),
    adapter,
    call({ amount: '125.00', currency: { variant: 'usd' } }),
  )

  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.equal(observed.method, 'POST')
  assert.equal(observed.url, 'http://127.0.0.1:3210/expense/review')
  assert.equal(observed.headers, 'content-type:application/json')
  assert.equal(
    Buffer.from(observed.body).toString('utf8'),
    '{"amount":"125.00","currency":"usd"}',
  )
})

test('business HTTP currency projection is text and has no language-level whitelist', async () => {
  const { AgentBusinessHttpAdapter } =
    await import('../src/host/agent-business-http-adapter.js')
  let body
  const adapter = new AgentBusinessHttpAdapter({
    contract: contract(),
    endpoint: 'http://127.0.0.1:3210/expense/review',
    profile,
    transport(request) {
      body = Buffer.from(request.body).toString('utf8')
      return JSON.stringify({
        body: JSON.stringify({
          kind: 'ok',
          value: { approved: true, currency: 'brl' },
        }),
        status: 200,
      })
    },
  })
  const result = await invokeAgentCapability(
    contract(),
    adapter,
    call({ amount: '125.00', currency: { variant: 'brl' } }),
  )

  assert.equal(body, '{"amount":"125.00","currency":"brl"}')
  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'brl' } },
  })
})

test('business HTTP adapter rejects endpoint credentials and unsafe endpoint drift', async () => {
  const { AgentBusinessHttpAdapter } =
    await import('../src/host/agent-business-http-adapter.js')
  for (const endpoint of [
    '/expense/review',
    'http://user:secret@127.0.0.1:3210/expense/review',
    'file:///tmp/expense-review',
    'http://127.0.0.1:3210/expense/review#fragment',
  ]) {
    assert.throws(
      () => new AgentBusinessHttpAdapter({ contract: contract(), endpoint, profile }),
      /invalid agent HTTP endpoint/,
    )
  }
})

test('business HTTP adapter fails closed for malformed responses and transport failures', async () => {
  const { AgentBusinessHttpAdapter } =
    await import('../src/host/agent-business-http-adapter.js')
  for (const transport of [
    () => '{"status":200,"body":"not-json"}',
    () => '{"status":201,"body":"{\\"kind\\":\\"ok\\",\\"value\\":{}}"}',
    () => '{"status":200,"body":"{\\"kind\\":\\"ok\\",\\"value\\":{},\\"extra\\":true}"}',
    () => { throw new Error('secret transport detail') },
  ]) {
    const result = await invokeAgentCapability(
      contract(),
      new AgentBusinessHttpAdapter({
        contract: contract(),
        endpoint: 'http://127.0.0.1:3210/expense/review',
        profile,
        transport,
      }),
      call({ amount: '125.00', currency: { variant: 'usd' } }),
    )
    if (result.value.outcome.kind === 'err') {
      assert.deepEqual(result.value.outcome, {
        error: {
          type: 'agent.expense.intake.error',
          variant: 'unavailable',
        },
        kind: 'err',
      })
    } else {
      assert.deepEqual(result.value.outcome, { kind: 'host-fault' })
      assert.equal(Object.hasOwn(result.value, 'raw'), false)
    }
  }
})

test('business HTTP adapter rejects undeclared business errors', async () => {
  const { AgentBusinessHttpAdapter } =
    await import('../src/host/agent-business-http-adapter.js')
  const result = await invokeAgentCapability(
    contract(),
    new AgentBusinessHttpAdapter({
      contract: contract(),
      endpoint: 'http://127.0.0.1:3210/expense/review',
      profile,
      transport: () => JSON.stringify({
        body: JSON.stringify({
          error: { type: 'agent.expense.intake.error', variant: 'secret_leak' },
          kind: 'err',
        }),
        status: 200,
      }),
    }),
    call({ amount: '125.00', currency: { variant: 'usd' } }),
  )
  assert.deepEqual(result.value.outcome, { kind: 'host-fault' })
  assert.equal(result.value.fault.reason, 'malformed-adapter-outcome')
})

function call(input) {
  return {
    capability_reference: 'db.read@0.1.0',
    cancellation: null,
    deadline: null,
    input,
    member: 'read',
    request_id: 'expense-001:1',
  }
}

function contract() {
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
