import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { isCanonicalDecimal } from './decimal-literal.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const NAME = /^[a-z][a-z0-9_]*$/
const MODULE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/
const INT = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/
const HEX_BYTES = /^hex:(?:[0-9a-f]{2})*$/
const PRIMITIVES = new Set(['unit', 'bool', 'int', 'text.utf8', 'bytes'])
const ROUNDING_MODES = new Set([
  'exact',
  'toward_zero',
  'floor',
  'ceiling',
  'half_even',
  'half_away_from_zero',
])
const MAX_DEPTH = 128
const MAX_DECIMAL_SCALE = 255

export const TYPE_CONTRACT_SCHEMA = 're.type-declaration@0.1.0'
export const CANONICAL_VALUE_PROTOCOL = 're.canonical-value@0.1.0'
export const DECIMAL_ROUNDING_MODES = Object.freeze([...ROUNDING_MODES])

export function validateTypeDeclaration(declaration) {
  try {
    normalizeDeclaration(declaration)
    return { ok: true }
  } catch (error) {
    return rejected(error)
  }
}

export function validateTypeReference(type) {
  try {
    return {
      ok: true,
      value: normalizeType(type, new Set(), 0, false),
    }
  } catch (error) {
    return rejected(error)
  }
}

export function typeReferenceDigest(type) {
  const normalized = normalizeType(type, new Set(), 0, false)
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`
}

export function typeDeclarationDigest(declaration) {
  const normalized = normalizeDeclaration(declaration)
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`
}

export function canonicalizeValue(type, value, declarations = []) {
  try {
    const registry = declarationRegistry(declarations)
    const normalizedType = normalizeType(type, new Set(), 0, false)
    const canonical = normalizeValue(normalizedType, value, registry, 0)
    return { ok: true, value: canonical }
  } catch (error) {
    return rejected(error)
  }
}

export function canonicalValueBytes(type, value, declarations = []) {
  try {
    const registry = declarationRegistry(declarations)
    const normalizedType = normalizeType(type, new Set(), 0, false)
    const canonical = normalizeValue(normalizedType, value, registry, 0)
    return {
      bytes: `${CANONICAL_VALUE_PROTOCOL}\n${stableJson({
        type: normalizedType,
        value: canonical,
      })}\n`,
      ok: true,
    }
  } catch (error) {
    return rejected(error)
  }
}

export function isCanonicalKeyType(type, declarations = []) {
  try {
    const registry = declarationRegistry(declarations)
    return keyType(normalizeType(type, new Set(), 0, false), registry, new Set())
  } catch {
    return false
  }
}

export function validateDecimalRescale(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return rejected({ code: 'invalid-decimal-rescale' })
  }
  const unknown = Object.keys(input).find(
    (field) => !['from_scale', 'rounding', 'to_scale'].includes(field),
  )
  if (unknown !== undefined) {
    return rejected({ code: 'unexpected-decimal-rescale-field', field: unknown })
  }
  const { from_scale, rounding, to_scale } = input
  if (!scale(from_scale) || !scale(to_scale)) {
    return rejected({ code: 'invalid-decimal-scale' })
  }
  if (!ROUNDING_MODES.has(rounding)) {
    return rejected({ code: 'invalid-decimal-rounding-mode', rounding })
  }
  return { ok: true }
}

export function rescaleDecimal(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return rejected({ code: 'invalid-decimal-rescale' })
  }
  const unknown = Object.keys(input).find(
    (field) => !['from_scale', 'rounding', 'to_scale', 'value'].includes(field),
  )
  if (unknown !== undefined) {
    return rejected({ code: 'unexpected-decimal-rescale-field', field: unknown })
  }
  const contract = validateDecimalRescale({
    from_scale: input.from_scale,
    rounding: input.rounding,
    to_scale: input.to_scale,
  })
  if (!contract.ok) return contract
  try {
    const value = decimalValue(input.from_scale, input.value)
    if (input.to_scale >= input.from_scale) {
      if (input.rounding !== 'exact') {
        fail('lossless-decimal-rescale-requires-exact')
      }
      const coefficient = decimalCoefficient(value) *
        powerOfTen(input.to_scale - input.from_scale)
      return { ok: true, value: formatDecimal(coefficient, input.to_scale) }
    }

    const coefficient = decimalCoefficient(value)
    const divisor = powerOfTen(input.from_scale - input.to_scale)
    const quotient = coefficient / divisor
    const remainder = coefficient % divisor
    if (remainder === 0n) {
      return { ok: true, value: formatDecimal(quotient, input.to_scale) }
    }
    if (input.rounding === 'exact') {
      fail('inexact-decimal-rescale')
    }
    const rounded = roundDecimal(
      coefficient,
      quotient,
      remainder,
      divisor,
      input.rounding,
    )
    return { ok: true, value: formatDecimal(rounded, input.to_scale) }
  } catch (error) {
    return rejected(error)
  }
}

