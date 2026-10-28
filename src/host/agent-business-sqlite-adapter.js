import {
  agentAdapterContractDigest,
  validateAgentAdapterContract,
} from './agent-adapter-contract.js'
import {
  ServerDbSqlDriverAdapter,
} from './server-db-sql-driver-adapter.js'
import {
  createServerDbSqlNodeSqliteDriver,
} from './server-db-sql-node-sqlite-driver.js'

const QUERY = [
  'select approved, error_variant, outcome, result_currency as currency',
  'from expense_review_decisions',
  'where request_id = ? and amount = ? and request_currency = ?',
].join(' ')
const ROW_FIELDS = 'approved,currency,error_variant,outcome'

export class AgentBusinessSqliteAdapter {
  #contract
  #databaseName
  #profile
  #sql

  constructor({
    contract,
    database,
    database_name = 'expense',
    profile,
  } = {}) {
    const validation = validateAgentAdapterContract(contract)
    if (!validation.ok) throw new TypeError(validation.diagnostics[0].code)
    this.#contract = validation.value
    this.#profile = snapshotProfile(profile)
    if (!same(this.#profile, this.#contract.profile)) {
      throw new TypeError('agent adapter profile mismatch')
    }
    if (
      typeof database_name !== 'string'
      || database_name.length === 0
      || /[\u0000-\u001f\u007f]/u.test(database_name)
    ) {
      throw new TypeError('invalid agent SQLite database name')
    }
    this.#databaseName = database_name
    this.#sql = new ServerDbSqlDriverAdapter({
      driver: createServerDbSqlNodeSqliteDriver({
        databases: new Map([[database_name, database]]),
      }),
    })
  }

  adapterContract() {
    return agentAdapterContractDigest(this.#contract)
  }

  profileIdentity() {
    return structuredClone(this.#profile)
  }

  invoke(operation, typedArguments, context = {}) {
    if (
      operation?.interface !== this.#contract.capability.reference
      || operation.member !== this.#contract.capability.member
    ) {
      return { kind: 'host-fault' }
    }
    if (context.cancellation === 'requested') return { kind: 'cancelled' }

    let boundary
    try {
      boundary = projectBoundaryInput(typedArguments, context.request_id)
    } catch {
      return { kind: 'host-fault' }
    }

    const begin = this.#invokeSql('begin', {
      database: this.#databaseName,
    })
    if (begin.kind !== 'ok') return this.#databaseFailure(begin.error)
    const transaction = begin.value

    const query = this.#invokeSql('query', {
      bound_parameters: new TextEncoder().encode(JSON.stringify([
        boundary.request_id,
        boundary.amount,
        boundary.currency,
      ])),
      database: this.#databaseName,
      statement: QUERY,
      transaction,
    })
    if (query.kind !== 'ok') {
      this.#rollback(transaction)
      return this.#databaseFailure(query.error)
    }

    let outcome
    try {
      outcome = decodeRows(this.#contract, query.value)
    } catch {
      this.#rollback(transaction)
      return { kind: 'host-fault' }
    }

    const commit = this.#invokeSql('commit', {
      database: this.#databaseName,
      transaction,
    })
    if (commit.kind !== 'ok') {
      this.#rollback(transaction)
      return this.#databaseFailure(commit.error)
    }
    return outcome
  }

  #databaseFailure(error) {
    if (error === 'conflict') {
      return declaredError(this.#contract, 'transient')
    }
    if (error === 'unavailable') {
      return declaredError(this.#contract, 'unavailable')
    }
    return { kind: 'host-fault' }
  }

  #invokeSql(member, input) {
    const outcome = this.#sql.invoke(
      { interface: 'db.sql@0.1.0', member },
      input,
    )
    if (
      outcome?.kind !== 'value'
      || outcome.value === null
      || typeof outcome.value !== 'object'
      || Array.isArray(outcome.value)
    ) {
      return { error: 'unavailable', kind: 'err' }
    }
    if (outcome.value.kind === 'ok') {
      return { kind: 'ok', value: outcome.value.value }
    }
    if (
      outcome.value.kind === 'err'
      && typeof outcome.value.error?.variant === 'string'
    ) {
      return { error: outcome.value.error.variant, kind: 'err' }
    }
    return { error: 'unavailable', kind: 'err' }
  }

  #rollback(transaction) {
    try {
      this.#invokeSql('rollback', {
        database: this.#databaseName,
        transaction,
      })
    } catch {
      // The primary failure remains authoritative.
    }
  }
}

function projectBoundaryInput(value, requestId) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'amount,currency'
    || typeof value.amount !== 'string'
    || typeof requestId !== 'string'
    || requestId.length === 0
  ) {
    throw new TypeError('invalid project SQLite input')
  }
  const currency = value.currency
  if (
    currency === null
    || typeof currency !== 'object'
    || Array.isArray(currency)
    || Object.keys(currency).join(',') !== 'variant'
    || typeof currency.variant !== 'string'
  ) {
    throw new TypeError('invalid project currency value')
  }
  return {
    amount: value.amount,
    currency: currency.variant,
    request_id: requestId,
  }
}

function decodeRows(contract, text) {
  if (typeof text !== 'string') throw new TypeError('invalid SQLite rows')
  const rows = JSON.parse(text)
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new TypeError('invalid SQLite row count')
  }
  const row = rows[0]
  if (
    row === null
    || typeof row !== 'object'
    || Array.isArray(row)
    || Object.keys(row).sort().join(',') !== ROW_FIELDS
    || !['err', 'ok'].includes(row.outcome)
  ) {
    throw new TypeError('invalid SQLite business row')
  }
  if (row.outcome === 'ok') {
    if (
      ![0, 1].includes(row.approved)
      || typeof row.currency !== 'string'
      || row.error_variant !== null
    ) {
      throw new TypeError('invalid SQLite success row')
    }
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value: {
          approved: row.approved === 1,
          currency: { variant: row.currency },
        },
      },
    }
  }
  if (
    row.approved !== null
    || row.currency !== null
    || typeof row.error_variant !== 'string'
    || !contract.error_variants.includes(row.error_variant)
  ) {
    throw new TypeError('invalid SQLite error row')
  }
  return declaredError(contract, row.error_variant)
}

function declaredError(contract, variant) {
  if (!contract.error_variants.includes(variant)) return { kind: 'host-fault' }
  return {
    kind: 'value',
    value: {
      error: {
        type: contract.error_type.name,
        variant,
      },
      kind: 'err',
    },
  }
}

function snapshotProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('invalid agent profile')
  }
  return structuredClone(profile)
}

function same(left, right) {
  return stableJson(left) === stableJson(right)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
