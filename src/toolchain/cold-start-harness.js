import { createHash } from 'node:crypto'

import { moduleInterfaceDigest } from './module-contract.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const TRACE_FIELDS = Object.freeze([
  'input_digest',
  'output_digest',
  'sequence',
  'status',
  'tool',
])

export function evaluateColdStartAttempt({
  model,
  oraclePassed,
  output,
  pack,
  releaseLockDigest,
  runnerError,
  taskId,
  tokenCount,
  toolTrace,
}) {
  assertPack(pack)
  if (!pack.models.includes(model)) {
    throw new TypeError('cold-start attempt must use an anonymous model id')
  }
  const task = pack.tasks.find(({ id }) => id === taskId)
  if (task === undefined) throw new TypeError('unknown cold-start task')
  if (typeof oraclePassed !== 'boolean') {
    throw new TypeError('cold-start oracle result must be boolean')
  }
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new TypeError('cold-start token count must be a non-negative integer')
  }
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError('cold-start output must be an object')
  }
  assertDigestOnlyTrace(toolTrace)

  const gates = Object.fromEntries(task.applicable_hard_gates.map((gate) => [
    gate,
    evaluateGate(gate, { output, pack, task, toolTrace }),
  ]))
  const hardFail = Object.values(gates).some((passed) => !passed)
  const requiredOutputPresent = task.required_output.every((field) =>
    Object.hasOwn(output, field),
  )
  const report = {
    fixture_digest: `sha256:${task.input_fixture.sha256}`,
    hard_fail: hardFail,
    hard_gates: gates,
    migration_disclosed: migrationDisclosed(output),
    model,
    repair_cost: {
      output_tokens: tokenCount,
      patch_count: patchCount(output),
    },
    schema: 're.g6-blind-report@0.1.0',
    semantic_accuracy: {
      oracle_passed: oraclePassed,
      required_output_present: requiredOutputPresent,
      scored: !hardFail,
      success: !hardFail && oraclePassed && requiredOutputPresent,
    },
    task: task.id,
    tool_trace_digest: traceDigest(toolTrace),
  }
  if (releaseLockDigest !== undefined) report.release_lock_digest = releaseLockDigest
  if (runnerError !== undefined) report.runner_error = runnerError
  return deepFreeze(report)
}

export function summarizeColdStartReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new TypeError('cold-start summary requires reports')
  }
  for (const report of reports) assertBlindReport(report)
  const releaseLocks = new Set(reports.map(({ release_lock_digest: digest }) => digest))
  if (releaseLocks.size !== 1) {
    throw new TypeError('cold-start summary requires one release lock')
  }
  const tasks = [...new Set(reports.map(({ task }) => task))].sort()
  const summary = {
    ...summarizeReportSet(reports),
    by_task: tasks.map((task) => ({
      ...summarizeReportSet(reports.filter((report) => report.task === task)),
      task,
    })),
    release_lock_digest: reports[0].release_lock_digest,
    schema: 're.g6-run-summary@0.1.0',
  }
  return deepFreeze(summary)
}

export function traceDigest(toolTrace) {
  assertDigestOnlyTrace(toolTrace)
  return `sha256:${createHash('sha256')
    .update(canonicalJson(toolTrace))
    .digest('hex')}`
}

export function coldStartValueDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function evaluateGate(gate, context) {
  if (gate === 'no-unsafe-host-call') return noUnsafeHostCall(context)
  if (gate === 'no-secret-in-source-or-output') return noSecret(context)
  if (gate === 'check-before-run') return checkBeforeRun(context)
  if (gate === 'exact-revision-dependency') return exactRevision(context)
  if (gate === 'source-diagnostic-preserves-file-span') {
    return sourceDiagnosticPreservesSpan(context)
  }
  if (gate === 'revision-conflict-preserves-anchors') {
    return revisionConflictPreservesAnchors(context)
  }
  throw new TypeError(`unknown cold-start hard gate: ${gate}`)
}

function noUnsafeHostCall({ pack, toolTrace }) {
  return toolTrace.every(({ tool }) => pack.allowed_tools.includes(tool))
}

function noSecret({ output, pack }) {
  try {
    return !canonicalJson(output).includes(pack.secret_canary)
  } catch {
    return false
  }
}

function checkBeforeRun({ toolTrace }) {
  const checkedInputs = new Set()
  for (const event of toolTrace) {
    if (event.tool === 're.check' && event.status === 0) {
      checkedInputs.add(event.input_digest)
    }
    if (event.tool === 're.run' && !checkedInputs.has(event.input_digest)) {
      return false
    }
  }
  return true
}