function normalizeDeclaration(input) {
  assertObject(input, 'invalid-type-declaration')
  exactFields(input, ['body', 'module', 'name', 'parameters', 'schema'], 'type-declaration')
  if (input.schema !== TYPE_CONTRACT_SCHEMA) fail('unsupported-type-declaration')
  if (!MODULE.test(input.module)) fail('invalid-type-module', { module: input.module })
  if (!NAME.test(input.name)) fail('invalid-type-name', { name: input.name })
  if (!Array.isArray(input.parameters)) fail('invalid-type-parameter-set')
  const parameters = input.parameters.map((parameter) => {
    if (!NAME.test(parameter)) fail('invalid-type-parameter', { parameter })
    return parameter
  })
  if (new Set(parameters).size !== parameters.length) fail('duplicate-type-parameter')
  const parameterSet = new Set(parameters)
  assertObject(input.body, 'invalid-type-body')
  let body
  if (input.body.kind === 'record') {
    exactFields(input.body, ['fields', 'kind'], 'record-type')
    body = {
      fields: normalizeNamedMembers(input.body.fields, 'field', (field) => {
        exactFields(field, ['name', 'type'], 'record-field')
        return { name: field.name, type: normalizeType(field.type, parameterSet, 0, true) }
      }),
      kind: 'record',
    }
  } else if (input.body.kind === 'sum') {
    exactFields(input.body, ['kind', 'variants'], 'sum-type')
    body = {
      kind: 'sum',
      variants: normalizeNamedMembers(input.body.variants, 'variant', (variant) => {
        exactFields(variant, ['name', 'type'], 'sum-variant', ['type'])
        return {
          name: variant.name,
          ...(variant.type === undefined
            ? {}
            : { type: normalizeType(variant.type, parameterSet, 0, true) }),
        }
      }),
    }
  } else if (input.body.kind === 'newtype') {
    exactFields(input.body, ['kind', 'type'], 'newtype')
    body = {
      kind: 'newtype',
      type: normalizeType(input.body.type, parameterSet, 0, true),
    }
  } else {
    fail('unsupported-type-body', { kind: input.body.kind })
  }
  if (!productiveBody(body)) fail('unproductive-recursive-type')
  return {
    body,
    module: input.module,
    name: input.name,
    parameters,
    schema: TYPE_CONTRACT_SCHEMA,
  }
}

function productiveBody(body) {
  if (body.kind === 'record') return body.fields.every(({ type }) => productiveType(type))
  if (body.kind === 'sum') {
    return body.variants.some(({ type }) => type === undefined || productiveType(type))
  }
  return productiveType(body.type)
}

function productiveType(type) {
  if (type.kind === 'self') return false
  if (['list', 'map', 'option', 'set'].includes(type.kind)) return true
  if (type.kind === 'result') {
    return productiveType(type.ok) || productiveType(type.error)
  }
  return true
}

function normalizeNamedMembers(input, label, normalize) {
  if (!Array.isArray(input) || input.length === 0) fail(`invalid-${label}-set`)
  const seen = new Set()
  const members = input.map((member) => {
    assertObject(member, `invalid-${label}`)
    if (!NAME.test(member.name)) fail(`invalid-${label}-name`, { name: member.name })
    if (seen.has(member.name)) fail(`duplicate-${label}`, { name: member.name })
    seen.add(member.name)
    return normalize(member)
  })
  return members.sort((left, right) => compareBytes(left.name, right.name))
}

