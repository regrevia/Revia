import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import {
  ServerDbSqlDriverAdapter,
} from '../src/host/server-db-sql-driver-adapter.js'
import {
  ServerDbSqlMemoryAdapter,
  sqlOperationKey,
} from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_DB_SQL_ADAPTER_CONTRACT,
  SERVER_DB_SQL_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('Server db.sql driver adapter passes the shared SQL corpus', () => {
  for (const vector of corpus.db_sql_vectors) {
    const memory = memoryAdapterFromVector(vector)
    const adapter = new ServerDbSqlDriverAdapter({
      driver: driverFromAdapter(memory),
      unavailable: vector.unavailable === true,
    })
    for (const step of vector.steps) {
      assert.deepEqual(
        invoke(adapter, step.member, argumentsFromStep(step)),
        expectedFromStep(step),
        `${vector.id}:${step.member}`,
      )
    }
  }
})

test('Server db.sql driver receives one copied exact operation', () => {
  const parameters = Uint8Array.of(0x5b, 0x31, 0x5d)
  const calls = []
  const adapter = new ServerDbSqlDriverAdapter({
    driver: {
      query(request) {
        calls.push(request)
        request.bound_parameters[0] = 0x00
        return '[{"name":"Ada"}]'
      },
    },
  })
  assert.deepEqual(invoke(adapter, 'query', {
    bound_parameters: parameters,
    database: 'main',
    statement: 'select name from users where id = ?',
    transaction: 'tx-1',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '[{"name":"Ada"}]' },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(parameters, Uint8Array.of(0x5b, 0x31, 0x5d))
})

test('db.sql operation keys use typed array internal bytes', () => {
  class SpoofLengthBytes extends Uint8Array {
    get length() {
      return 0
    }
  }
  const operation = {
    bound_parameters: new SpoofLengthBytes([0x11, 0x22]),
    database: 'main',
    member: 'query',
    statement: 'select value from items where id = ?',
    transaction: 'tx-1',
  }
  const calls = []
  const adapter = new ServerDbSqlDriverAdapter({
    driver: {
      query(request) {
        calls.push(request)
        return '[]'
      },
    },
  })

  assert.equal(
    sqlOperationKey(operation),
    '["query","main","tx-1","select value from items where id = ?","1122"]',
  )
  assert.deepEqual(invoke(adapter, 'query', operation), {
    kind: 'value',
    value: { kind: 'ok', value: '[]' },
  })
  assert.deepEqual(calls[0].bound_parameters, Uint8Array.of(0x11, 0x22))

  const memory = new ServerDbSqlMemoryAdapter({
    outcomes: new Map([[sqlOperationKey(operation), '[]']]),
    transactions: ['tx-1'],
  })
  assert.deepEqual(invoke(memory, 'begin', { database: 'main' }), {
    kind: 'value',
    value: { kind: 'ok', value: 'tx-1' },
  })
  assert.deepEqual(invoke(memory, 'query', operation), {
    kind: 'value',
    value: { kind: 'ok', value: '[]' },
  })

  const proxyParameters = new Proxy(Uint8Array.of(0x11, 0x22), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  assert.deepEqual(invoke(adapter, 'query', {
    ...operation,
    bound_parameters: proxyParameters,
  }), declaredError('invalid_statement'))
  assert.deepEqual(invoke(memory, 'query', {
    ...operation,
    bound_parameters: proxyParameters,
  }), declaredError('invalid_statement'))
  assert.equal(calls.length, 1)
})

test('Server db.sql driver validates typed outcomes and closes failures', () => {
  assert.deepEqual(invoke(new ServerDbSqlDriverAdapter(), 'begin', {
    database: 'main',
  }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerDbSqlDriverAdapter({
    driver: { begin: () => 42 },
  }), 'begin', { database: 'main' }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerDbSqlDriverAdapter({
    driver: {
      execute: () => {
        throw new Error('driver details')
      },
    },
  }), 'execute', {
    bound_parameters: new Uint8Array(),
    database: 'main',
    statement: 'update users set active = 1',
    transaction: 'tx-1',
  }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerDbSqlDriverAdapter({
    driver: { query: () => ({ error: 'conflict' }) },
  }), 'query', {
    bound_parameters: new Uint8Array(),
    database: 'main',
    statement: 'select 1',
    transaction: 'tx-1',
  }), declaredError('conflict'))
})

test('Server db.sql driver snapshots method authority', () => {
  let queryReads = 0
  let queryCalls = 0
  const driver = {}
  const query = function (request) {
    assert.equal(this, driver)
    queryCalls += 1
    assert.equal(request.database, 'main')
    return '[{"name":"Ada"}]'
  }
  Object.defineProperty(query, 'bind', {
    configurable: true,
    get() {
      throw new Error('driver method bind fault')
    },
  })
  Object.defineProperty(driver, 'query', {
    configurable: true,
    get() {
      queryReads += 1
      if (queryReads > 1) throw new Error('driver query getter fault')
      return query
    },
  })
  const adapter = new ServerDbSqlDriverAdapter({ driver })

  assert.deepEqual(invoke(adapter, 'query', {
    bound_parameters: new Uint8Array(),
    database: 'main',
    statement: 'select name from users',
    transaction: 'tx-1',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '[{"name":"Ada"}]' },
  })
  assert.equal(queryReads, 1)
  assert.equal(queryCalls, 1)
})

test('Server profile accepts shared SQL contract and rejects the old identity', () => {
  const adapter = new ServerDbSqlDriverAdapter({
    driver: { begin: () => 'tx-1' },
  })
  assert.equal(adapter.adapterContract(), SERVER_DB_SQL_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_DB_SQL_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'db.sql')
      .resource_catalog,
  )
  assert.equal(bindServerProfile(requiredBindings(adapter)).ok, true)

  class LegacyContractAdapter extends ServerDbSqlDriverAdapter {
    adapterContract() {
      return 're.server-db-sql-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter({
      driver: { begin: () => 'tx-1' },
    }))),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_DB_SQL_ADAPTER_CONTRACT,
        instance: '@sql',
      }],
      ok: false,
    },
  )
})

