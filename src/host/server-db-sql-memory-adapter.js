import {
  SERVER_DB_SQL_ADAPTER_CONTRACT,
  SERVER_DB_SQL_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const DB_SQL_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'db.sql')
const CLOSED_ERRORS = new Set(
  DB_SQL_SCHEMA.types['db.sql_error'].variants,
)

export class ServerDbSqlMemoryAdapter {
  #activeTransactions = new Map()
  #commitConflicts
  #outcomes
  #transactions
  #unavailable

  constructor({
    commitConflicts = new Set(),
    outcomes = new Map(),
    transactions = [],
    unavailable = false,
  } = {}) {
    const fixtureSnapshot = validateFixtures({
      commitConflicts,
      outcomes,
      transactions,
    })
    this.#commitConflicts = fixtureSnapshot.commitConflicts
    this.#outcomes = fixtureSnapshot.outcomes
    this.#transactions = fixtureSnapshot.transactions
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
      || !['begin', 'commit', 'execute', 'query', 'rollback']
        .includes(operation.member)
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    if (operation.member === 'begin') return this.#begin(typedArguments.database)
    if (operation.member === 'commit') {
      return this.#finish(typedArguments, true)
    }
    if (operation.member === 'rollback') {
      return this.#finish(typedArguments, false)
    }
    if (
      this.#activeTransactions.get(typedArguments.transaction)
      !== typedArguments.database
    ) {
      return declaredError('invalid_transaction')
    }
    let key
    try {
      key = sqlOperationKey({
        ...typedArguments,
        member: operation.member,
      })
    } catch {
      return declaredError('invalid_statement')
    }
    const outcome = this.#outcomes.get(key)
    if (outcome === undefined) return declaredError('invalid_statement')
    if (typeof outcome === 'object') return declaredError(outcome.error)
    return { kind: 'value', value: { kind: 'ok', value: outcome } }
  }

  #begin(database) {
    const transaction = this.#transactions.shift()
    if (transaction === undefined) return declaredError('conflict')
    this.#activeTransactions.set(transaction, database)
    return { kind: 'value', value: { kind: 'ok', value: transaction } }
  }

  #finish({ database, transaction }, commit) {
    if (this.#activeTransactions.get(transaction) !== database) {
      return declaredError('invalid_transaction')
    }
    if (commit && this.#commitConflicts.has(transaction)) {
      return declaredError('conflict')
    }
    this.#activeTransactions.delete(transaction)
    return { kind: 'value', value: { kind: 'ok', value: null } }
  }
}

export function sqlOperationKey({
  bound_parameters: boundParameters,
  database,
  member,
  statement,
  transaction,
}) {
  const parameters = snapshotUint8Array(boundParameters)
  if (
    !['execute', 'query'].includes(member)
    || parameters === null
    || typeof database !== 'string'
    || typeof statement !== 'string'
    || typeof transaction !== 'string'
  ) {
    throw new TypeError('invalid db.sql operation')
  }
  return JSON.stringify([
    member,
    database,
    transaction,
    statement,
    Buffer.from(parameters).toString('hex'),
  ])
}

function validateFixtures({ commitConflicts, outcomes, transactions }) {
  if (
    !(commitConflicts instanceof Set)
    || !(outcomes instanceof Map)
    || !Array.isArray(transactions)
  ) {
    throw new TypeError('invalid db.sql memory fixtures')
  }
  const transactionSnapshot = []
  const transactionSet = new Set()
  const transactionLength = transactions.length
  for (let index = 0; index < transactionLength; index += 1) {
    const transaction = transactions[index]
    if (
      typeof transaction !== 'string'
      || transaction.length === 0
      || transactionSet.has(transaction)
    ) {
      throw new TypeError('invalid db.sql memory fixtures')
    }
    transactionSet.add(transaction)
    transactionSnapshot.push(transaction)
  }
  const conflictSnapshot = []
  const conflictIterator = Set.prototype.values.call(commitConflicts)
  for (
    let step = conflictIterator.next();
    !step.done;
    step = conflictIterator.next()
  ) {
    const transaction = step.value
    if (typeof transaction !== 'string') {
      throw new TypeError('invalid db.sql memory fixtures')
    }
    conflictSnapshot.push(transaction)
  }
  const snapshot = []
  const iterator = Map.prototype.entries.call(outcomes)
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const [key, outcome] = step.value
    let member
    try {
      [member] = JSON.parse(key)
    } catch {
      throw new TypeError('db.sql outcomes must use operation keys')
    }
    const validValue = member === 'query'
      ? typeof outcome === 'string'
      : member === 'execute' && Number.isSafeInteger(outcome)
    const validError = (
      outcome !== null
      && typeof outcome === 'object'
      && CLOSED_ERRORS.has(outcome.error)
    )
    if (typeof key !== 'string' || (!validValue && !validError)) {
      throw new TypeError('db.sql outcomes must use typed values or closed errors')
    }
    snapshot.push([
      key,
      typeof outcome === 'object' ? { error: outcome.error } : outcome,
    ])
  }
  return {
    commitConflicts: new Set(conflictSnapshot),
    outcomes: new Map(snapshot),
    transactions: transactionSnapshot,
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
