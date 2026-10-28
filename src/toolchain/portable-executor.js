export const PORTABLE_EXECUTOR_CONTRACT_SCHEMA =
  're.portable-executor-contract@0.1.0'
export const PORTABLE_EXECUTION_RESULT_SCHEMA =
  're.portable-execution-result@0.1.0'
export const PORTABLE_EXECUTION_RECEIPT_SCHEMA =
  're.portable-execution-receipt@0.1.0'
export const PORTABLE_EXECUTOR_ID = 'portable-core'
export const PORTABLE_EXECUTOR_PROFILE = 're.portable-reference@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/u
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set
const VERIFICATION_EVIDENCE = new WeakMap()

export function executePortableProgram(program, { invokeCapability, invokePureOperation } = {}) {
  try {
    if (!plainObject(program) || !Array.isArray(program.functions)) {
      return failure('portable-executor-program-invalid')
    }
    if (typeof invokeCapability !== 'function') {
      return failure('portable-executor-capability-bridge-missing')
    }
    const main = program.functions.find(
      (candidate) => candidate?.name === '@main',
    )
    if (!plainObject(main) || !Array.isArray(main.statements)) {
      return failure('portable-executor-main-invalid')
    }
    const statements = new Map(
      main.statements
        .filter((statement) => typeof statement?.uid === 'string')
        .map((statement) => [statement.uid, statement]),
    )
    const literals = new Map(
      (main.literals ?? [])
        .filter((literal) => typeof literal?.uid === 'string')
        .map((literal) => [literal.uid, literal]),
    )
    const returned = main.statements.find(
      (statement) => statement?.kind === 'return',
    )
    if (!plainObject(returned)) {
      return failure('portable-executor-return-missing')
    }
    const values = new Map()
    return evaluateStatement(
      returned,
      statements,
      literals,
      values,
      invokeCapability,
      invokePureOperation,
    )
  } catch {
    return failure('portable-executor-failure')
  }
}

export function executePortableProgramContract({
  contract,
  graph,
  invokeCapability,
  invokePureOperation,
} = {}) {
  const checked = validatePortableExecutorContract(contract)
  if (!checked.ok) return checked
  if (!plainObject(graph)
    || graph.graph_revision !== contract.graph_revision) {
    return rejected('portable-executor-graph-revision-mismatch')
  }
  const invocations = []
  const replayInvocations = []
  const outcome = executePortableProgram(graph, {
    invokeCapability(instance, member, args, invocationId) {
      const argsSnapshot = snapshotValue(args)
      const response = snapshotValue(
        invokeCapability(instance, member, args, invocationId),
      )
      invocations.push({
        instance,
        invocation_id: invocationId,
        member,
        outcome: invocationOutcome(response),
      })
      replayInvocations.push({
        args: argsSnapshot,
        instance,
        invocation_id: invocationId,
        member,
        response,
      })
      return response
    },
    invokePureOperation,
  })
  if (outcome.kind === 'check-failure' || outcome.kind === 'host-fault') {
    return { diagnostics: outcome.diagnostics, ok: false }
  }
  const receipt = {
    executor: contract.executor,
    graph_revision: contract.graph_revision,
    input_digest: contract.input_digest,
    invocations,
    outcome: snapshotValue(outcome),
    profile: contract.profile,
    schema: PORTABLE_EXECUTION_RECEIPT_SCHEMA,
  }
  const verificationEvidence = Object.freeze(Object.create(null))
  VERIFICATION_EVIDENCE.set(verificationEvidence, freezeValue({
    contract: snapshotValue(contract),
    invocations: snapshotValue(replayInvocations),
    outcome: snapshotValue(outcome),
  }))
  return {
    ok: true,
    value: {
      contract: { ...contract },
      outcome,
      receipt,
      schema: PORTABLE_EXECUTION_RESULT_SCHEMA,
    },
    verification_evidence: verificationEvidence,
  }
}

