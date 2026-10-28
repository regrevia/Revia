import { createHash } from 'node:crypto'

const CONTRACT_SCHEMA = 're.agent-adapter-contract@0.1.0'
const OUTCOME_SCHEMA = 're.agent-adapter-outcome@0.1.0'
const PROFILE_SCHEMA = 're.server-profile@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const NAME = /^[a-z][a-z0-9_]*$/
const REFERENCE = /^[a-z][a-z0-9_.-]*@[0-9]+\.[0-9]+\.[0-9]+$/
const FEATURES = ['cancellation', 'deadline']

export const AGENT_ADAPTER_CONTRACT_SCHEMA = CONTRACT_SCHEMA
export const AGENT_ADAPTER_OUTCOME_SCHEMA = OUTCOME_SCHEMA

export function validateAgentAdapterContract(input) {
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
      diagnostics: [error?.diagnostic ?? { code: 'malformed-agent-adapter-contract' }],
      ok: false,
    }
  }
}

export function agentAdapterContractDigest(input) {
  return digest(normalizeContract(input))
}

export function invokeAgentCapability(contractInput, adapter, call) {
  const validation = validateAgentAdapterContract(contractInput)
  if (!validation.ok) return validation
  try {
    const contract = validation.value
    assertAdapter(adapter)
    const profile = snapshotProfile(adapter.profileIdentity())
    if (!same(profile, contract.profile)) fail('agent-profile-identity-mismatch')
    const request = normalizeCall(contract, call)
    if (request.cancellation === 'requested'
      && !contract.features.includes('cancellation')) {
      fail('unsupported-agent-feature', { feature: 'cancellation' })
    }
    if (request.deadline !== null && !contract.features.includes('deadline')) {
      fail('unsupported-agent-feature', { feature: 'deadline' })
    }
    let outcome
    try {
      outcome = adapter.invoke(
        { interface: contract.capability.reference, member: contract.capability.member },
        request.input,
        {
          cancellation: request.cancellation,
          deadline: request.deadline,
          request_id: request.request_id,
        },
      )
    } catch {
      return hostFault(contract, request, 'adapter-panicked')
    }
    if (outcome instanceof Promise) {
      return outcome.then(
        (value) => normalizeOutcome(contract, request, value),
        () => hostFault(contract, request, 'adapter-panicked'),
      )
    }
    return normalizeOutcome(contract, request, outcome)
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-agent-adapter-call' }],
      ok: false,
    }
  }
}

function normalizeContract(input) {
  assertObject(input, 'invalid-agent-adapter-contract')
  exactFields(input, [
    'agent', 'capability', 'cancellation', 'deadline', 'error_type',
    'error_variants',
    'features', 'input_type', 'module', 'node_uid', 'output_type', 'profile',
    'request_type', 'resource', 'schema',
  ], 'agent-adapter-contract')
  if (input.schema !== CONTRACT_SCHEMA) fail('unsupported-agent-adapter-contract')
  if (!NAME.test(input.agent) || !NAME.test(input.module)) {
    if (!SEMANTIC_NAME(input.agent) || !SEMANTIC_NAME(input.module)) {
      fail('invalid-agent-adapter-owner')
    }
  }
  if (!/^[a-z2-7]{25}[aeimquy4]$/.test(input.node_uid)) {
    fail('invalid-agent-adapter-node-uid')
  }
  const profile = normalizeProfile(input.profile)
  const capability = normalizeCapability(input.capability)
  const requestType = normalizeType(input.request_type, 'request')
  const inputType = normalizeType(input.input_type, 'input')
  const outputType = normalizeType(input.output_type, 'output')
  const errorType = normalizeType(input.error_type, 'error')
  const errorVariants = uniqueNames(input.error_variants, 'agent-adapter-error-variant')
  const features = uniqueFeatures(input.features)
  const deadline = normalizeDeadline(input.deadline)
  const cancellation = normalizeCancellation(input.cancellation)
  if (deadline.required && !features.includes('deadline')) {
    fail('deadline-feature-not-declared')
  }
  if (cancellation.supported && !features.includes('cancellation')) {
    fail('cancellation-feature-not-declared')
  }
  const resource = normalizeResource(input.resource)
  return {
    agent: input.agent,
    capability,
    cancellation,
    deadline,
    error_type: errorType,
    error_variants: errorVariants,
    features,
    input_type: inputType,
    module: input.module,
    node_uid: input.node_uid,
    output_type: outputType,
    profile,
    request_type: requestType,
    resource,
  }
}

