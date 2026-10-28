import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import {
  ServerDbSqlDriverAdapter,
} from '../src/host/server-db-sql-driver-adapter.js'
import {
  createServerDbSqlNodeSqliteDriver,
} from '../src/host/server-db-sql-node-sqlite-driver.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_DB_SQL_REFERENCE,
} from '../src/host/server-profile.js'

test('Node SQLite driver commits parameterized writes through the Server profile', async (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec(`
    create table users (
      id integer primary key,
      name text not null,
      active integer not null
    )
  `)
  const adapter = sqliteAdapter(database)
  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)

  const begin = await bound.value.invokeAsync(
    '@sql',
    'begin',
    { database: 'main' },
    'sqlite-begin',
  )
  assert.equal(begin.kind, 'value')
  assert.equal(begin.value.kind, 'ok')
  const transaction = begin.value.value

  assert.deepEqual(await bound.value.invokeAsync(
    '@sql',
    'execute',
    sqlArguments(
      transaction,
      'insert into users (id, name, active) values (?, ?, ?)',
      [1, 'Ada', 1],
    ),
    'sqlite-insert',
  ), ok(1))
  assert.deepEqual(await bound.value.invokeAsync(
    '@sql',
    'query',
    sqlArguments(
      transaction,
      'select active, name from users where id = ?',
      [1],
    ),
    'sqlite-query',
  ), ok('[{"active":1,"name":"Ada"}]'))
  assert.deepEqual(await bound.value.invokeAsync(
    '@sql',
    'commit',
    { database: 'main', transaction },
    'sqlite-commit',
  ), ok(null))

  assert.equal(
    database.prepare('select name from users where id = ?').get(1).name,
    'Ada',
  )
})

test('Node SQLite driver rolls back and closes transaction tokens', (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec('create table counters (value integer not null)')
  database.exec('insert into counters values (7)')
  const adapter = sqliteAdapter(database)

  const transaction = invoke(adapter, 'begin', { database: 'main' }).value.value
  assert.deepEqual(invoke(
    adapter,
    'execute',
    sqlArguments(transaction, 'update counters set value = ?', [9]),
  ), ok(1))
  assert.deepEqual(invoke(adapter, 'rollback', {
    database: 'main',
    transaction,
  }), ok(null))
  assert.equal(
    database.prepare('select value from counters').get().value,
    7,
  )
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select value from counters', []),
  ), declaredError('invalid_transaction'))
  assert.deepEqual(invoke(adapter, 'commit', {
    database: 'main',
    transaction,
  }), declaredError('invalid_transaction'))
})

test('Node SQLite driver fails closed before unsafe or ambiguous execution', (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec('create table values_table (value text not null)')
  const adapter = sqliteAdapter(database)
  const transaction = invoke(adapter, 'begin', { database: 'main' }).value.value

  assert.deepEqual(invoke(adapter, 'begin', {
    database: 'main',
  }), declaredError('conflict'))
  assert.deepEqual(invoke(adapter, 'begin', {
    database: 'missing',
  }), declaredError('unavailable'))
  assert.deepEqual(invoke(adapter, 'execute', {
    bound_parameters: new TextEncoder().encode('{"value":"x"}'),
    database: 'main',
    statement: 'insert into values_table values (?)',
    transaction,
  }), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'execute',
    sqlArguments(
      transaction,
      'insert into values_table values (?)',
      ['x"); drop table values_table; --'],
    ),
  ), ok(1))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select from', []),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(
      transaction,
      'select value from values_table',
      [1],
      '[ 1 ]',
    ),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(
      transaction,
      'select value from values_table',
      [1],
      '[1.0]',
    ),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    {
      bound_parameters: Uint8Array.from([
        0xef, 0xbb, 0xbf, 0x5b, 0x31, 0x5d,
      ]),
      database: 'main',
      statement: 'select value from values_table',
      transaction,
    },
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(
      transaction,
      'insert into values_table values (?)',
      ['query-must-not-write'],
    ),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'execute',
    sqlArguments(transaction, 'select value from values_table', []),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(
      transaction,
      `with payload(value) as (select ?)
       insert into values_table select value from payload
       returning value`,
      ['cte-must-not-write'],
    ),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(adapter, 'query', sqlArguments(
    'wrong-token',
    'select value from values_table',
    [],
  )), declaredError('invalid_transaction'))

  assert.equal(
    database.prepare('select count(*) as count from values_table').get().count,
    1,
  )
})

