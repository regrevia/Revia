import { isDeepStrictEqual } from 'node:util'

export function checkAdapterVector({
  adapter,
  expectedOutcome,
  expectedState,
  invocationId,
  observeState,
  operation,
  typedArguments,
}) {
  const diagnostics = []
  const outcome = adapter.invoke(operation, typedArguments, invocationId)
  if (!isDeepStrictEqual(outcome, expectedOutcome)) {
    diagnostics.push({ code: 'typed-outcome-mismatch' })
  }
  if (!isDeepStrictEqual(observeState(), expectedState)) {
    diagnostics.push({ code: 'observable-state-mismatch' })
  }
  return { diagnostics, ok: diagnostics.length === 0 }
}