export function verifyPortableExecutionResult(
  result,
  expectedContract,
  verification = {},
) {
  const contractResult = validatePortableExecutorContract(expectedContract)
  if (!contractResult.ok) return contractResult
  const evidence = VERIFICATION_EVIDENCE.get(verification?.evidence)
  if (evidence === undefined) {
    return rejected('portable-execution-verification-evidence-missing')
  }
  const graph = verification.graph
  if (!plainObject(graph)) {
    return rejected('portable-execution-verification-graph-missing')
  }
  if (graph.graph_revision !== expectedContract.graph_revision) {
    return rejected('portable-execution-verification-graph-revision-mismatch')
  }
  if (!plainObject(result)
    || result.schema !== PORTABLE_EXECUTION_RESULT_SCHEMA) {
    return rejected('portable-execution-result-schema-mismatch')
  }
  const diagnostics = []
  exactFields(result, ['contract', 'outcome', 'receipt', 'schema'], diagnostics)
  if (!canonicalEqual(result.contract, expectedContract)) {
    diagnostics.push({ code: 'portable-execution-contract-mismatch' })
  }
  const receipt = result.receipt
  if (!plainObject(receipt)
    || receipt.schema !== PORTABLE_EXECUTION_RECEIPT_SCHEMA) {
    diagnostics.push({ code: 'portable-execution-receipt-schema-mismatch' })
    return verificationResult(diagnostics)
  }
  exactFields(receipt, [
    'executor',
    'graph_revision',
    'input_digest',
    'invocations',
    'outcome',
    'profile',
    'schema',
  ], diagnostics)
  for (const field of [
    'executor',
    'graph_revision',
    'input_digest',
    'profile',
  ]) {
    if (receipt[field] !== expectedContract[field]) {
      diagnostics.push({
        code: 'portable-execution-receipt-contract-mismatch',
        field,
      })
    }
  }
  if (!canonicalEqual(receipt.outcome, result.outcome)) {
    diagnostics.push({ code: 'portable-execution-receipt-outcome-mismatch' })
  }
  if (!Array.isArray(receipt.invocations)
    || receipt.invocations.some((invocation) => !validInvocation(invocation))) {
    diagnostics.push({ code: 'portable-execution-receipt-invocations-invalid' })
  }
  if (diagnostics.length === 0) {
    const replay = replayPortableEvidence(graph, evidence)
    if (!replay.ok) {
      diagnostics.push(...replay.diagnostics)
    } else {
      if (!canonicalEqual(evidence.contract, result.contract)) {
        diagnostics.push({ code: 'portable-execution-evidence-contract-mismatch' })
      }
      if (!canonicalEqual(replay.invocations, receipt.invocations)) {
        diagnostics.push({ code: 'portable-execution-evidence-invocations-mismatch' })
      }
      if (!canonicalEqual(evidence.outcome, replay.outcome)
        || !canonicalEqual(evidence.outcome, result.outcome)
        || !canonicalEqual(evidence.outcome, receipt.outcome)) {
        diagnostics.push({ code: 'portable-execution-evidence-outcome-mismatch' })
      }
    }
  }
  return verificationResult(diagnostics)
}

