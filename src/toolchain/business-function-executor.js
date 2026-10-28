import { createHash } from 'node:crypto'

import { invokeAgentCapability } from '../host/agent-adapter-contract.js'
import { canonicalizeValue, typeDeclarationDigest } from './type-contract.js'

export const BUSINESS_FUNCTION_EXECUTION_SCHEMA =
  're.business-function-execution@0.1.0'

export function validateBusinessFunctionBinding(input) {
  try {
    assertObject(input, 'invalid-business-function-binding')
    exactFields(input, [
      'adapter_contract', 'declarations', 'function_declaration',
    ], 'business-function-binding')
    if (!Array.isArray(input.declarations)) {
      fail('invalid-business-function-declarations')
    }
    const registry = declarationRegistry(input.declarations)
    const call = executableCall(input.function_declaration)
    bindAdapterTypes(
      input.function_declaration,
      call,
      input.adapter_contract,
      registry,
    )
    bindCapability(call, input.adapter_contract)
    return { ok: true, value: { call } }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'business-function-binding-failure' }],
      ok: false,
    }
  }
}

export async function executeBusinessFunction(input) {
  try {
    const {
      adapter,
      adapter_contract: adapterContract,
      declarations,
      function_declaration: declaration,
      input: functionInput,
      request_id: requestId,
    } = normalizeRequest(input)
    const binding = validateBusinessFunctionBinding({
      adapter_contract: adapterContract,
      declarations,
      function_declaration: declaration,
    })
    if (!binding.ok) fail(binding.diagnostics[0].code, binding.diagnostics[0])
    const call = binding.value.call

    const canonicalInput = canonicalValue(
      declaration.input_type,
      functionInput,
      declarations,
      'business-function-input-invalid',
    )
    const adapterResult = await invokeAgentCapability(
      adapterContract,
      adapter,
      {
        capability_reference: call.capability.reference,
        cancellation: null,
        deadline: null,
        input: canonicalInput,
        member: call.capability.member,
        request_id: requestId,
      },
    )
    if (!adapterResult.ok) fail('business-function-adapter-contract-failure')
    const outcome = adapterResult.value?.outcome
    let typedOutcome
    if (outcome?.kind === 'ok') {
      typedOutcome = {
        kind: 'ok',
        value: canonicalValue(
          declaration.output_type,
          outcome.value,
          declarations,
          'business-function-output-invalid',
        ),
      }
    } else if (outcome?.kind === 'err') {
      typedOutcome = {
        error: canonicalValue(
          declaration.error_type,
          outcome.error,
          declarations,
          'business-function-error-invalid',
        ),
        kind: 'err',
      }
    } else if (outcome?.kind === 'cancelled') {
      typedOutcome = { kind: 'cancelled' }
    } else {
      fail('business-function-host-fault')
    }
    const trace = [{
      call: call.id,
      capability_reference: call.capability.reference,
      input_digest: digest(canonicalInput),
      outcome_digest: digest(typedOutcome),
      request_id: requestId,
    }]
    return {
      ok: true,
      value: {
        input: canonicalInput,
        outcome: typedOutcome,
        schema: BUSINESS_FUNCTION_EXECUTION_SCHEMA,
        trace,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'business-function-execution-failure' }],
      ok: false,
    }
  }
}

function normalizeRequest(input) {
  assertObject(input, 'invalid-business-function-execution')
  exactFields(input, [
    'adapter', 'adapter_contract', 'declarations', 'function_declaration',
    'input', 'request_id',
  ], 'business-function-execution')
  if (!Array.isArray(input.declarations)) fail('invalid-business-function-declarations')
  if (typeof input.request_id !== 'string' || input.request_id.length === 0) {
    fail('invalid-business-function-request-id')
  }
  assertObject(input.function_declaration, 'invalid-business-function-declaration')
  assertObject(input.adapter_contract, 'invalid-business-function-adapter-contract')
  return input
}

function executableCall(declaration) {
  const body = declaration.body
  assertObject(body, 'unsupported-business-function-body')
  if (!Array.isArray(body.calls)
    || body.calls.length !== 0
    || !Array.isArray(body.capability_calls)
    || body.capability_calls.length !== 1
    || !Array.isArray(body.effect_edges)
    || body.effect_edges.length !== 1
    || body.control_flow?.construct !== 'result-flow') {
    fail('unsupported-business-function-body')
  }
  const call = body.capability_calls[0]
  const edge = body.effect_edges[0]
  if (edge.call !== call.id
    || edge.to !== call.id
    || edge.resource !== call.resource.constructor
    || edge.access !== call.resource.access
    || !body.control_flow.edges?.some(
      ({ consumer, from, kind }) =>
        consumer === true
        && from === `${call.id}.result`
        && kind === 'value',
    )) {
    fail('unsupported-business-function-body')
  }
  return call
}

function declarationRegistry(declarations) {
  const byName = new Map()
  for (const declaration of declarations) {
    const name = `${declaration.module}.${declaration.name}`
    const entry = {
      declaration,
      digest: typeDeclarationDigest(declaration),
    }
    if (byName.has(name)) fail('duplicate-business-function-type-name', { name })
    byName.set(name, entry)
  }
  return byName
}

function bindAdapterTypes(declaration, call, contract, registry) {
  const pairs = [
    [contract.request_type, call.input_type],
    [contract.input_type, call.input_type],
    [contract.output_type, call.output_type],
    [contract.error_type, call.error_type],
  ]
  for (const [named, declared] of pairs) {
    const resolved = registry.get(named?.name)
    if (named?.kind !== 'type'
      || resolved === undefined
      || declared?.kind !== 'declared'
      || resolved.digest !== declared.declaration_digest) {
      fail('business-function-capability-type-mismatch')
    }
  }
  if (call.input_type.declaration_digest !== declaration.input_type?.declaration_digest
    || call.output_type.declaration_digest !== declaration.output_type?.declaration_digest
    || call.error_type.declaration_digest !== declaration.error_type?.declaration_digest) {
    fail('business-function-capability-type-mismatch')
  }
}

function bindCapability(call, contract) {
  if (call.node_uid !== contract.node_uid
    || call.capability.instance !== contract.capability.instance
    || call.capability.member !== contract.capability.member
    || call.capability.reference !== contract.capability.reference
    || call.resource.access !== contract.resource.access
    || call.resource.constructor !== contract.resource.constructor) {
    fail('business-function-capability-binding-mismatch')
  }
}

function canonicalValue(type, value, declarations, code) {
  const result = canonicalizeValue(type, value, declarations)
  if (!result.ok) fail(code, { value_diagnostics: result.diagnostics })
  return result.value
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

function exactFields(input, expected, label) {
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.length !== wanted.length
    || actual.some((field, index) => field !== wanted[index])) {
    const field = actual.find((entry) => !wanted.includes(entry))
    fail(
      field === undefined ? `missing-${label}-field` : `unexpected-${label}-field`,
      field === undefined ? {} : { field },
    )
  }
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function compareText(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function fail(code, detail = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...detail } })
}