test('Node SQLite driver snapshots direct bound parameter bytes before decoding', (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  const driver = createServerDbSqlNodeSqliteDriver({
    databases: new Map([['main', database]]),
  })
  const transaction = driver.begin({ database: 'main' })

  const internalInvalid = new Uint8Array([0xff])
  const spoofedIterator = new Proxy(internalInvalid, {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofedParameters() {
          yield* new TextEncoder().encode('[1]')
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  assert.deepEqual(driver.query({
    bound_parameters: spoofedIterator,
    database: 'main',
    statement: 'select ? as value',
    transaction,
  }), { error: 'invalid_statement' })

  class ShadowedLengthParameters extends Uint8Array {
    get length() {
      return 0
    }
  }
  const genuineParameters = new ShadowedLengthParameters(
    new TextEncoder().encode('[1]'),
  )
  assert.equal(driver.query({
    bound_parameters: genuineParameters,
    database: 'main',
    statement: 'select ? as value',
    transaction,
  }), '[{"value":1}]')
})

test('Node SQLite driver validates construction and stable row values', (t) => {
  assert.throws(
    () => createServerDbSqlNodeSqliteDriver({ databases: {} }),
    /databases must be a Map/,
  )
  assert.throws(
    () => createServerDbSqlNodeSqliteDriver({
      databases: new Map([['main', {}]]),
    }),
    /DatabaseSync handles/,
  )

  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  assert.throws(
    () => createServerDbSqlNodeSqliteDriver({
      databases: new Map([
        ['main', database],
        ['alias', database],
      ]),
    }),
    /unique DatabaseSync handles/,
  )
  database.exec('create table rows (z text, a integer)')
  database.exec("insert into rows values ('last', 2), ('first', 1)")
  const adapter = sqliteAdapter(database)
  const transaction = invoke(adapter, 'begin', { database: 'main' }).value.value

  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select z, a from rows order by a', []),
  ), ok('[{"a":1,"z":"first"},{"a":2,"z":"last"}]'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(
      transaction,
      'select 1 as "𐀀", 2 as ""',
      [],
    ),
  ), ok('[{"":2,"𐀀":1}]'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select randomblob(1) as blob', []),
  ), declaredError('invalid_statement'))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select 1 as value, 2 as value', []),
  ), declaredError('invalid_statement'))
})

test('Node SQLite driver snapshots query rows before serialization', (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  const originalPrepare = database.prepare
  let allReads = 0
  Object.defineProperty(database, 'prepare', {
    configurable: true,
    get() {
      return function (...args) {
        const statement = originalPrepare.apply(this, args)
        Object.defineProperty(statement, 'all', {
          configurable: true,
          get() {
            allReads += 1
            return () => {
              const row = {}
              let valueReads = 0
              Object.defineProperty(row, 'value', {
                enumerable: true,
                get() {
                  valueReads += 1
                  return valueReads === 1 ? 1 : 99
                },
              })
              const rows = [row]
              rows.map = () => [{ value: 99 }]
              return rows
            }
          },
        })
        return statement
      }
    },
  })
  const driver = createServerDbSqlNodeSqliteDriver({
    databases: new Map([['main', database]]),
  })
  const transaction = driver.begin({ database: 'main' })

  assert.equal(driver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select 1 as value',
    transaction,
  }), '[{"value":1}]')
  assert.equal(allReads, 1)

  const invalidDatabase = new DatabaseSync(':memory:')
  t.after(() => invalidDatabase.close())
  const invalidOriginalPrepare = invalidDatabase.prepare
  Object.defineProperty(invalidDatabase, 'prepare', {
    configurable: true,
    get() {
      return function (...args) {
        const statement = invalidOriginalPrepare.apply(this, args)
        Object.defineProperty(statement, 'all', {
          configurable: true,
          get() {
            return () => ({
              map: () => [{ value: 1 }],
            })
          },
        })
        return statement
      }
    },
  })
  const invalidDriver = createServerDbSqlNodeSqliteDriver({
    databases: new Map([['main', invalidDatabase]]),
  })
  const invalidTransaction = invalidDriver.begin({ database: 'main' })
  assert.deepEqual(invalidDriver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select 1 as value',
    transaction: invalidTransaction,
  }), { error: 'invalid_statement' })
})