export function validatePortableExecutorContract(contract) {
  const diagnostics = []
  if (!plainObject(contract)
    || contract.schema !== PORTABLE_EXECUTOR_CONTRACT_SCHEMA) {
    return rejected('portable-executor-contract-schema-mismatch')
  }
  exactFields(contract, [
    'executor',
    'graph_revision',
    'input_digest',
    'profile',
    'schema',
  ], diagnostics)
  if (contract.executor !== PORTABLE_EXECUTOR_ID) {
    diagnostics.push({ code: 'portable-executor-identity-mismatch' })
  }
  if (contract.profile !== PORTABLE_EXECUTOR_PROFILE) {
    diagnostics.push({ code: 'portable-executor-profile-mismatch' })
  }
  for (const field of ['graph_revision', 'input_digest']) {
    if (!DIGEST.test(contract[field])) {
      diagnostics.push({
        code: 'portable-executor-invalid-digest',
        field,
      })
    }
  }
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function evaluateStatement(
  statement,
  statements,
  literals,
  values,
  invokeCapability,
  invokePureOperation,
) {
  if (values.has(statement.uid)) return values.get(statement.uid)
  let value
  if (statement.kind === 'let') {
    value = evaluateCall(
      statement.value,
      literals,
      invokeCapability,
      invokePureOperation,
      statement.uid,
    )
  } else if (statement.kind === 'return') {
    value = evaluateMatch(
      statement.value,
      statements,
      literals,
      values,
      invokeCapability,
      invokePureOperation,
      statement.uid,
    )
  } else {
    return failure('portable-executor-unsupported-statement')
  }
  values.set(statement.uid, value)
  return value
}

function evaluateMatch(
  match,
  statements,
  literals,
  values,
  invokeCapability,
  invokePureOperation,
  invocationId,
) {
  if (!plainObject(match) || !plainObject(match.input)) {
    return failure('portable-executor-match-invalid')
  }
  const producer = statements.get(match.input.producer)
  if (producer === undefined) {
    return failure('portable-executor-match-producer-missing')
  }
  const outcome = evaluateStatement(
    producer,
    statements,
    literals,
    values,
    invokeCapability,
    invokePureOperation,
  )
  if (outcome.kind === 'host-fault' || outcome.kind === 'check-failure') {
    return outcome
  }
  const variant = outcome.value?.kind
  if (typeof variant !== 'string') {
    return failure('portable-executor-result-invalid')
  }
  const branch = (match.branches ?? []).find(
    (candidate) => candidate?.variant === variant,
  )
  if (branch === undefined) {
    return failure('portable-executor-missing-match-branch', { variant })
  }
  return evaluateCall(
    branch.value,
    literals,
    invokeCapability,
    invokePureOperation,
    `${invocationId}:${branch.variant}`,
  )
}

function evaluateCall(
  call,
  literals,
  invokeCapability,
  invokePureOperation,
  invocationId = call?.uid,
) {
  if (!plainObject(call) || !plainObject(call.target)) {
    return failure('portable-executor-call-invalid')
  }
  const args = argumentValues(call, literals)
  if (!args.ok) return args
  if (call.target.kind === 'capability-member') {
    let outcome
    try {
      outcome = invokeCapability(
        call.target.instance,
        call.target.member,
        args.value,
        invocationId,
      )
    } catch {
      return {
        diagnostics: [{
          code: 'portable-executor-capability-fault',
          instance: call.target.instance,
          member: call.target.member,
        }],
        kind: 'host-fault',
      }
    }
    if (!plainObject(outcome)
      || !['value', 'host-fault', 'check-failure'].includes(outcome.kind)) {
      return failure('portable-executor-capability-outcome-invalid')
    }
    return outcome
  }
  if (call.target.kind !== 'pure-operation'
    || typeof call.target.operation !== 'string') {
    return failure('portable-executor-unsupported-pure-operation')
  }
  if (call.target.operation === 'process.exit') return processExit(args.value.code)
  if (typeof invokePureOperation !== 'function') {
    return failure('portable-executor-unsupported-pure-operation')
  }
  try {
    const outcome = invokePureOperation(call.target.operation, args.value)
    if (!plainObject(outcome) || outcome.ok !== true
      || !Object.hasOwn(outcome, 'value')) {
      return failure('portable-executor-pure-operation-failed')
    }
    return { kind: 'value', value: outcome.value }
  } catch {
    return failure('portable-executor-pure-operation-failed')
  }
}

function argumentValues(call, literals) {
  const resolved = {}
  for (const [name, binding] of Object.entries(call.typedArguments ?? {})) {
    const literal = literals.get(binding.endpoint)
    if (!plainObject(literal)) {
      return failure('portable-executor-literal-missing')
    }
    const value = literal.type === 'bytes'
      ? decodeBytes(literal.value)
      : literal.value
    if (value === INVALID) {
      return failure('portable-executor-literal-invalid')
    }
    resolved[name] = value
  }
  return { ok: true, value: resolved }
}

function processExit(code) {
  const numeric = typeof code === 'number'
    ? Number.isSafeInteger(code) ? code : null
    : INTEGER.test(code) ? Number(BigInt(code)) : null
  if (numeric === null || numeric < 0 || numeric > 255) {
    return failure('portable-executor-process-exit-invalid')
  }
  return { code: numeric, type: 'process.status' }
}

function decodeBytes(value) {
  if (typeof value !== 'string' || !/^hex:(?:[0-9a-f]{2})*$/u.test(value)) {
    return INVALID
  }
  const bytes = new Uint8Array((value.length - 4) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(4 + index * 2, 6 + index * 2), 16)
  }
  return bytes
}