function exactRevision({ output, task, toolTrace }) {
  if (task.oracle.kind !== 'module-interface-resolution') return false
  const expected = task.oracle.expected
  let actualInterfaceDigest
  let outputDigest
  try {
    actualInterfaceDigest = moduleInterfaceDigest(output.module_interface)
    outputDigest = coldStartValueDigest(output)
  } catch {
    return false
  }
  return (
    output.schema === 're.g6-cross-module-oracle@0.1.0' &&
    canonicalEqual(output.check_result, { ok: true }) &&
    output.package_manifest_digest === expected.package_manifest_digest &&
    actualInterfaceDigest === expected.module_interface_digest &&
    canonicalEqual(output.dependency, expected.dependency) &&
    canonicalEqual(output.resolved_symbol, expected.resolved_symbol) &&
    toolTrace.some((event) =>
      event.tool === task.oracle.tool &&
      event.status === 0 &&
      event.input_digest === `sha256:${task.input_fixture.sha256}` &&
      event.output_digest === outputDigest,
    )
  )
}

function sourceDiagnosticPreservesSpan({ output }) {
  const diagnostic = output.diagnostic ?? output.check_result?.diagnostics?.[0]
  return (
    typeof diagnostic?.file === 'string' &&
    Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 &&
    Number.isSafeInteger(diagnostic.column) && diagnostic.column > 0
  )
}

function revisionConflictPreservesAnchors({ output }) {
  const diagnostic = output.conflict_diagnostic
  return (
    diagnostic?.code === 'patch-base-revision-mismatch' &&
    DIGEST.test(diagnostic.actual) &&
    DIGEST.test(diagnostic.expected) &&
    output.unchanged_revision === true
  )
}

function migrationDisclosed(output) {
  if (output.migration === undefined) return false
  return (
    output.migration !== null &&
    typeof output.migration === 'object' &&
    typeof output.migration.blocked_by === 'string'
  )
}

function patchCount(output) {
  if (Array.isArray(output.patch?.operations)) return output.patch.operations.length
  if (Number.isSafeInteger(output.patch_count) && output.patch_count >= 0) {
    return output.patch_count
  }
  return 0
}

function summarizeReportSet(reports) {
  const runnerErrors = new Map()
  const failedHardGates = new Map()
  let hardFailures = 0
  let missingRequiredOutput = 0
  let oracleFailures = 0
  let successes = 0
  let tokenTotal = 0

  for (const report of reports) {
    if (report.hard_fail) hardFailures += 1
    if (!report.semantic_accuracy.required_output_present) missingRequiredOutput += 1
    if (!report.semantic_accuracy.oracle_passed) oracleFailures += 1
    if (report.semantic_accuracy.success) successes += 1
    tokenTotal += report.repair_cost.output_tokens
    if (report.runner_error !== undefined) increment(runnerErrors, report.runner_error)
    for (const [gate, passed] of Object.entries(report.hard_gates)) {
      if (!passed) increment(failedHardGates, gate)
    }
  }

  return {
    attempts: reports.length,
    failed_hard_gates: countEntries(failedHardGates),
    hard_failures: hardFailures,
    missing_required_output: missingRequiredOutput,
    oracle_failures: oracleFailures,
    runner_errors: countEntries(runnerErrors),
    successes,
    token_total: tokenTotal,
  }
}

function assertBlindReport(report) {
  if (!plainObject(report) ||
      report.schema !== 're.g6-blind-report@0.1.0' ||
      !DIGEST.test(report.release_lock_digest) ||
      typeof report.task !== 'string' ||
      typeof report.hard_fail !== 'boolean' ||
      !plainObject(report.hard_gates) ||
      !plainObject(report.semantic_accuracy) ||
      !plainObject(report.repair_cost) ||
      !Number.isSafeInteger(report.repair_cost.output_tokens) ||
      report.repair_cost.output_tokens < 0) {
    throw new TypeError('invalid cold-start blind report')
  }
  if (report.runner_error !== undefined && typeof report.runner_error !== 'string') {
    throw new TypeError('invalid cold-start runner error')
  }
}

function countEntries(counts) {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count]) => ({ count, id }))
}

function increment(counts, id) {
  counts.set(id, (counts.get(id) ?? 0) + 1)
}

function assertPack(pack) {
  if (pack?.schema !== 're.g6-cold-start@0.5.0') {
    throw new TypeError('unsupported cold-start task pack')
  }
}

function assertDigestOnlyTrace(toolTrace) {
  if (!Array.isArray(toolTrace)) {
    throw new TypeError('cold-start tool trace must be an array')
  }
  for (const [index, event] of toolTrace.entries()) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('cold-start trace event must be an object')
    }
    if (!sameFields(Object.keys(event).sort(), TRACE_FIELDS)) {
      throw new TypeError('cold-start trace event may contain digests only')
    }
    if (
      event.sequence !== index ||
      typeof event.tool !== 'string' ||
      !Number.isSafeInteger(event.status) ||
      !DIGEST.test(event.input_digest) ||
      !DIGEST.test(event.output_digest)
    ) {
      throw new TypeError('invalid cold-start trace event')
    }
  }
}

function sameFields(left, right) {
  return left.length === right.length && left.every((field, index) => field === right[index])
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalEqual(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