function driverFromAdapter(adapter) {
  return Object.fromEntries(
    ['begin', 'commit', 'execute', 'query', 'rollback'].map((member) => [
      member,
      (request) => {
        const result = adapter.invoke(
          { interface: SERVER_DB_SQL_REFERENCE, member },
          request,
        ).value
        return result.kind === 'ok' ? result.value : { error: result.error.variant }
      },
    ]),
  )
}

function memoryAdapterFromVector(vector) {
  return new ServerDbSqlMemoryAdapter({
    commitConflicts: new Set(vector.commit_conflicts ?? []),
    outcomes: new Map(vector.outcomes.map((entry) => [
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
    ])),
    transactions: vector.transactions,
  })
}

function argumentsFromStep(step) {
  return {
    bound_parameters: Uint8Array.from(
      Buffer.from(step.bound_parameters_hex ?? '', 'hex'),
    ),
    database: step.database,
    statement: step.statement ?? '',
    transaction: step.transaction ?? '',
  }
}

function expectedFromStep(step) {
  return step.expected_error === undefined
    ? {
        kind: 'value',
        value: {
          kind: 'ok',
          value: step.expected_unit === true ? null : step.expected,
        },
      }
    : declaredError(step.expected_error)
}

function invoke(adapter, member, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_DB_SQL_REFERENCE, member },
    typedArguments,
  )
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'db.sql_error', variant },
      kind: 'err',
    },
  }
}

function requiredBindings(dbSqlAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter: new ServerConfigMemoryAdapter(),
    dbSqlAdapter,
    httpClientAdapter: new ServerHttpClientMemoryAdapter(),
    httpServerAdapter: new ServerHttpServerMemoryAdapter(),
    jsonAdapter: new ServerJsonMemoryAdapter(),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
