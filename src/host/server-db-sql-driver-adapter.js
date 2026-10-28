import {
  SERVER_DB_SQL_ADAPTER_CONTRACT,
  SERVER_DB_SQL_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { sqlOperationKey } from './server-db-sql-memory-adapter.js'
import { snapshotUint8Array } from './uint8-array.js'

const DB_SQL_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'db.sql')
const CLOSED_ERRORS = new Set(
  DB_SQL_SCHEMA.types['db.sql_error'].variants,
)
const MEMBERS = new Set(['begin', 'commit', 'execute', 'query', 'rollback'])

export class ServerDbSqlDriverAdapter {
  #driver
  #unavailable

  constructor({ driver = null, unavailable = false } = {}) {
    if (
      driver !== null
      && (typeof driver !== 'object' || Array.isArray(driver))
    ) {
      throw new TypeError('db.sql driver must be an object')
    }
    this.#driver = driver === null ? null : snapshotDriver(driver)
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_DB_SQL_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_DB_SQL_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(DB_SQL_SCHEMA.resource_catalog)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_DB_SQL_REFERENCE
      || !MEMBERS.has(operation.member)
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable || this.#driver === null) {
      return declaredError('unavailable')
    }
    const driverMethod = this.#driver[operation.member]
    if (typeof driverMethod !== 'function') return declaredError('unavailable')

    let request
    try {
      request = copyRequest(operation.member, typedArguments)
    } catch {
      return declaredError('invalid_statement')
    }

    let outcome
    try {
      outcome = driverMethod(request)
    } catch {
      return declaredError('unavailable')
    }
    if (
      outcome !== null
      && typeof outcome === 'object'
      && CLOSED_ERRORS.has(outcome.error)
    ) {
      return declaredError(outcome.error)
    }
    if (!validSuccess(operation.member, outcome)) {
      return declaredError('unavailable')
    }
    return {
      kind: 'value',
      value: { kind: 'ok', value: outcome },
    }
  }
}

function snapshotDriver(driver) {
  const methods = []
  for (const member of MEMBERS) {
    const method = driver[member]
    if (typeof method !== 'function') continue
    methods.push([
      member,
      Function.prototype.bind.call(method, driver),
    ])
  }
  return Object.fromEntries(methods)
}

function copyRequest(member, typedArguments) {
  if (typeof typedArguments.database !== 'string') {
    throw new TypeError('invalid database')
  }
  if (member === 'begin') {
    return { database: typedArguments.database }
  }
  if (['commit', 'rollback'].includes(member)) {
    if (typeof typedArguments.transaction !== 'string') {
      throw new TypeError('invalid transaction')
    }
    return {
      database: typedArguments.database,
      transaction: typedArguments.transaction,
    }
  }
  const request = {
    bound_parameters: snapshotUint8Array(typedArguments.bound_parameters),
    database: typedArguments.database,
    statement: typedArguments.statement,
    transaction: typedArguments.transaction,
  }
  if (request.bound_parameters === null) throw new TypeError()
  sqlOperationKey({ ...request, member })
  return request
}

function validSuccess(member, outcome) {
  if (member === 'begin') return typeof outcome === 'string' && outcome.length > 0
  if (member === 'query') return typeof outcome === 'string'
  if (member === 'execute') return Number.isSafeInteger(outcome)
  return outcome === null
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