function normalizeProfile(input) {
  assertObject(input, 'invalid-agent-adapter-profile')
  exactFields(input, ['digest', 'id', 'schema'], 'agent-adapter-profile')
  if (input.schema !== PROFILE_SCHEMA || typeof input.id !== 'string'
    || !REFERENCE.test(input.id) || !DIGEST.test(input.digest)) {
    fail('invalid-agent-adapter-profile')
  }
  return { digest: input.digest, id: input.id, schema: input.schema }
}

function normalizeCapability(input) {
  assertObject(input, 'invalid-agent-adapter-capability')
  exactFields(input, ['instance', 'member', 'reference'], 'agent-adapter-capability')
  if (!NAME.test(input.member) || typeof input.instance !== 'string'
    || !input.instance.startsWith('@') || !REFERENCE.test(input.reference)) {
    fail('invalid-agent-adapter-capability')
  }
  return {
    instance: input.instance,
    member: input.member,
    reference: input.reference,
  }
}

function normalizeType(input, label) {
  assertObject(input, `invalid-agent-adapter-${label}-type`)
  exactFields(input, ['kind', 'name'], `agent-adapter-${label}-type`)
  if (input.kind !== 'type' || typeof input.name !== 'string'
    || !SEMANTIC_NAME(input.name)) {
    fail(`invalid-agent-adapter-${label}-type`)
  }
  return { kind: input.kind, name: input.name }
}

function normalizeDeadline(input) {
  assertObject(input, 'invalid-agent-adapter-deadline')
  exactFields(input, ['max_ms', 'required'], 'agent-adapter-deadline')
  if (typeof input.required !== 'boolean'
    || !Number.isSafeInteger(input.max_ms)
    || input.max_ms < 0) {
    fail('invalid-agent-adapter-deadline')
  }
  return { max_ms: input.max_ms, required: input.required }
}

function normalizeCancellation(input) {
  assertObject(input, 'invalid-agent-adapter-cancellation')
  exactFields(input, ['mode', 'supported'], 'agent-adapter-cancellation')
  if (!['cooperative', 'complete-before-join'].includes(input.mode)
    || typeof input.supported !== 'boolean') {
    fail('invalid-agent-adapter-cancellation')
  }
  return { mode: input.mode, supported: input.supported }
}

function normalizeResource(input) {
  assertObject(input, 'invalid-agent-adapter-resource')
  exactFields(input, ['access', 'constructor'], 'agent-adapter-resource')
  if (!['read', 'write'].includes(input.access)
    || typeof input.constructor !== 'string'
    || !/^[a-z][a-z0-9_.-]*$/.test(input.constructor)) {
    fail('invalid-agent-adapter-resource')
  }
  return { access: input.access, constructor: input.constructor }
}

function normalizeCall(contract, input) {
  assertObject(input, 'invalid-agent-adapter-call')
  exactFields(input, [
    'capability_reference', 'cancellation', 'deadline', 'input',
    'member', 'request_id',
  ], 'agent-adapter-call')
  if (input.capability_reference !== contract.capability.reference
    || input.member !== contract.capability.member) {
    fail('agent-capability-mismatch')
  }
  if (typeof input.request_id !== 'string' || input.request_id.length === 0) {
    fail('invalid-agent-request-id')
  }
  if (input.cancellation !== null && input.cancellation !== 'requested') {
    fail('invalid-agent-cancellation-request')
  }
  if (input.deadline !== null
    && (!Number.isSafeInteger(input.deadline)
      || input.deadline < 0
      || input.deadline > contract.deadline.max_ms)) {
    fail('invalid-agent-deadline')
  }
  if (contract.deadline.required && input.deadline === null) fail('missing-agent-deadline')
  return {
    cancellation: input.cancellation,
    deadline: input.deadline,
    input: snapshotValue(input.input),
    request_id: input.request_id,
  }
}