function exactFields(value, expected, diagnostics) {
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      diagnostics.push({
        code: 'portable-executor-contract-unexpected-field',
        field,
      })
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({
        code: 'portable-executor-contract-missing-field',
        field,
      })
    }
  }
}

function invocationOutcome(value) {
  if (value?.kind === 'value' && value.value?.kind === 'ok') return 'ok'
  if (value?.kind === 'value' && value.value?.kind === 'err') return 'err'
  if (value?.kind === 'host-fault') return 'host-fault'
  if (value?.kind === 'check-failure') return 'check-failure'
  return 'invalid'
}

function validInvocation(value) {
  if (!plainObject(value)) return false
  const fields = Object.keys(value).sort()
  if (!canonicalEqual(fields, [
    'instance',
    'invocation_id',
    'member',
    'outcome',
  ])) return false
  return typeof value.instance === 'string'
    && typeof value.invocation_id === 'string'
    && typeof value.member === 'string'
    && ['check-failure', 'err', 'host-fault', 'invalid', 'ok'].includes(
      value.outcome,
    )
}

function replayPortableEvidence(graph, evidence) {
  let index = 0
  let mismatch = null
  const invocations = []
  const outcome = executePortableProgram(graph, {
    invokeCapability(instance, member, args, invocationId) {
      const invocation = evidence.invocations[index]
      index += 1
      if (invocation === undefined
        || invocation.instance !== instance
        || invocation.member !== member
        || invocation.invocation_id !== invocationId) {
        mismatch = 'portable-execution-replay-invocation-mismatch'
        return failure('portable-execution-replay-invocation-mismatch')
      }
      if (!canonicalEqual(invocation.args, args)) {
        mismatch = 'portable-execution-replay-invocation-arguments-mismatch'
        return failure(mismatch)
      }
      invocations.push({
        instance,
        invocation_id: invocationId,
        member,
        outcome: invocationOutcome(invocation.response),
      })
      return snapshotValue(invocation.response)
    },
  })
  if (mismatch !== null) {
    return rejected(mismatch)
  }
  if (index !== evidence.invocations.length) {
    return rejected('portable-execution-replay-invocation-mismatch')
  }
  if (outcome.kind === 'check-failure' || outcome.kind === 'host-fault') {
    return rejected('portable-execution-replay-failed')
  }
  return { invocations, ok: true, outcome }
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function snapshotValue(value) {
  if (value instanceof Uint8Array) {
    const bytes = new Uint8Array(
      Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []),
    )
    Reflect.apply(TYPED_ARRAY_SET, bytes, [value])
    return bytes
  }
  if (Array.isArray(value)) return value.map(snapshotValue)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, snapshotValue(child)]),
    )
  }
  return value
}

function freezeValue(value) {
  if (Array.isArray(value)) {
    for (const child of value) freezeValue(child)
  } else if (plainObject(value)) {
    for (const child of Object.values(value)) freezeValue(child)
  } else {
    return value
  }
  return Object.freeze(value)
}

function verificationResult(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function failure(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], kind: 'check-failure' }
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const INVALID = Symbol('portable-executor-invalid')
