import { DatabaseSync } from 'node:sqlite'

import { snapshotUint8Array } from './uint8-array.js'

const SQLITE_BUSY = new Set([5, 6])

export function createServerDbSqlNodeSqliteDriver({
  databases = new Map(),
} = {}) {
  if (!(databases instanceof Map)) {
    throw new TypeError('db.sql SQLite databases must be a Map')
  }
  const handles = new Map()
  const uniqueHandles = new Set()
  for (const [name, database] of databases) {
    if (
      typeof name !== 'string'
      || name.length === 0
      || !(database instanceof DatabaseSync)
    ) {
      throw new TypeError(
        'db.sql SQLite databases must map text names to DatabaseSync handles',
      )
    }
    if (uniqueHandles.has(database)) {
      throw new TypeError(
        'db.sql SQLite databases must use unique DatabaseSync handles',
      )
    }
    uniqueHandles.add(database)
    handles.set(name, snapshotDatabase(database))
  }

  const activeByDatabase = new Map()
  const transactions = new Map()
  let transactionSequence = 0

  return {
    begin({ database: databaseName }) {
      const database = handles.get(databaseName)
      if (database === undefined) return { error: 'unavailable' }
      if (activeByDatabase.has(databaseName)) return { error: 'conflict' }
      try {
        database.exec('BEGIN IMMEDIATE')
      } catch (error) {
        return { error: isSqliteBusy(error) ? 'conflict' : 'unavailable' }
      }
      transactionSequence += 1
      const transaction = `sqlite-tx-${transactionSequence}`
      activeByDatabase.set(databaseName, transaction)
      transactions.set(transaction, databaseName)
      return transaction
    },

    commit(request) {
      return finishTransaction({
        activeByDatabase,
        handles,
        request,
        statement: 'COMMIT',
        transactions,
      })
    },

    execute(request) {
      const prepared = prepareStatementRequest({
        handles,
        request,
        transactions,
      })
      if (!prepared.ok) return { error: prepared.error }
      if (!['DELETE', 'INSERT', 'REPLACE', 'UPDATE'].includes(
        firstStatementKeyword(prepared.statement),
      )) {
        return { error: 'invalid_statement' }
      }
      try {
        const statement = prepared.database.prepare(prepared.statement)
        const columns = snapshotStatementColumns(statement)()
        const names = snapshotColumnNames(columns)
        if (names === null || names.length !== 0) {
          return { error: 'invalid_statement' }
        }
        const run = snapshotStatementMethod(statement, 'run')
        const result = run(...prepared.parameters)
        const changes = safeInteger(result.changes)
        return changes === null ? { error: 'unavailable' } : changes
      } catch (error) {
        return {
          error: isSqliteBusy(error) ? 'conflict' : 'invalid_statement',
        }
      }
    },

    query(request) {
      const prepared = prepareStatementRequest({
        handles,
        request,
        transactions,
      })
      if (!prepared.ok) return { error: prepared.error }
      if (firstStatementKeyword(prepared.statement) !== 'SELECT') {
        return { error: 'invalid_statement' }
      }
      try {
        const statement = prepared.database.prepare(prepared.statement)
        const names = snapshotColumnNames(snapshotStatementColumns(statement)())
        if (names === null || names.length === 0 || new Set(names).size !== names.length) {
          return { error: 'invalid_statement' }
        }
        const all = snapshotStatementMethod(statement, 'all')
        const rows = all(...prepared.parameters)
        return stableRowsText(rows)
      } catch (error) {
        return {
          error: isSqliteBusy(error) ? 'conflict' : 'invalid_statement',
        }
      }
    },

    rollback(request) {
      return finishTransaction({
        activeByDatabase,
        handles,
        request,
        statement: 'ROLLBACK',
        transactions,
      })
    },
  }
}

function firstStatementKeyword(statement) {
  return /^\s*([A-Za-z]+)\b/.exec(statement)?.[1].toUpperCase() ?? ''
}

function prepareStatementRequest({ handles, request, transactions }) {
  if (
    request === null
    || typeof request !== 'object'
    || typeof request.database !== 'string'
    || typeof request.statement !== 'string'
    || typeof request.transaction !== 'string'
    || !(request.bound_parameters instanceof Uint8Array)
  ) {
    return { error: 'invalid_statement', ok: false }
  }
  if (transactions.get(request.transaction) !== request.database) {
    return { error: 'invalid_transaction', ok: false }
  }
  const database = handles.get(request.database)
  if (database === undefined) return { error: 'unavailable', ok: false }
  let parameters
  try {
    parameters = decodeBoundParameters(request.bound_parameters)
  } catch {
    return { error: 'invalid_statement', ok: false }
  }
  return {
    database,
    ok: true,
    parameters,
    statement: request.statement,
  }
}

