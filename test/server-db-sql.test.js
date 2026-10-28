import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  buildServerProfile,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'

const corpus = JSON.parse(fs.readFileSync(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('db.sql schema separates statements from bound parameters', () => {
  const schema = serverProfileSchemaDefinitions()
    .find(({ identity }) => identity === 'db.sql')

  assert.equal(schema.revision, '0.1.0')
  assert.deepEqual(Object.keys(schema.members).sort(), [
    'begin',
    'commit',
    'execute',
    'query',
    'rollback',
  ])
  assert.deepEqual(
    schema.members.query.params.map(({ name, type }) => ({ name, type })),
    [
      { name: 'bound_parameters', type: 'bytes' },
      { name: 'database', type: 'text.utf8' },
      { name: 'statement', type: 'text.utf8' },
      { name: 'transaction', type: 'text.utf8' },
    ],
  )
  assert.deepEqual(
    schema.types['db.sql_error'].variants,
    ['conflict', 'invalid_statement', 'invalid_transaction', 'unavailable'],
  )

  const profile = buildServerProfile()
  assert.equal(profile.ok, true)
  assert.equal(
    profile.value.capabilities.some(({ reference }) => (
      reference === 'db.sql@0.1.0'
    )),
    true,
  )
})

test('db.sql memory adapter replays statements through explicit transactions', async () => {
  const {
    ServerDbSqlMemoryAdapter,
    sqlOperationKey,
  } = await import('../src/host/server-db-sql-memory-adapter.js')

  for (const vector of corpus.db_sql_vectors) {
    const outcomes = new Map(vector.outcomes.map((entry) => [
      sqlOperationKey({
        bound_parameters: Uint8Array.from(
          Buffer.from(entry.bound_parameters_hex, 'hex'),
        ),
        database: entry.database,
        member: entry.member,
        statement: entry.statement,
        transaction: entry.transaction,
      }),
      entry.outcome,
    ]))
    const transactions = [...vector.transactions]
    const commitConflicts = new Set(vector.commit_conflicts ?? [])
    const adapter = new ServerDbSqlMemoryAdapter({
      commitConflicts,
      outcomes,
      transactions,
      unavailable: vector.unavailable === true,
    })

    transactions.push('mutated-after-construction')
    commitConflicts.add('mutated-after-construction')
    const firstOutcome = outcomes.entries().next().value
    if (firstOutcome !== undefined) outcomes.set(firstOutcome[0], 'mutated')

    for (const step of vector.steps) {
      const argumentsValue = {
        bound_parameters: Uint8Array.from(
          Buffer.from(step.bound_parameters_hex ?? '', 'hex'),
        ),
        database: step.database,
        statement: step.statement ?? '',
        transaction: step.transaction ?? '',
      }
      const actual = adapter.invoke(
        { interface: 'db.sql@0.1.0', member: step.member },
        argumentsValue,
      )
      const expected = step.expected_error === undefined
        ? {
            kind: 'value',
            value: {
              kind: 'ok',
              value: step.expected_unit === true ? null : step.expected,
            },
          }
        : {
            kind: 'value',
            value: {
              error: {
                type: 'db.sql_error',
                variant: step.expected_error,
              },
              kind: 'err',
            },
          }
      assert.deepEqual(actual, expected, `${vector.id}:${step.member}`)
    }
  }
})

test('db.sql memory adapter ignores overridden outcome registry iteration', async () => {
  const {
    ServerDbSqlMemoryAdapter,
    sqlOperationKey,
  } = await import('../src/host/server-db-sql-memory-adapter.js')
  const operation = {
    bound_parameters: new Uint8Array(),
    database: 'main',
    member: 'query',
    statement: 'select value',
    transaction: 'tx-1',
  }
  const key = sqlOperationKey(operation)
  let spoofCalls = 0
  const outcomes = new Map([[key, 'legit']])
  outcomes[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield [key, spoofCalls === 1 ? 'legit' : 'spoof']
  }
  const adapter = new ServerDbSqlMemoryAdapter({
    outcomes,
    transactions: ['tx-1'],
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'db.sql@0.1.0', member: 'begin' },
      { database: 'main' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'tx-1' } },
  )
  assert.deepEqual(
    adapter.invoke(
      { interface: 'db.sql@0.1.0', member: 'query' },
      {
        bound_parameters: operation.bound_parameters,
        database: operation.database,
        statement: operation.statement,
        transaction: operation.transaction,
      },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'legit' } },
  )
  assert.equal(spoofCalls, 0)
})

test('db.sql memory adapter ignores overridden commit conflict iteration', async () => {
  const {
    ServerDbSqlMemoryAdapter,
  } = await import('../src/host/server-db-sql-memory-adapter.js')
  let spoofCalls = 0
  const commitConflicts = new Set()
  commitConflicts[Symbol.iterator] = function* () {
    spoofCalls += 1
    if (spoofCalls > 1) yield 'tx-1'
  }
  const adapter = new ServerDbSqlMemoryAdapter({
    commitConflicts,
    transactions: ['tx-1'],
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'db.sql@0.1.0', member: 'begin' },
      { database: 'main' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'tx-1' } },
  )
  assert.deepEqual(
    adapter.invoke(
      { interface: 'db.sql@0.1.0', member: 'commit' },
      { database: 'main', transaction: 'tx-1' },
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.equal(spoofCalls, 0)
})

test('db.sql memory adapter ignores overridden transaction queue iteration', async () => {
  const {
    ServerDbSqlMemoryAdapter,
  } = await import('../src/host/server-db-sql-memory-adapter.js')
  let spoofCalls = 0
  const transactions = ['tx-legit']
  transactions[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield spoofCalls === 1 ? 'tx-legit' : 'tx-spoof'
  }
  const adapter = new ServerDbSqlMemoryAdapter({ transactions })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'db.sql@0.1.0', member: 'begin' },
      { database: 'main' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'tx-legit' } },
  )
  assert.equal(spoofCalls, 0)
})

test('db.sql memory adapter rejects invalid fixture outcomes', async () => {
  const {
    ServerDbSqlMemoryAdapter,
    sqlOperationKey,
  } = await import('../src/host/server-db-sql-memory-adapter.js')
  const key = sqlOperationKey({
    bound_parameters: new Uint8Array(),
    database: 'main',
    member: 'query',
    statement: 'select 1',
    transaction: 'tx-1',
  })

  assert.throws(
    () => new ServerDbSqlMemoryAdapter({
      outcomes: new Map([[key, { error: 'driver_panicked' }]]),
    }),
    /closed errors/,
  )
})