test('Node SQLite driver snapshots statement columns before dispatch', (t) => {
  function instrumentDatabase(columnsResult) {
    const database = new DatabaseSync(':memory:')
    t.after(() => database.close())
    database.exec('create table values_table (value integer not null)')
    database.exec('insert into values_table values (1)')
    const originalPrepare = database.prepare
    let allCalls = 0
    let runCalls = 0
    Object.defineProperty(database, 'prepare', {
      configurable: true,
      get() {
        return function (...args) {
          const statement = originalPrepare.apply(this, args)
          Object.defineProperties(statement, {
            all: {
              configurable: true,
              value(...parameters) {
                allCalls += 1
                return Reflect.apply(
                  Object.getPrototypeOf(statement).all,
                  statement,
                  parameters,
                )
              },
            },
            columns: {
              configurable: true,
              value() {
                return columnsResult()
              },
            },
            run: {
              configurable: true,
              value(...parameters) {
                runCalls += 1
                return Reflect.apply(
                  Object.getPrototypeOf(statement).run,
                  statement,
                  parameters,
                )
              },
            },
          })
          return statement
        }
      },
    })
    const driver = createServerDbSqlNodeSqliteDriver({
      databases: new Map([['main', database]]),
    })
    return {
      allCalls: () => allCalls,
      driver,
      runCalls: () => runCalls,
      transaction: driver.begin({ database: 'main' }),
    }
  }

  const duplicate = instrumentDatabase(() => {
    const columns = [{ name: 'value' }, { name: 'value' }]
    columns.map = () => [{ name: 'left' }, { name: 'right' }]
    return columns
  })
  assert.deepEqual(duplicate.driver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select value, value from values_table',
    transaction: duplicate.transaction,
  }), { error: 'invalid_statement' })
  assert.equal(duplicate.allCalls(), 0)

  const shadowedLength = instrumentDatabase(() => new Proxy(
    [{ name: 'spoofed-result-column' }],
    {
      get(target, name, receiver) {
        if (name === 'length') return 0
        return Reflect.get(target, name, receiver)
      },
    },
  ))
  assert.deepEqual(shadowedLength.driver.execute({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'update values_table set value = value + 1',
    transaction: shadowedLength.transaction,
  }), { error: 'invalid_statement' })
  assert.equal(shadowedLength.runCalls(), 0)

  const nonArray = instrumentDatabase(() => ({
    length: 1,
    map() {
      return [{ name: 'value' }]
    },
  }))
  assert.deepEqual(nonArray.driver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select value from values_table',
    transaction: nonArray.transaction,
  }), { error: 'invalid_statement' })
  assert.equal(nonArray.allCalls(), 0)

  let nameReads = 0
  const dynamicName = instrumentDatabase(() => [{
    get name() {
      nameReads += 1
      return nameReads === 1 ? 'value' : 'spoofed-name'
    },
  }])
  assert.equal(dynamicName.driver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select value from values_table',
    transaction: dynamicName.transaction,
  }), '[{"value":1}]')
  assert.equal(nameReads, 1)

  const malformedName = instrumentDatabase(() => [{ name: 1 }])
  assert.deepEqual(malformedName.driver.query({
    bound_parameters: Uint8Array.from([91, 93]),
    database: 'main',
    statement: 'select value from values_table',
    transaction: malformedName.transaction,
  }), { error: 'invalid_statement' })
  assert.equal(malformedName.allCalls(), 0)
})

test('Node SQLite driver snapshots database and statement method authority', (t) => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec('create table values_table (value text not null)')

  let execReads = 0
  let prepareReads = 0
  let columnsReads = 0
  let runReads = 0
  let allReads = 0
  const originalExec = database.exec
  const originalPrepare = database.prepare
  Object.defineProperties(database, {
    exec: {
      configurable: true,
      get() {
        execReads += 1
        if (execReads > 1) throw new Error('database exec getter fault')
        const method = originalExec
        Object.defineProperty(method, 'bind', {
          configurable: true,
          get() {
            throw new Error('database exec bind fault')
          },
        })
        return method
      },
    },
    prepare: {
      configurable: true,
      get() {
        prepareReads += 1
        if (prepareReads > 1) throw new Error('database prepare getter fault')
        return function (...args) {
          const statement = originalPrepare.apply(this, args)
          for (const [member, counter] of [
            ['columns', () => { columnsReads += 1 }],
            ['run', () => { runReads += 1 }],
            ['all', () => { allReads += 1 }],
          ]) {
            const method = statement[member]
            Object.defineProperty(statement, member, {
              configurable: true,
              get() {
                counter()
                Object.defineProperty(method, 'bind', {
                  configurable: true,
                  get() {
                    throw new Error(`${member} bind fault`)
                  },
                })
                return method
              },
            })
          }
          return statement
        }
      },
    },
  })

  const adapter = sqliteAdapter(database)
  const transaction = invoke(adapter, 'begin', { database: 'main' }).value.value
  assert.deepEqual(invoke(
    adapter,
    'execute',
    sqlArguments(transaction, 'insert into values_table values (?)', ['stable']),
  ), ok(1))
  assert.deepEqual(invoke(
    adapter,
    'query',
    sqlArguments(transaction, 'select value from values_table', []),
  ), ok('[{"value":"stable"}]'))
  assert.deepEqual(invoke(adapter, 'commit', {
    database: 'main',
    transaction,
  }), ok(null))
  assert.equal(execReads, 1)
  assert.equal(prepareReads, 1)
  assert.equal(columnsReads, 2)
  assert.equal(runReads, 1)
  assert.equal(allReads, 1)
})

function sqliteAdapter(database) {
  return new ServerDbSqlDriverAdapter({
    driver: createServerDbSqlNodeSqliteDriver({
      databases: new Map([['main', database]]),
    }),
  })
}

function sqlArguments(
  transaction,
  statement,
  parameters,
  encodedParameters = JSON.stringify(parameters),
) {
  return {
    bound_parameters: new TextEncoder().encode(encodedParameters),
    database: 'main',
    statement,
    transaction,
  }
}

function invoke(adapter, member, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_DB_SQL_REFERENCE, member },
    typedArguments,
  )
}

function ok(value) {
  return {
    kind: 'value',
    value: { kind: 'ok', value },
  }
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