function decodeBoundParameters(bytes) {
  const snapshot = snapshotUint8Array(bytes)
  if (snapshot === null) {
    throw new TypeError('invalid SQLite bound parameters')
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(snapshot)
  const parameters = JSON.parse(text)
  if (
    !Array.isArray(parameters)
    || parameters.some((value) => !validParameter(value))
    || Buffer.compare(
      Buffer.from(text, 'utf8'),
      Buffer.from(JSON.stringify(parameters), 'utf8'),
    ) !== 0
  ) {
    throw new TypeError('invalid SQLite bound parameters')
  }
  return parameters
}

function validParameter(value) {
  return (
    value === null
    || typeof value === 'string'
    || (
      typeof value === 'number'
      && Number.isFinite(value)
      && (Number.isInteger(value) ? Number.isSafeInteger(value) : true)
    )
  )
}

function finishTransaction({
  activeByDatabase,
  handles,
  request,
  statement,
  transactions,
}) {
  if (
    request === null
    || typeof request !== 'object'
    || typeof request.database !== 'string'
    || typeof request.transaction !== 'string'
    || transactions.get(request.transaction) !== request.database
  ) {
    return { error: 'invalid_transaction' }
  }
  const database = handles.get(request.database)
  if (database === undefined) return { error: 'unavailable' }
  try {
    database.exec(statement)
  } catch (error) {
    if (statement === 'COMMIT' && isSqliteBusy(error)) {
      return { error: 'conflict' }
    }
    return { error: 'unavailable' }
  }
  transactions.delete(request.transaction)
  activeByDatabase.delete(request.database)
  return null
}

function snapshotDatabase(database) {
  return {
    exec: snapshotMethod(database, 'exec'),
    prepare: snapshotMethod(database, 'prepare'),
  }
}

function snapshotMethod(receiver, member) {
  const method = receiver[member]
  if (typeof method !== 'function') {
    throw new TypeError(`db.sql SQLite database requires ${member}`)
  }
  return Function.prototype.bind.call(method, receiver)
}

function snapshotStatementColumns(statement) {
  return snapshotStatementMethod(statement, 'columns')
}

function snapshotColumnNames(columns) {
  try {
    if (!Array.isArray(columns)) return null
    const lengthDescriptor = Object.getOwnPropertyDescriptor(columns, 'length')
    if (
      lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      return null
    }
    const names = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const columnDescriptor = Object.getOwnPropertyDescriptor(
        columns,
        String(index),
      )
      if (
        columnDescriptor === undefined
        || !('value' in columnDescriptor)
      ) {
        return null
      }
      const nameDescriptor = Object.getOwnPropertyDescriptor(
        columnDescriptor.value,
        'name',
      )
      if (nameDescriptor === undefined) return null
      let name
      if ('value' in nameDescriptor) {
        name = nameDescriptor.value
      } else if (typeof nameDescriptor.get === 'function') {
        name = Reflect.apply(nameDescriptor.get, columnDescriptor.value, [])
      } else {
        return null
      }
      if (typeof name !== 'string') return null
      names.push(name)
    }
    return names
  } catch {
    return null
  }
}

function snapshotStatementMethod(statement, member) {
  const method = statement[member]
  if (typeof method !== 'function') {
    throw new TypeError(`db.sql SQLite statement requires ${member}`)
  }
  return Function.prototype.bind.call(method, statement)
}

function stableRowsText(rows) {
  const snapshot = snapshotRows(rows)
  if (snapshot === null) {
    throw new TypeError('unsupported SQLite row collection')
  }
  const normalized = snapshot.map((row) => Object.fromEntries(
    Object.keys(row).sort(compareText).map((key) => {
      const value = row[key]
      if (
        value !== null
        && typeof value !== 'string'
        && !(
          typeof value === 'number'
          && Number.isFinite(value)
          && (Number.isInteger(value) ? Number.isSafeInteger(value) : true)
        )
      ) {
        throw new TypeError('unsupported SQLite row value')
      }
      return [key, value]
    }),
  ))
  return JSON.stringify(normalized)
}

function snapshotRows(rows) {
  if (!Array.isArray(rows)) return null
  const lengthDescriptor = Object.getOwnPropertyDescriptor(rows, 'length')
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return null
  }
  const snapshot = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index))
    if (descriptor === undefined || !('value' in descriptor)) return null
    const row = snapshotRow(descriptor.value)
    if (row === null) return null
    snapshot.push(row)
  }
  return snapshot
}

function snapshotRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return null
  }
  let keys
  try {
    keys = Object.keys(row)
  } catch {
    return null
  }
  const snapshot = Object.create(null)
  for (const key of keys) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(row, key)
    } catch {
      return null
    }
    if (descriptor === undefined || descriptor.enumerable !== true) return null
    if ('value' in descriptor) {
      snapshot[key] = descriptor.value
      continue
    }
    if (typeof descriptor.get !== 'function') return null
    try {
      snapshot[key] = Reflect.apply(descriptor.get, row, [])
    } catch {
      return null
    }
  }
  return snapshot
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function safeInteger(value) {
  if (Number.isSafeInteger(value)) return value
  if (
    typeof value === 'bigint'
    && value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value)
  }
  return null
}

function isSqliteBusy(error) {
  return (
    SQLITE_BUSY.has(error?.errcode)
    || error?.code === 'SQLITE_BUSY'
    || error?.code === 'SQLITE_LOCKED'
  )
}
