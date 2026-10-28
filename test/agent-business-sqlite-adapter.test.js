import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { invokeAgentCapability } from '../src/host/agent-adapter-contract.js'

const profile = {
  digest: 'sha256:4ace4315fa907f0bfa8458e88f1d3a10b0a16214e7813b431f6859b43a9b4b2f',
  id: 'server-minimum@0.1.0',
  schema: 're.server-profile@0.1.0',
}

test('business SQLite adapter binds project currency as ordinary text', async (t) => {
  const { AgentBusinessSqliteAdapter } =
    await import('../src/host/agent-business-sqlite-adapter.js')
      .catch(() => ({}))
  assert.equal(typeof AgentBusinessSqliteAdapter, 'function')

  const database = decisionDatabase()
  t.after(() => database.close())
  insertDecision(database, {
    amount: '125.00',
    approved: 1,
    currency: 'usd',
    requestId: 'expense-001:1',
  })
  const adapter = new AgentBusinessSqliteAdapter({
    contract: contract(),
    database,
    database_name: 'expense',
    profile,
  })

  const result = await invokeAgentCapability(
    contract(),
    adapter,
    call(
      { amount: '125.00', currency: { variant: 'usd' } },
      'expense-001:1',
    ),
  )

  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.equal(
    database.prepare(
      'select typeof(request_currency) as kind from expense_review_decisions',
    ).get().kind,
    'text',
  )
})

test('business SQLite currency projection has no language-level whitelist', async (t) => {
  const { AgentBusinessSqliteAdapter } =
    await import('../src/host/agent-business-sqlite-adapter.js')
  const database = decisionDatabase()
  t.after(() => database.close())
  insertDecision(database, {
    amount: '125.00',
    approved: 1,
    currency: 'brl',
    requestId: 'expense-br:1',
  })

  const result = await invokeAgentCapability(
    contract(),
    new AgentBusinessSqliteAdapter({
      contract: contract(),
      database,
      database_name: 'expense',
      profile,
    }),
    call(
      { amount: '125.00', currency: { variant: 'brl' } },
      'expense-br:1',
    ),
  )

  assert.deepEqual(result.value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'brl' } },
  })
})

test('business SQLite adapter returns declared transient errors from exact rows', async (t) => {
  const { AgentBusinessSqliteAdapter } =
    await import('../src/host/agent-business-sqlite-adapter.js')
  const database = decisionDatabase()
  t.after(() => database.close())
  insertDecision(database, {
    amount: '125.00',
    currency: 'usd',
    errorVariant: 'transient',
    requestId: 'expense-001:1',
  })

  const result = await invokeAgentCapability(
    contract(),
    new AgentBusinessSqliteAdapter({
      contract: contract(),
      database,
      database_name: 'expense',
      profile,
    }),
    call(
      { amount: '125.00', currency: { variant: 'usd' } },
      'expense-001:1',
    ),
  )

  assert.deepEqual(result.value.outcome, {
    error: {
      type: 'agent.expense.intake.error',
      variant: 'transient',
    },
    kind: 'err',
  })
})

test('business SQLite adapter fails closed for missing, duplicate, and malformed rows', async (t) => {
  const { AgentBusinessSqliteAdapter } =
    await import('../src/host/agent-business-sqlite-adapter.js')
  const cases = [
    [],
    [
      { approved: 1, currency: 'usd' },
      { approved: 1, currency: 'usd' },
    ],
    [{ approved: 2, currency: 'usd' }],
    [{ approved: 1, currency: 'usd', resultCurrency: 7 }],
    [{ currency: 'usd', errorVariant: 'secret_leak' }],
  ]

  for (const [index, rows] of cases.entries()) {
    const database = decisionDatabase()
    t.after(() => database.close())
    for (const row of rows) {
      insertDecision(database, {
        amount: '125.00',
        approved: row.approved,
        currency: row.currency,
        errorVariant: row.errorVariant,
        requestId: `invalid-${index}`,
        resultCurrency: row.resultCurrency,
      })
    }
    const result = await invokeAgentCapability(
      contract(),
      new AgentBusinessSqliteAdapter({
        contract: contract(),
        database,
        database_name: 'expense',
        profile,
      }),
      call(
        { amount: '125.00', currency: { variant: 'usd' } },
        `invalid-${index}`,
      ),
    )
    assert.deepEqual(result.value.outcome, { kind: 'host-fault' })
    assert.equal(Object.hasOwn(result.value, 'raw'), false)
  }
})

function decisionDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency,
      outcome text not null,
      approved,
      result_currency,
      error_variant
    )
  `)
  return database
}

function insertDecision(database, {
  amount,
  approved = null,
  currency = null,
  errorVariant = null,
  requestId,
  requestCurrency = currency,
  resultCurrency = errorVariant === null ? currency : null,
}) {
  database.prepare(`
    insert into expense_review_decisions (
      request_id,
      amount,
      request_currency,
      outcome,
      approved,
      result_currency,
      error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    amount,
    requestCurrency,
    errorVariant === null ? 'ok' : 'err',
    approved,
    resultCurrency,
    errorVariant,
  )
}

function call(input, requestId) {
  return {
    capability_reference: 'db.read@0.1.0',
    cancellation: null,
    deadline: null,
    input,
    member: 'read',
    request_id: requestId,
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
