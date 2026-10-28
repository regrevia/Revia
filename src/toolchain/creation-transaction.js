import {
  assignMissingGraphUids,
  deterministicUidFactory,
  validateGraphIdentities,
} from './graph-identity.js'

const transactions = new WeakMap()

export function createGraph(
  input,
  { check, occupiedUids = [], uidFactory = deterministicUidFactory() } = {},
) {
  if (typeof check !== 'function') {
    throw new TypeError('createGraph requires a check function')
  }
  const graph = structuredClone(input)
  const diagnostics = []
  lowerLiterals(graph)
  assignMissingGraphUids(graph, uidFactory)
  resolveLiteralEndpoints(graph, diagnostics)
  diagnostics.push(...validateGraphIdentities(graph, { occupiedUids }))
  lowerValueEdges(graph, diagnostics)

  const transaction = Object.freeze({ kind: 'creation-transaction' })
  transactions.set(transaction, {
    check,
    diagnostics,
    graph,
    state: 'pending',
  })
  return transaction
}

// Inline compact literals (parser payload `{ literal }`) are materialized into
// real literal graph nodes here, before UID assignment. The parser only
// recognizes the literal and its type/value; the creator owns identity,
// endpoint and persistence. Structured re-entry keeps existing literal nodes
// and their value-edge arguments untouched.
function lowerLiterals(graph) {
  for (const function_ of graph.functions ?? []) {
    function_.literals ??= []
    for (const call of callsOf(function_)) {
      for (const argument of call.arguments ?? []) {
        if (argument.literal === undefined) continue
        const literal = {
          kind: 'literal',
          location: argument.literal.location ?? argument.location,
          type: argument.literal.type,
          uid: argument.literal.uid,
          value: argument.literal.value,
        }
        delete argument.literal
        argument.sourceRef = literal
        function_.literals.push(literal)
      }
    }
  }
}

// Once literal nodes carry UIDs (assigned centrally, not here), connect each
// compact argument to its literal producer through a value edge and drop the
// temporary reference. Arguments that already carry a value edge (structured
// re-entry) are left alone; the checker re-anchors them.
function resolveLiteralEndpoints(graph, diagnostics) {
  for (const function_ of graph.functions ?? []) {
    const literalUids = new Set(
      (function_.literals ?? []).map((literal) => literal.uid),
    )
    for (const call of callsOf(function_)) {
      for (const argument of call.arguments ?? []) {
        const reference = argument.sourceRef
        if (reference !== undefined) {
          argument.source = {
            kind: 'value-edge',
            endpoint: reference.uid,
          }
          delete argument.sourceRef
        }
        const endpoint = argument.source?.endpoint
        if (
          argument.source?.kind === 'value-edge' &&
          endpoint !== undefined &&
          !literalUids.has(endpoint)
        ) {
          diagnostics.push({
            ...argument.location,
            code: 'unknown-edge-endpoint',
            endpoint,
          })
        }
      }
    }
  }
}

function callsOf(function_) {
  const calls = []
  for (const statement of function_.statements ?? []) {
    if (statement.value !== undefined) calls.push(statement.value)
    for (const branch of statement.value?.branches ?? []) {
      if (branch.value !== undefined) calls.push(branch.value)
    }
  }
  return calls
}

function lowerValueEdges(graph, diagnostics) {
  for (const function_ of graph.functions ?? []) {
    const producers = new Map()
    for (const statement of function_.statements) {
      if (statement.kind === 'let' && !producers.has(statement.binding)) {
        producers.set(statement.binding, statement.uid)
      }
    }
    const statementUids = new Set(
      function_.statements.map((statement) => statement.uid),
    )
    for (const statement of function_.statements) {
      delete statement.id
      if (statement.kind !== 'return') continue
      const input = statement.value.input
      if (input.kind === 'value-reference') {
        const producer = producers.get(input.name)
        if (producer === undefined) {
          diagnostics.push({
            ...input.location,
            code: 'unknown-value-reference',
            reference: input.name,
          })
          continue
        }
        statement.value.input = {
          kind: 'value-edge',
          location: input.location,
          producer,
        }
      } else if (
        input.kind === 'value-edge' &&
        !statementUids.has(input.producer)
      ) {
        diagnostics.push({
          ...input.location,
          code: 'unknown-edge-endpoint',
          endpoint: input.producer,
        })
      }
    }
  }
}

export function commit(transaction) {
  const entry = transactions.get(transaction)
  if (entry?.state !== 'pending') return transactionNotPending()
  if (entry.diagnostics.length > 0) {
    return fail(entry, entry.diagnostics)
  }

  const checked = entry.check(entry.graph)
  if (!checked.ok) return fail(entry, checked.diagnostics)
  deepFreeze(checked.program)
  entry.graph = undefined
  entry.state = 'committed'
  return checked
}

export function rollback(transaction) {
  const entry = transactions.get(transaction)
  if (entry?.state !== 'pending') return
  entry.graph = undefined
  entry.state = 'rolled-back'
}

function fail(entry, diagnostics) {
  entry.graph = undefined
  entry.state = 'failed'
  return { diagnostics: structuredClone(diagnostics), ok: false }
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value
  }
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function transactionNotPending() {
  return {
    diagnostics: [{ code: 'creation-transaction-not-pending' }],
    ok: false,
  }
}