function normalizeType(input, parameters, depth, allowSelf) {
  if (depth > MAX_DEPTH) fail('type-reference-too-deep')
  assertObject(input, 'invalid-type-reference')
  switch (input.kind) {
    case 'primitive':
      exactFields(input, ['kind', 'name'], 'primitive-type')
      if (!PRIMITIVES.has(input.name)) fail('unsupported-primitive-type', { name: input.name })
      return { kind: 'primitive', name: input.name }
    case 'decimal':
      exactFields(input, ['kind', 'scale'], 'decimal-type')
      if (!scale(input.scale)) fail('invalid-decimal-scale', { scale: input.scale })
      return { kind: 'decimal', scale: input.scale }
    case 'list':
      return unaryType(input, 'list', 'element', parameters, depth, allowSelf)
    case 'set':
      return unaryType(input, 'set', 'element', parameters, depth, allowSelf)
    case 'option':
      return unaryType(input, 'option', 'value', parameters, depth, allowSelf)
    case 'map':
      exactFields(input, ['key', 'kind', 'value'], 'map-type')
      return {
        key: normalizeType(input.key, parameters, depth + 1, allowSelf),
        kind: 'map',
        value: normalizeType(input.value, parameters, depth + 1, allowSelf),
      }
    case 'result':
      exactFields(input, ['error', 'kind', 'ok'], 'result-type')
      return {
        error: normalizeType(input.error, parameters, depth + 1, allowSelf),
        kind: 'result',
        ok: normalizeType(input.ok, parameters, depth + 1, allowSelf),
      }
    case 'parameter':
      exactFields(input, ['kind', 'name'], 'parameter-type')
      if (!parameters.has(input.name)) fail('undeclared-type-parameter', { name: input.name })
      return { kind: 'parameter', name: input.name }
    case 'self':
      exactFields(input, ['kind'], 'self-type')
      if (!allowSelf) fail('self-type-outside-declaration')
      return { kind: 'self' }
    case 'declared':
      exactFields(input, ['arguments', 'declaration_digest', 'kind'], 'declared-type')
      if (!DIGEST.test(input.declaration_digest)) fail('invalid-type-declaration-digest')
      if (!Array.isArray(input.arguments)) fail('invalid-type-argument-set')
      return {
        arguments: input.arguments.map((argument) =>
          normalizeType(argument, parameters, depth + 1, allowSelf)),
        declaration_digest: input.declaration_digest,
        kind: 'declared',
      }
    case 'resource':
      exactFields(input, ['contract_digest', 'kind', 'name'], 'resource-type')
      if (!DIGEST.test(input.contract_digest) || !NAME.test(input.name)) {
        fail('invalid-resource-type')
      }
      return {
        contract_digest: input.contract_digest,
        kind: 'resource',
        name: input.name,
      }
    default:
      fail('unsupported-type-reference', { kind: input.kind })
  }
}

function unaryType(input, kind, field, parameters, depth, allowSelf) {
  exactFields(input, [field, 'kind'], `${kind}-type`)
  return {
    [field]: normalizeType(input[field], parameters, depth + 1, allowSelf),
    kind,
  }
}

function declarationRegistry(declarations) {
  if (!Array.isArray(declarations)) fail('invalid-type-declaration-registry')
  const registry = new Map()
  for (const declaration of declarations) {
    const normalized = normalizeDeclaration(declaration)
    const digest = typeDeclarationDigest(normalized)
    if (registry.has(digest)) fail('duplicate-type-declaration-digest', { digest })
    registry.set(digest, normalized)
  }
  return registry
}

function normalizeValue(type, value, registry, depth, self = undefined) {
  if (depth > MAX_DEPTH) fail('canonical-value-too-deep')
  switch (type.kind) {
    case 'primitive': return primitiveValue(type.name, value)
    case 'decimal': return decimalValue(type.scale, value)
    case 'list':
      if (!Array.isArray(value)) fail('invalid-list-value')
      return value.map((entry) => normalizeValue(type.element, entry, registry, depth + 1, self))
    case 'option': return variantValue(
      value,
      new Map([['none', undefined], ['some', type.value]]),
      registry,
      depth,
      self,
    )
    case 'result': return variantValue(
      value,
      new Map([['err', type.error], ['ok', type.ok]]),
      registry,
      depth,
      self,
    )
    case 'map': return mapValue(type, value, registry, depth, self)
    case 'set': return setValue(type, value, registry, depth, self)
    case 'declared': return declaredValue(type, value, registry, depth)
    case 'self':
      if (self === undefined) fail('self-value-outside-declaration')
      return normalizeValue(self, value, registry, depth + 1, self)
    case 'resource': fail('resource-value-not-canonicalizable')
    case 'parameter': fail('uninstantiated-type-parameter', { name: type.name })
    default: fail('unsupported-canonical-value-type', { kind: type.kind })
  }
}

