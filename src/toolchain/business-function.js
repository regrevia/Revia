import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { lowerControlFlow } from './control-flow-contract.js'
import { validateTypeReference } from './type-contract.js'

const SCHEMA = 're.function-declaration@0.1.0'
const NAME = /^[a-z][a-z0-9_]*$/u
const MODULE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u
const REFERENCE = /^[a-z][a-z0-9_.-]*@[0-9]+\.[0-9]+\.[0-9]+$/u
const UID = /^[a-z2-7]{25}[aeimquy4]$/u

export function validateBusinessFunction(input) {
  try {
    const value = normalizeFunction(input)
    return { ok: true, value }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'malformed-function-declaration' }],
      ok: false,
    }
  }
}

export function businessFunctionDigest(input) {
  return digest(normalizeFunction(input))
}

function normalizeFunction(input) {
  assertObject(input, 'invalid-function-declaration')
  exactFields(input, [
    'body', 'error_type', 'input_type', 'module', 'name', 'output_type', 'schema',
  ], 'function-declaration')
  if (input.schema !== SCHEMA) fail('unsupported-function-declaration')
  if (!MODULE.test(input.module) || !NAME.test(input.name)) {
    fail('invalid-function-identity')
  }
  const inputType = typeReference(input.input_type, 'input')
  const outputType = typeReference(input.output_type, 'output')
  const errorType = typeReference(input.error_type, 'error')
  assertObject(input.body, 'invalid-function-body')
  exactFields(input.body, [
    'calls', 'capability_calls', 'control_flow', 'effect_edges',
  ], 'function-body')
  const calls = unique(input.body.calls, 'function-call', MODULE)
  const capabilityCalls = normalizeCapabilityCalls(input.body.capability_calls)
  const effectEdges = normalizeEffectEdges(input.body.effect_edges, capabilityCalls)
  const lowered = lowerControlFlow(input.body.control_flow)
  if (!lowered.ok) {
    fail('invalid-function-control-flow', {
      control_flow_diagnostics: lowered.diagnostics,
    })
  }
  return {
    body: {
      calls,
      capability_calls: capabilityCalls,
      control_flow: lowered.graph,
      effect_edges: effectEdges,
    },
    error_type: errorType,
    input_type: inputType,
    module: input.module,
    name: input.name,
    output_type: outputType,
    schema: SCHEMA,
  }
}

function normalizeCapabilityCalls(input) {
  if (!Array.isArray(input)) fail('invalid-function-capability-call-set')
  const seen = new Set()
  return input.map((entry) => {
    assertObject(entry, 'invalid-function-capability-call')
    exactFields(entry, [
      'capability', 'error_type', 'id', 'input_type', 'node_uid',
      'output_type', 'resource',
    ], 'function-capability-call')
    if (!NAME.test(entry.id) || seen.has(entry.id) || !UID.test(entry.node_uid)) {
      fail(seen.has(entry.id)
        ? 'duplicate-function-capability-call'
        : 'invalid-function-capability-call')
    }
    seen.add(entry.id)
    assertObject(entry.capability, 'invalid-function-capability')
    exactFields(entry.capability, ['instance', 'member', 'reference'], 'function-capability')
    if (typeof entry.capability.instance !== 'string'
      || !entry.capability.instance.startsWith('@')
      || !NAME.test(entry.capability.member)
      || !REFERENCE.test(entry.capability.reference)) {
      fail('invalid-function-capability')
    }
    assertObject(entry.resource, 'invalid-function-resource')
    exactFields(entry.resource, ['access', 'constructor'], 'function-resource')
    if (!['read', 'write'].includes(entry.resource.access)
      || typeof entry.resource.constructor !== 'string'
      || !/^[a-z][a-z0-9_.-]*$/u.test(entry.resource.constructor)) {
      fail('invalid-function-resource')
    }
    return {
      capability: structuredClone(entry.capability),
      error_type: typeReference(entry.error_type, 'capability-error'),
      id: entry.id,
      input_type: typeReference(entry.input_type, 'capability-input'),
      node_uid: entry.node_uid,
      output_type: typeReference(entry.output_type, 'capability-output'),
      resource: structuredClone(entry.resource),
    }
  }).sort((left, right) => compareText(left.id, right.id))
}

function normalizeEffectEdges(input, capabilityCalls) {
  if (!Array.isArray(input)) fail('invalid-function-effect-edge-set')
  const calls = new Map(capabilityCalls.map((entry) => [entry.id, entry]))
  const seen = new Set()
  const edges = input.map((edge) => {
    assertObject(edge, 'invalid-function-effect-edge')
    exactFields(edge, ['access', 'call', 'from', 'resource', 'to'], 'function-effect-edge')
    if (!NAME.test(edge.call) || typeof edge.from !== 'string' || edge.from.length === 0
      || typeof edge.to !== 'string' || edge.to.length === 0) {
      fail('invalid-function-effect-edge')
    }
    const call = calls.get(edge.call)
    if (call === undefined
      || edge.resource !== call.resource.constructor
      || edge.access !== call.resource.access
      || edge.to !== edge.call) {
      fail('function-effect-edge-mismatch', { call: edge.call })
    }
    if (seen.has(edge.call)) fail('duplicate-function-effect-edge', { call: edge.call })
    seen.add(edge.call)
    return structuredClone(edge)
  }).sort((left, right) => compareText(left.call, right.call))
  for (const call of capabilityCalls) {
    if (!seen.has(call.id)) fail('function-capability-call-missing-effect-edge', {
      call: call.id,
    })
  }
  return edges
}

function typeReference(input, label) {
  const result = validateTypeReference(input)
  if (!result.ok) fail(`invalid-function-${label}-type`, {
    type_diagnostics: result.diagnostics,
  })
  return result.value
}

function unique(input, label, pattern) {
  if (!Array.isArray(input)) fail(`invalid-${label}-set`)
  const values = [...input]
  if (values.some((value) => typeof value !== 'string' || !pattern.test(value))) {
    fail(`invalid-${label}`)
  }
  if (new Set(values).size !== values.length) fail(`duplicate-${label}`)
  return values.sort(compareText)
}

function exactFields(input, expected, label) {
  const actual = Object.keys(input).sort(compareText)
  const wanted = [...expected].sort(compareText)
  if (actual.length !== wanted.length
    || actual.some((field, index) => field !== wanted[index])) {
    const field = actual.find((entry) => !wanted.includes(entry))
    fail(field === undefined ? `missing-${label}-field` : `unexpected-${label}-field`,
      field === undefined ? {} : { field })
  }
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
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
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
