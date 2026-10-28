import { createHash } from 'node:crypto'

import { serializeCanonicalGraph } from './canonical.js'

const PATCH_SCHEMA = 're.structured-patch@0.1.0'
const RECEIPT_SCHEMA = 're.patch-receipt@0.1.0'
const transactions = new WeakMap()

export function graphRevision(graph) {
  const digest = createHash('sha256')
    .update(serializeCanonicalGraph(graph), 'utf8')
    .digest('hex')
  return `sha256:${digest}`
}

export function applyStructuredPatch(graph, patch, { check } = {}) {
  if (typeof check !== 'function') {
    throw new TypeError('applyStructuredPatch requires a check function')
  }
  const documentDiagnostic = validatePatchDocument(patch)
  if (documentDiagnostic !== undefined) return rejected(documentDiagnostic)

  const actualRevision = graphRevision(graph)
  if (patch.baseRevision !== actualRevision) {
    return rejected({
      actual: actualRevision,
      code: 'patch-base-revision-mismatch',
      expected: patch.baseRevision,
    })
  }

  const draft = structuredClone(graph)
  for (const [index, operation] of patch.operations.entries()) {
    const applied = applyOperation(draft, operation)
    if (!applied.ok) {
      return rejected({ ...applied.diagnostic, operation: index })
    }
  }

  const checked = check(draft)
  if (!checked.ok) {
    return { diagnostics: structuredClone(checked.diagnostics), ok: false }
  }
  deepFreeze(checked.program)
  return {
    ok: true,
    program: checked.program,
    receipt: Object.freeze({
      base_revision: actualRevision,
      operations: deepFreeze(structuredClone(patch.operations)),
      result_revision: graphRevision(checked.program),
      schema: RECEIPT_SCHEMA,
    }),
  }
}

export function createReplaceInputTransaction(
  graph,
  { callUid, parameterName, expectedOldEndpoint, newEndpoint, check } = {},
) {
  if (typeof check !== 'function') {
    throw new TypeError('createReplaceInputTransaction requires a check function')
  }
  if (!callUid || !parameterName || !expectedOldEndpoint || !newEndpoint) {
    throw new TypeError('createReplaceInputTransaction requires patch coordinates')
  }

  const draft = structuredClone(graph)
  const diagnostics = []
  const applied = applyOperation(draft, {
    callUid,
    expectedOldEndpoint,
    kind: 'replace-input',
    newEndpoint,
    parameterName,
  })
  if (!applied.ok) diagnostics.push(applied.diagnostic)

  const transaction = Object.freeze({ kind: 'replace-input-transaction' })
  transactions.set(transaction, {
    check,
    diagnostics,
    draft,
    state: 'pending',
  })
  return transaction
}

export function commitReplaceInput(transaction) {
  const entry = transactions.get(transaction)
  if (entry?.state !== 'pending') return transactionNotPending()
  if (entry.diagnostics.length > 0) {
    return fail(entry, entry.diagnostics)
  }

  const checked = entry.check(entry.draft)
  if (!checked.ok) return fail(entry, checked.diagnostics)
  deepFreeze(checked.program)
  entry.draft = undefined
  entry.state = 'committed'
  return checked
}

export function rollbackReplaceInput(transaction) {
  const entry = transactions.get(transaction)
  if (entry?.state !== 'pending') return
  entry.draft = undefined
  entry.state = 'rolled-back'
}

function locateCallArgument(graph, callUid, parameterName) {
  for (const function_ of graph.functions ?? []) {
    for (const call of callsOf(function_)) {
      if (call.uid !== callUid) continue
      const argument = call.arguments?.find(
        (candidate) => argumentParameterName(call, candidate) === parameterName,
      )
      if (argument === undefined) {
        return {
          diagnostic: {
            code: 'replace-input-parameter-not-found',
            parameter: parameterName,
            uid: callUid,
          },
          ok: false,
        }
      }
      return { argument, ok: true }
    }
  }
  return {
    diagnostic: { code: 'replace-input-call-not-found', uid: callUid },
    ok: false,
  }
}

function argumentParameterName(call, argument) {
  if (argument.name !== null && argument.name !== undefined) {
    return argument.name
  }
  const matches = Object.entries(call.typedArguments ?? {})
    .filter(([, binding]) => binding.endpoint === argument.source?.endpoint)
    .map(([name]) => name)
  return matches.length === 1 ? matches[0] : undefined
}

function applyOperation(graph, operation) {
  if (operation.kind !== 'replace-input') {
    return {
      diagnostic: {
        code: 'unsupported-patch-operation',
        kind: operation.kind,
      },
      ok: false,
    }
  }
  const located = locateCallArgument(
    graph,
    operation.callUid,
    operation.parameterName,
  )
  if (!located.ok) return located
  if (located.argument.source?.endpoint !== operation.expectedOldEndpoint) {
    return {
      diagnostic: {
        actual: located.argument.source?.endpoint,
        code: 'replace-input-old-endpoint-mismatch',
        expected: operation.expectedOldEndpoint,
        parameter: operation.parameterName,
        uid: operation.callUid,
      },
      ok: false,
    }
  }
  located.argument.source = {
    kind: 'value-edge',
    endpoint: operation.newEndpoint,
  }
  return { ok: true }
}

function callsOf(function_) {
  const calls = []
  for (const statement of function_.statements ?? []) {
    if (statement.kind === 'let' && statement.value !== undefined) {
      calls.push(statement.value)
    }
    if (statement.kind === 'return') {
      for (const branch of statement.value?.branches ?? []) {
        if (branch.value !== undefined) calls.push(branch.value)
      }
    }
  }
  return calls
}

function validatePatchDocument(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { code: 'invalid-patch-document' }
  }
  if (patch.schema !== PATCH_SCHEMA) {
    return {
      actual: patch.schema,
      code: 'unsupported-patch-schema',
      expected: PATCH_SCHEMA,
    }
  }
  if (typeof patch.baseRevision !== 'string') {
    return { code: 'missing-patch-base-revision' }
  }
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    return { code: 'patch-operations-required' }
  }
  for (const [index, operation] of patch.operations.entries()) {
    if (operation === null || typeof operation !== 'object') {
      return { code: 'invalid-patch-operation', operation: index }
    }
    if (operation.kind !== 'replace-input') {
      return {
        code: 'unsupported-patch-operation',
        kind: operation.kind,
        operation: index,
      }
    }
    for (const field of [
      'callUid',
      'parameterName',
      'expectedOldEndpoint',
      'newEndpoint',
    ]) {
      if (typeof operation[field] !== 'string' || operation[field].length === 0) {
        return {
          code: 'invalid-patch-coordinate',
          field,
          operation: index,
        }
      }
    }
  }
}

function rejected(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
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

function fail(entry, diagnostics) {
  entry.draft = undefined
  entry.state = 'failed'
  return { diagnostics: structuredClone(diagnostics), ok: false }
}

function transactionNotPending() {
  return { diagnostics: [{ code: 'replace-input-transaction-not-pending' }], ok: false }
}