function primitiveValue(name, value) {
  if (name === 'unit') {
    if (value !== null) fail('invalid-unit-value')
    return null
  }
  if (name === 'bool') {
    if (typeof value !== 'boolean') fail('invalid-bool-value')
    return value
  }
  if (name === 'int') {
    if (typeof value !== 'string' || !INT.test(value)) fail('invalid-canonical-int')
    return value
  }
  if (name === 'text.utf8') {
    if (typeof value !== 'string' || !hasOnlyUnicodeScalars(value)) {
      fail('invalid-text-value')
    }
    return value.normalize('NFC')
  }
  if (name === 'bytes') {
    if (typeof value !== 'string' || !HEX_BYTES.test(value)) fail('invalid-canonical-bytes')
    return value
  }
  fail('unsupported-primitive-type', { name })
}

function decimalValue(decimalScale, value) {
  if (!isCanonicalDecimal(value, decimalScale)) {
    fail('invalid-canonical-decimal', { scale: decimalScale })
  }
  return value
}

function mapValue(type, value, registry, depth, self) {
  if (!keyType(type.key, registry, new Set())) fail('non-canonical-map-key-type')
  if (!Array.isArray(value)) fail('invalid-map-value')
  const entries = value.map((entry) => {
    assertObject(entry, 'invalid-map-entry')
    exactFields(entry, ['key', 'value'], 'map-entry')
    const key = normalizeValue(type.key, entry.key, registry, depth + 1, self)
    return {
      key,
      order: keyOrder(type.key, key, registry),
      value: normalizeValue(type.value, entry.value, registry, depth + 1, self),
    }
  }).sort((left, right) => compareOrder(left.order, right.order))
  for (let index = 1; index < entries.length; index += 1) {
    if (compareOrder(entries[index - 1].order, entries[index].order) === 0) {
      fail('duplicate-canonical-map-key')
    }
  }
  return entries.map(({ key, value: entryValue }) => ({ key, value: entryValue }))
}

function setValue(type, value, registry, depth, self) {
  if (!keyType(type.element, registry, new Set())) fail('non-canonical-set-element-type')
  if (!Array.isArray(value)) fail('invalid-set-value')
  const entries = value.map((entry) => {
    const normalized = normalizeValue(type.element, entry, registry, depth + 1, self)
    return { order: keyOrder(type.element, normalized, registry), value: normalized }
  }).sort((left, right) => compareOrder(left.order, right.order))
  for (let index = 1; index < entries.length; index += 1) {
    if (compareOrder(entries[index - 1].order, entries[index].order) === 0) {
      fail('duplicate-canonical-set-element')
    }
  }
  return entries.map(({ value: entryValue }) => entryValue)
}

function declaredValue(type, value, registry, depth) {
  const declaration = registry.get(type.declaration_digest)
  if (declaration === undefined) fail('type-declaration-not-found')
  if (type.arguments.length !== declaration.parameters.length) {
    fail('type-argument-arity-mismatch')
  }
  const substitutions = new Map(declaration.parameters.map(
    (parameter, index) => [parameter, type.arguments[index]],
  ))
  const body = declaration.body
  const self = type
  if (body.kind === 'newtype') {
    return normalizeValue(substitute(body.type, substitutions), value, registry, depth + 1, self)
  }
  if (body.kind === 'record') {
    assertObject(value, 'invalid-record-value')
    const fields = body.fields.map(({ name, type: fieldType }) => {
      if (!Object.hasOwn(value, name)) fail('missing-record-field', { name })
      return [name, normalizeValue(
        substitute(fieldType, substitutions), value[name], registry, depth + 1, self,
      )]
    })
    const allowed = new Set(body.fields.map(({ name }) => name))
    for (const name of Object.keys(value)) {
      if (!allowed.has(name)) fail('unexpected-record-field', { name })
    }
    return Object.fromEntries(fields)
  }
  const variants = new Map(body.variants.map(({ name, type: variantType }) => [
    name,
    variantType === undefined ? undefined : substitute(variantType, substitutions),
  ]))
  return variantValue(value, variants, registry, depth, self)
}

function variantValue(value, variants, registry, depth, self) {
  assertObject(value, 'invalid-sum-value')
  if (typeof value.variant !== 'string' || !variants.has(value.variant)) {
    fail('unknown-sum-variant', { variant: value.variant })
  }
  const type = variants.get(value.variant)
  if (type === undefined) {
    exactFields(value, ['variant'], 'unit-sum-value')
    return { variant: value.variant }
  }
  exactFields(value, ['value', 'variant'], 'payload-sum-value')
  return {
    value: normalizeValue(type, value.value, registry, depth + 1, self),
    variant: value.variant,
  }
}

