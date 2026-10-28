import { createHash } from 'node:crypto'

const CONTRACT_SCHEMA = 're.task-contract@0.1.0'
const CHECKPOINT_SCHEMA = 're.task-checkpoint@0.1.0'
const NAME = /^[a-z][a-z0-9_]*$/
const SEMANTIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const UID = /^[a-z2-7]{25}[aeimquy4]$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const MAX_ATTEMPTS = 32

export function validateTaskContract(input) {
  try {
    const contract = normalizeContract(input)
    return {
      ok: true,
      value: {
        ...contract,
        contract_digest: digest(contract),
        schema: CONTRACT_SCHEMA,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-task-contract' }],
      ok: false,
    }
  }
}

export function taskContractDigest(input) {
  return digest(normalizeContract(input))
}

export function taskIdentity(contractInput, request) {
  const validation = validateTaskContract(contractInput)
  if (!validation.ok) return validation
  try {
    const contract = validation.value
    assertRequest(request)
    if (
      request.agent !== contract.agent
      || request.module !== contract.module
      || request.node_uid !== contract.node_uid
    ) {
      fail('detached-task', { agent: request.agent, module: request.module })
    }
    return {
      ok: true,
      value: {
        agent: contract.agent,
        caller_idempotency_key: request.idempotency_key,
        input_digest: digest(canonical(request.input)),
        module: contract.module,
        node_uid: contract.node_uid,
        revision: request.revision,
        task_id: digest({
          agent: contract.agent,
          caller_idempotency_key: request.idempotency_key,
          input: canonical(request.input),
          module: contract.module,
          node_uid: contract.node_uid,
          revision: request.revision,
        }),
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-task-request' }],
      ok: false,
    }
  }
}

export function checkpointDigest(checkpoint) {
  return digest(normalizeCheckpoint(checkpoint))
}

function normalizeContract(input) {
  assertObject(input, 'invalid-task-contract')
  exactFields(input, [
    'agent', 'backoff_ms', 'checkpoint', 'error_type', 'input_type',
    'max_attempts', 'module', 'node_uid', 'output_type', 'retryable_errors',
    'schema',
  ], 'task-contract')
  if (input.schema !== CONTRACT_SCHEMA) fail('unsupported-task-contract')
  if (!SEMANTIC_NAME.test(input.agent)) fail('invalid-task-agent')
  if (!SEMANTIC_NAME.test(input.module)) fail('invalid-task-module')
  if (!UID.test(input.node_uid)) fail('invalid-task-node-uid')
  for (const [value, label] of [
    [input.input_type, 'input'],
    [input.output_type, 'output'],
    [input.error_type, 'error'],
  ]) {
    assertObject(value, `invalid-task-${label}-type`)
    exactFields(value, ['kind', 'name'], `task-${label}-type`)
    if (value.kind !== 'type' || !SEMANTIC_NAME.test(value.name)) {
      fail(`invalid-task-${label}-type`)
    }
  }
  if (!Number.isSafeInteger(input.max_attempts)
    || input.max_attempts < 1
    || input.max_attempts > MAX_ATTEMPTS) {
    fail('invalid-task-max-attempts')
  }
  if (!Array.isArray(input.backoff_ms)
    || input.backoff_ms.length !== input.max_attempts - 1) {
    fail('invalid-task-backoff-schedule')
  }
  const backoff = input.backoff_ms.map((value) => {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid-task-backoff')
    return value
  })
  const retryableErrors = uniqueNames(input.retryable_errors, 'task-retryable-error', true)
  const checkpoint = normalizeCheckpointSchema(input.checkpoint)
  return {
    agent: input.agent,
    backoff_ms: backoff,
    checkpoint,
    error_type: { ...input.error_type },
    input_type: { ...input.input_type },
    max_attempts: input.max_attempts,
    module: input.module,
    node_uid: input.node_uid,
    output_type: { ...input.output_type },
    retryable_errors: retryableErrors,
  }
}

function normalizeCheckpointSchema(input) {
  assertObject(input, 'invalid-task-checkpoint-schema')
  exactFields(input, ['fields', 'revision_field', 'schema'], 'task-checkpoint-schema')
  if (input.schema !== CHECKPOINT_SCHEMA) fail('unsupported-task-checkpoint-schema')
  if (input.revision_field !== 'revision') fail('invalid-task-checkpoint-revision-field')
  const fields = uniqueNames(input.fields, 'task-checkpoint-field')
  if (!fields.includes('revision') || !fields.includes('input_digest')) {
    fail('invalid-task-checkpoint-fields')
  }
  return {
    fields,
    revision_field: input.revision_field,
    schema: CHECKPOINT_SCHEMA,
  }
}

function normalizeCheckpoint(input) {
  assertObject(input, 'invalid-task-checkpoint')
  exactFields(input, [
    'attempt', 'data', 'input_digest', 'revision', 'state', 'task_id',
  ], 'task-checkpoint')
  if (!DIGEST.test(input.task_id) || !DIGEST.test(input.input_digest)) {
    fail('invalid-task-checkpoint-digest')
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    fail('invalid-task-checkpoint-attempt')
  }
  if (typeof input.revision !== 'string' || input.revision.length === 0) {
    fail('invalid-task-checkpoint-revision')
  }
  if (!['running', 'retrying'].includes(input.state)) fail('invalid-task-checkpoint-state')
  if (input.data === null || typeof input.data !== 'object' || Array.isArray(input.data)) {
    fail('invalid-task-checkpoint-data')
  }
  return {
    attempt: input.attempt,
    data: canonical(input.data),
    input_digest: input.input_digest,
    revision: input.revision,
    state: input.state,
    task_id: input.task_id,
  }
}

export function normalizeTaskCheckpoint(input) {
  try {
    return { ok: true, value: normalizeCheckpoint(input) }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-task-checkpoint' }],
      ok: false,
    }
  }
}

function assertRequest(request) {
  assertObject(request, 'invalid-task-request')
  exactFields(request, [
    'agent', 'idempotency_key', 'input', 'module', 'node_uid', 'revision',
  ], 'task-request')
  if (!SEMANTIC_NAME.test(request.agent) || !SEMANTIC_NAME.test(request.module)) {
    fail('invalid-task-request-identity')
  }
  if (!UID.test(request.node_uid)) fail('invalid-task-request-node-uid')
  if (typeof request.revision !== 'string' || request.revision.length === 0) {
    fail('invalid-task-revision')
  }
  if (typeof request.idempotency_key !== 'string'
    || request.idempotency_key.length === 0
    || request.idempotency_key.length > 256) {
    fail('invalid-task-idempotency-key')
  }
  canonical(request.input)
}

function uniqueNames(input, label, allowEmpty) {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    fail(`invalid-${label}-set`)
  }
  const values = [...input]
  for (const value of values) if (!NAME.test(value)) fail(`invalid-${label}`, { value })
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`)
  return values.sort(compareText)
}

function exactFields(input, expected, label) {
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    const unexpected = actual.find((field) => !wanted.includes(field))
    fail(
      unexpected === undefined ? `missing-${label}-field` : `unexpected-${label}-field`,
      unexpected === undefined ? {} : { field: unexpected },
    )
  }
}

function canonical(value, visiting = new Set()) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, visiting))
  if (value !== null && typeof value === 'object') {
    if (visiting.has(value)) fail('cyclic-task-value')
    visiting.add(value)
    const result = Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key], visiting)]),
    )
    visiting.delete(value)
    return result
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  fail('invalid-task-value')
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function fail(code, detail = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...detail } })
}