function assertAdapter(adapter) {
  if (adapter === null
    || typeof adapter !== 'object'
    || typeof adapter.profileIdentity !== 'function'
    || typeof adapter.invoke !== 'function') {
    fail('invalid-agent-adapter')
  }
}

function normalizeOutcome(contract, request, outcome) {
  if (outcome?.kind === 'host-fault') return hostFault(contract, request, 'malformed-adapter-outcome')
  if (outcome?.kind === 'cancelled') {
    return {
      ok: true,
      value: {
        outcome: { kind: 'cancelled' },
        request_id: request.request_id,
        schema: OUTCOME_SCHEMA,
      },
    }
  }
  if (outcome?.kind !== 'value' || outcome.value === null
    || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) {
    return hostFault(contract, request, 'malformed-adapter-outcome')
  }
  const value = outcome.value
  if (value.kind === 'ok') {
    if (Object.keys(value).sort().join(',') !== 'kind,value') {
      return hostFault(contract, request, 'malformed-adapter-outcome')
    }
    return {
      ok: true,
      value: {
        outcome: {
          kind: 'ok',
          value: snapshotValue(value.value),
        },
        request_id: request.request_id,
        schema: OUTCOME_SCHEMA,
      },
    }
  }
  if (value.kind === 'err') {
    if (Object.keys(value).sort().join(',') !== 'error,kind'
      || value.error === null
      || typeof value.error !== 'object'
      || value.error.type !== contract.error_type.name
      || !contract.error_variants.includes(value.error.variant)) {
      return hostFault(contract, request, 'undeclared-error-variant')
    }
    return {
      ok: true,
      value: {
        outcome: { error: { ...value.error }, kind: 'err' },
        request_id: request.request_id,
        schema: OUTCOME_SCHEMA,
      },
    }
  }
  return hostFault(contract, request, 'malformed-adapter-outcome')
}

function hostFault(contract, request, reason) {
  return {
    ok: true,
    value: {
      fault: {
        capability_reference: contract.capability.reference,
        code: 'host-contract-violation',
        member: contract.capability.member,
        phase: 'invoke',
        reason,
        request_id: request.request_id,
      },
      outcome: { kind: 'host-fault' },
      schema: OUTCOME_SCHEMA,
    },
  }
}

function snapshotProfile(input) {
  const profile = normalizeProfile(input)
  return profile
}

function snapshotValue(input) {
  try {
    return structuredClone(input)
  } catch {
    fail('invalid-agent-adapter-value')
  }
}

function uniqueFeatures(input) {
  if (!Array.isArray(input)) fail('invalid-agent-adapter-features')
  const features = [...input]
  if (new Set(features).size !== features.length
    || features.some((feature) => !FEATURES.includes(feature))) {
    fail('invalid-agent-adapter-feature')
  }
  return features.sort(compareText)
}

function uniqueNames(input, label) {
  if (!Array.isArray(input) || input.length === 0) fail(`invalid-${label}-set`)
  const values = [...input]
  if (new Set(values).size !== values.length
    || values.some((value) => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))) {
    fail(`invalid-${label}`)
  }
  return values.sort(compareText)
}

function same(left, right) {
  return stableJson(left) === stableJson(right)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    if (value instanceof Uint8Array) {
      return `{"$bytes":"${Buffer.from(value).toString('hex')}"}`
    }
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function SEMANTIC_NAME(value) {
  return typeof value === 'string'
    && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value)
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

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function fail(code, detail = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...detail } })
}