function substitute(type, substitutions) {
  if (type.kind === 'parameter') return substitutions.get(type.name)
  if (type.kind === 'list' || type.kind === 'set') {
    return { element: substitute(type.element, substitutions), kind: type.kind }
  }
  if (type.kind === 'option') {
    return { kind: 'option', value: substitute(type.value, substitutions) }
  }
  if (type.kind === 'map') {
    return {
      key: substitute(type.key, substitutions),
      kind: 'map',
      value: substitute(type.value, substitutions),
    }
  }
  if (type.kind === 'result') {
    return {
      error: substitute(type.error, substitutions),
      kind: 'result',
      ok: substitute(type.ok, substitutions),
    }
  }
  if (type.kind === 'declared') {
    return { ...type, arguments: type.arguments.map((entry) => substitute(entry, substitutions)) }
  }
  return type
}

function keyType(type, registry, seen) {
  if (type.kind === 'primitive') {
    return ['bool', 'int', 'text.utf8', 'bytes'].includes(type.name)
  }
  if (type.kind === 'decimal') return true
  if (type.kind !== 'declared' || seen.has(type.declaration_digest)) return false
  const declaration = registry.get(type.declaration_digest)
  if (declaration === undefined || declaration.body.kind !== 'newtype') return false
  if (type.arguments.length !== declaration.parameters.length) return false
  seen.add(type.declaration_digest)
  const substitutions = new Map(declaration.parameters.map(
    (parameter, index) => [parameter, type.arguments[index]],
  ))
  return keyType(substitute(declaration.body.type, substitutions), registry, seen)
}

function keyOrder(type, value, registry) {
  if (type.kind === 'primitive') {
    if (type.name === 'bool') return { kind: 'bool', value: value ? 1 : 0 }
    if (type.name === 'int') return { kind: 'numeric', value: BigInt(value) }
    if (type.name === 'text.utf8') return { kind: 'bytes', value: Buffer.from(value, 'utf8') }
    if (type.name === 'bytes') return {
      kind: 'bytes',
      value: Buffer.from(value.slice(4), 'hex'),
    }
  }
  if (type.kind === 'decimal') {
    return { kind: 'numeric', value: decimalCoefficient(value) }
  }
  if (type.kind === 'declared') {
    const declaration = registry.get(type.declaration_digest)
    const substitutions = new Map(declaration.parameters.map(
      (parameter, index) => [parameter, type.arguments[index]],
    ))
    return keyOrder(substitute(declaration.body.type, substitutions), value, registry)
  }
  fail('non-canonical-key-type')
}

function decimalCoefficient(value) {
  return BigInt(value.replace('.', ''))
}

function powerOfTen(exponent) {
  return 10n ** BigInt(exponent)
}

function roundDecimal(coefficient, quotient, remainder, divisor, mode) {
  const away = coefficient < 0n ? -1n : 1n
  if (mode === 'toward_zero') return quotient
  if (mode === 'floor') return coefficient < 0n ? quotient - 1n : quotient
  if (mode === 'ceiling') return coefficient > 0n ? quotient + 1n : quotient
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n
  if (doubled < divisor) return quotient
  if (doubled > divisor) return quotient + away
  if (mode === 'half_away_from_zero') return quotient + away
  if (mode === 'half_even') return quotient % 2n === 0n ? quotient : quotient + away
  fail('invalid-decimal-rounding-mode', { rounding: mode })
}

function formatDecimal(coefficient, decimalScale) {
  const negative = coefficient < 0n
  const digits = (negative ? -coefficient : coefficient).toString()
  if (decimalScale === 0) return `${negative ? '-' : ''}${digits}`
  const padded = digits.padStart(decimalScale + 1, '0')
  const split = padded.length - decimalScale
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`
}

function hasOnlyUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function compareOrder(left, right) {
  if (left.kind !== right.kind) fail('incomparable-canonical-keys')
  if (left.kind === 'numeric' || left.kind === 'bool') {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0
  }
  return Buffer.compare(left.value, right.value)
}

function scale(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_DECIMAL_SCALE
}

function exactFields(value, allowed, label, optional = []) {
  const keys = Object.keys(value)
  for (const key of keys) {
    if (!allowed.includes(key)) fail(`unexpected-${label}-field`, { field: key })
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !Object.hasOwn(value, key)) {
      fail(`missing-${label}-field`, { field: key })
    }
  }
}

function assertObject(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareBytes).map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}

function rejected(error) {
  const diagnostic = error?.diagnostic ?? error
  return { diagnostics: [diagnostic], ok: false }
}
