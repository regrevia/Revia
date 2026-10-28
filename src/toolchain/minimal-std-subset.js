import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  MINIMAL_STD_ABI_MODULES,
  minimalStdPackageDigest,
  minimalStdPackageManifest,
} from './minimal-std-abi.js'

export const MINIMAL_STD_OPERATION_RECEIPT_SCHEMA =
  're.minimal-std-operation-receipt@0.1.0'
export const MINIMAL_STD_INVOCATION_SCHEMA =
  're.minimal-std-invocation@0.1.0'
export const MINIMAL_STD_INVOCATION_MANIFEST_SCHEMA =
  're.minimal-std-invocation-manifest@0.1.0'
export const MINIMAL_STD_TRANSLATION_SCHEMA =
  're.minimal-std-translation@0.1.0'
export const MINIMAL_STD_PARAMETER_WITNESS_SCHEMA =
  're.minimal-std-parameter-witness@0.1.0'
export const MINIMAL_STD_CAPABILITY_MANIFEST_SCHEMA =
  're.minimal-std-capability-manifest@0.1.0'
export const MINIMAL_STD_RUNTIME_PACKAGE_SCHEMA =
  're.minimal-std-runtime-package@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const HEX = /^[0-9a-f]*$/u
const RUNTIME_IMPLEMENTATION = 're.minimal-std-subset@0.1.0'
const INVOCATION_FIELDS = [
  'graph_revision',
  'operation',
  'package_manifest',
  'parameters',
  'schema',
  'type_arguments',
]
const OPERATION_BY_NAME = new Map(
  MINIMAL_STD_ABI_MODULES.flatMap(({ operations }) => operations)
    .map((operation) => [`${operation.module}.${operation.name}`, operation]),
)
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set

export function checkMinimalStdInvocation(input) {
  const validated = validateInvocation(input)
  if (!validated.ok) return validated
  const { contract, request } = validated.value
  return {
    ok: true,
    value: {
      graph_revision: request.graph_revision,
      ...invocationAuthority(validated.value),
      module: contract.module,
      operation: request.operation,
      schema: 're.minimal-std-checked-invocation@0.1.0',
      type_arguments: [...request.type_arguments],
    },
  }
}

export function manifestMinimalStdInvocation(input) {
  const checked = checkMinimalStdInvocation(input)
  if (!checked.ok) return checked
  return {
    ok: true,
    value: {
      ...checked.value,
      schema: MINIMAL_STD_INVOCATION_MANIFEST_SCHEMA,
    },
  }
}

export function translateMinimalStdInvocation(input) {
  const manifest = manifestMinimalStdInvocation(input)
  if (!manifest.ok) return manifest
  const content = {
    capability_digest: manifest.value.capability_digest,
    graph_revision: manifest.value.graph_revision,
    invocation_digest: manifest.value.invocation_digest,
    module: manifest.value.module,
    operation: manifest.value.operation,
    package_digest: manifest.value.package_digest,
    parameter_witness: manifest.value.parameter_witness,
    parameter_witness_digest: manifest.value.parameter_witness_digest,
    runtime_package_digest: manifest.value.runtime_package_digest,
    schema: MINIMAL_STD_TRANSLATION_SCHEMA,
    type_arguments: manifest.value.type_arguments,
  }
  return {
    ok: true,
    value: {
      ...content,
      artifact_digest: digest(content),
    },
  }
}

export function executeMinimalStdOperation(input) {
  const validated = validateInvocation(input)
  if (!validated.ok) return validated
  const { request } = validated.value
  const {
    graph_revision,
    operation,
    parameters,
  } = request
  try {
    const content = {
      ...invocationAuthority(validated.value),
      graph_revision,
      operation,
      outcome: snapshot(execute(operation, parameters)),
      schema: MINIMAL_STD_OPERATION_RECEIPT_SCHEMA,
    }
    return {
      ok: true,
      value: {
        ...content,
        receipt_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-subset-execution-failed')
  }
}

function validateInvocation(input) {
  let fields
  try {
    fields = dataRecord(
      input,
      INVOCATION_FIELDS,
      'minimal-std-subset-invocation-fields-mismatch',
    )
  } catch (error) {
    return rejected(error.code)
  }
  const {
    graph_revision,
    operation,
    package_manifest,
    parameters,
    schema,
    type_arguments,
  } = fields
  if (schema !== MINIMAL_STD_INVOCATION_SCHEMA) {
    return rejected('minimal-std-subset-invocation-schema-mismatch')
  }
  const contract = OPERATION_BY_NAME.get(operation)
  if (contract === undefined) return rejected('minimal-std-subset-operation-unknown')
  if (!DIGEST.test(graph_revision)) {
    return rejected('minimal-std-subset-graph-revision-mismatch')
  }
  let packageManifest
  try {
    packageManifest = snapshot(package_manifest)
  } catch {
    return rejected('minimal-std-subset-package-authority-mismatch')
  }
  if (!canonicalEqual(packageManifest, minimalStdPackageManifest())) {
    return rejected('minimal-std-subset-package-authority-mismatch')
  }
  let typeArguments
  try {
    typeArguments = arrayValues(type_arguments).map((entry) => text(entry))
  } catch {
    return rejected('minimal-std-subset-type-arguments-mismatch')
  }
  if (!validTypeArguments(typeArguments, contract.type_parameters.length)) {
    return rejected('minimal-std-subset-type-arguments-mismatch')
  }
  try {
    const parameterWitness = createParameterWitness(parameters, contract)
    const materializedParameters = parametersFromWitness(
      parameterWitness,
      contract,
    )
    execute(operation, materializedParameters)
    return {
      ok: true,
      value: {
        contract,
        parameterWitness,
        request: {
          graph_revision,
          operation,
          package_manifest: packageManifest,
          parameters: materializedParameters,
          schema,
          type_arguments: typeArguments,
        },
      },
    }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-subset-parameter-witness-invalid')
  }
}

function invocationAuthority({ parameterWitness, request }) {
  const capabilityDigest = minimalStdCapabilityDigest()
  const runtimePackageDigest = minimalStdRuntimePackageDigest()
  const parameterWitnessDigest = digest(parameterWitness)
  const invocationDigest = digest({
    capability_digest: capabilityDigest,
    graph_revision: request.graph_revision,
    operation: request.operation,
    package_digest: minimalStdPackageDigest(),
    parameter_witness: parameterWitness,
    runtime_package_digest: runtimePackageDigest,
    schema: request.schema,
    type_arguments: request.type_arguments,
  })
  return {
    capability_digest: capabilityDigest,
    invocation_digest: invocationDigest,
    package_digest: minimalStdPackageDigest(),
    parameter_witness: snapshot(parameterWitness),
    parameter_witness_digest: parameterWitnessDigest,
    runtime_package_digest: runtimePackageDigest,
  }
}

export function minimalStdCapabilityManifest() {
  return {
    capabilities: [],
    package_digest: minimalStdPackageDigest(),
    schema: MINIMAL_STD_CAPABILITY_MANIFEST_SCHEMA,
  }
}

export function minimalStdCapabilityDigest() {
  return digest(minimalStdCapabilityManifest())
}

export function minimalStdRuntimePackageManifest() {
  return {
    abi_package_digest: minimalStdPackageDigest(),
    capability_digest: minimalStdCapabilityDigest(),
    implementation: RUNTIME_IMPLEMENTATION,
    modules: [...new Set(MINIMAL_STD_ABI_MODULES.map(({ module }) => module))].sort(),
    schema: MINIMAL_STD_RUNTIME_PACKAGE_SCHEMA,
  }
}

export function minimalStdRuntimePackageDigest() {
  return digest(minimalStdRuntimePackageManifest())
}

export function replayMinimalStdTranslation(translation, { checked } = {}) {
  try {
    if (!exactShape(translation, [
      'artifact_digest',
      'capability_digest',
      'graph_revision',
      'invocation_digest',
      'module',
      'operation',
      'package_digest',
      'parameter_witness',
      'parameter_witness_digest',
      'runtime_package_digest',
      'schema',
      'type_arguments',
    ])) {
      return rejected('minimal-std-subset-translation-fields-mismatch')
    }
    const { artifact_digest: ignored, ...content } = translation
    if (translation.schema !== MINIMAL_STD_TRANSLATION_SCHEMA
      || translation.artifact_digest !== digest(content)) {
      return rejected('minimal-std-subset-translation-digest-mismatch')
    }
    if (!plainObject(checked)
      || !sameReplayAuthority(translation, checked)) {
      return rejected('minimal-std-subset-replay-authority-mismatch')
    }
    const contract = OPERATION_BY_NAME.get(translation.operation)
    if (contract === undefined) {
      return rejected('minimal-std-subset-operation-unknown')
    }
    const parameters = parametersFromWitness(
      translation.parameter_witness,
      contract,
    )
    const replayed = executeMinimalStdOperation({
      graph_revision: translation.graph_revision,
      operation: translation.operation,
      package_manifest: minimalStdPackageManifest(),
      parameters,
      schema: MINIMAL_STD_INVOCATION_SCHEMA,
      type_arguments: translation.type_arguments,
    })
    if (!replayed.ok
      || replayed.value.invocation_digest !== checked.invocation_digest) {
      return rejected('minimal-std-subset-replay-authority-mismatch')
    }
    return replayed
  } catch {
    return rejected('minimal-std-subset-replay-invalid')
  }
}

function sameReplayAuthority(translation, checked) {
  return [
    'capability_digest',
    'graph_revision',
    'invocation_digest',
    'module',
    'operation',
    'package_digest',
    'parameter_witness',
    'parameter_witness_digest',
    'runtime_package_digest',
    'type_arguments',
  ].every((field) => canonicalEqual(translation[field], checked[field]))
}

function createParameterWitness(parameters, contract) {
  const names = contract.parameters.map(({ name }) => name).sort()
  const entries = dataEntries(
    parameters,
    'minimal-std-subset-parameter-witness-invalid',
  )
  if (entries.length !== names.length
    || entries.some(([name], index) => name !== names[index])) {
    throw coded('minimal-std-subset-parameters-mismatch')
  }
  const values = Object.fromEntries(entries)
  return {
    parameters: names.map((name) => ({
      name,
      value: witnessValue(values[name]),
    })),
    schema: MINIMAL_STD_PARAMETER_WITNESS_SCHEMA,
  }
}

function parametersFromWitness(witness, contract) {
  if (!exactShape(witness, ['parameters', 'schema'])
    || witness.schema !== MINIMAL_STD_PARAMETER_WITNESS_SCHEMA) {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
  const expected = contract.parameters.map(({ name }) => name).sort()
  const entries = arrayValues(witness.parameters)
  if (entries.length !== expected.length) {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
  const parameters = {}
  for (let index = 0; index < entries.length; index += 1) {
    const entry = dataRecord(entries[index], ['name', 'value'])
    if (entry.name !== expected[index]) {
      throw coded('minimal-std-subset-parameter-witness-invalid')
    }
    parameters[entry.name] = valueFromWitness(entry.value)
  }
  return parameters
}

function witnessValue(value) {
  if (utilTypes.isProxy(value)) {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
  if (value instanceof Uint8Array) {
    return {
      encoding: 'hex',
      kind: 'bytes',
      value: [...copyBytes(value)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    }
  }
  if (Array.isArray(value)) {
    return {
      items: arrayValues(value).map(witnessValue),
      kind: 'list',
    }
  }
  if (plainObject(value)) {
    const entries = dataEntries(
      value,
      'minimal-std-subset-parameter-witness-invalid',
    )
    return {
      fields: entries.map(([name, child]) => ({
        name,
        value: witnessValue(child),
      })),
      kind: 'record',
    }
  }
  if (value === null) return { kind: 'null' }
  if (typeof value === 'boolean') return { kind: 'bool', value }
  if (typeof value === 'string') return { kind: 'text', value: text(value) }
  throw coded('minimal-std-subset-argument-type-mismatch')
}

function valueFromWitness(witness) {
  if (!plainObject(witness) || typeof witness.kind !== 'string') {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
  switch (witness.kind) {
    case 'bool':
      if (!exactShape(witness, ['kind', 'value'])
        || typeof witness.value !== 'boolean') break
      return witness.value
    case 'bytes':
      if (!exactShape(witness, ['encoding', 'kind', 'value'])
        || witness.encoding !== 'hex'
        || typeof witness.value !== 'string'
        || witness.value.length % 2 !== 0
        || !HEX.test(witness.value)) break
      return Uint8Array.from(
        witness.value.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
      )
    case 'list':
      if (!exactShape(witness, ['items', 'kind'])) break
      return arrayValues(witness.items).map(valueFromWitness)
    case 'null':
      if (!exactShape(witness, ['kind'])) break
      return null
    case 'record': {
      if (!exactShape(witness, ['fields', 'kind'])) break
      const entries = arrayValues(witness.fields)
      const result = {}
      let previous = null
      for (const item of entries) {
        const entry = dataRecord(item, ['name', 'value'])
        if (typeof entry.name !== 'string'
          || (previous !== null && previous >= entry.name)) {
          throw coded('minimal-std-subset-parameter-witness-invalid')
        }
        result[entry.name] = valueFromWitness(entry.value)
        previous = entry.name
      }
      return result
    }
    case 'text':
      if (!exactShape(witness, ['kind', 'value'])) break
      return text(witness.value)
    default:
      break
  }
  throw coded('minimal-std-subset-parameter-witness-invalid')
}

function copyBytes(value) {
  if (utilTypes.isProxy(value) || !(value instanceof Uint8Array)) {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
  try {
    const output = new Uint8Array(
      Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []),
    )
    Reflect.apply(TYPED_ARRAY_SET, output, [value])
    return output
  } catch {
    throw coded('minimal-std-subset-parameter-witness-invalid')
  }
}

export function minimalStdOperationContract(operation) {
  const contract = OPERATION_BY_NAME.get(operation)
  return contract === undefined ? null : structuredClone(contract)
}

export function minimalStdPackageIdentityForGraph(graph) {
  try {
    if (!plainObject(graph) || !Array.isArray(graph.functions)) {
      return rejected('minimal-std-subset-graph-invalid')
    }
    const modules = new Set()
    for (const function_ of graph.functions) {
      for (const call of callsOf(function_)) {
        if (call?.target?.kind !== 'pure-operation'
          || !String(call.target.operation).startsWith('std.')) continue
        const contract = OPERATION_BY_NAME.get(call.target.operation)
        if (contract === undefined
          || call.target.schemaReference !== `${call.target.operation}@0.1.0`) {
          return rejected('minimal-std-subset-graph-operation-mismatch')
        }
        modules.add(contract.module)
      }
    }
    return {
      ok: true,
      value: {
        capability_digest: minimalStdCapabilityDigest(),
        modules: [...modules].sort(),
        package_digest: minimalStdPackageDigest(),
        package_manifest: minimalStdPackageManifest(),
        runtime_package_digest: minimalStdRuntimePackageDigest(),
      },
    }
  } catch {
    return rejected('minimal-std-subset-graph-invalid')
  }
}

function execute(operation, parameters) {
  switch (operation) {
    case 'std.bytes.byte_count':
      return canonicalInt(bytes(parameters.value).length)
    case 'std.bytes.concat':
      return concatBytes(bytes(parameters.left), bytes(parameters.right))
    case 'std.bytes.decode_utf8':
      return decodeUtf8(bytes(parameters.value))
    case 'std.list.append':
      return [...list(parameters.values), snapshot(parameters.value)]
    case 'std.list.concat':
      return [...list(parameters.left), ...list(parameters.right)]
    case 'std.list.length':
      return canonicalInt(list(parameters.values).length)
    case 'std.result.is_err':
      return result(parameters.value).kind === 'err'
    case 'std.result.is_ok':
      return result(parameters.value).kind === 'ok'
    case 'std.text.concat':
      return text(parameters.left) + text(parameters.right)
    case 'std.text.encode_utf8':
      return new TextEncoder().encode(text(parameters.value))
    case 'std.text.scalar_count':
      return canonicalInt(Array.from(text(parameters.value)).length)
    default:
      throw coded('minimal-std-subset-operation-unknown')
  }
}

function bytes(value) {
  try {
    return copyBytes(value)
  } catch {
    throw coded('minimal-std-subset-argument-type-mismatch')
  }
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length)
  output.set(left)
  output.set(right, left.length)
  return output
}

function decodeUtf8(value) {
  try {
    return {
      kind: 'ok',
      value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value),
    }
  } catch {
    return {
      error: {
        type: 'std.bytes.decode_error',
        variant: 'invalid_utf8',
      },
      kind: 'err',
    }
  }
}

function list(value) {
  if (!Array.isArray(value)) throw coded('minimal-std-subset-argument-type-mismatch')
  return value.map(snapshot)
}

function result(value) {
  if (!plainObject(value)
    || (value.kind === 'ok' && !exactShape(value, ['kind', 'value']))
    || (value.kind === 'err' && !exactShape(value, ['error', 'kind']))
    || !['err', 'ok'].includes(value.kind)) {
    throw coded('minimal-std-subset-argument-type-mismatch')
  }
  return snapshot(value)
}

function text(value) {
  if (typeof value !== 'string' || value !== value.toWellFormed()) {
    throw coded('minimal-std-subset-argument-type-mismatch')
  }
  return value
}

function canonicalInt(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw coded('minimal-std-subset-integer-out-of-range')
  }
  return String(value)
}

function validTypeArguments(value, count) {
  return Array.isArray(value)
    && value.length === count
    && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

function callsOf(function_) {
  const calls = []
  for (const statement of function_?.statements ?? []) {
    if (statement?.kind === 'let') calls.push(statement.value)
    if (statement?.kind === 'return') {
      for (const branch of statement.value?.branches ?? []) calls.push(branch.value)
    }
  }
  return calls
}

function snapshot(value) {
  if (utilTypes.isProxy(value)) {
    throw coded('minimal-std-subset-argument-type-mismatch')
  }
  if (value instanceof Uint8Array) return copyBytes(value)
  if (Array.isArray(value)) return arrayValues(value).map(snapshot)
  if (plainObject(value)) {
    return Object.fromEntries(dataEntries(value).map(
      ([key, child]) => [key, snapshot(child)],
    ))
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return text(value)
  throw coded('minimal-std-subset-argument-type-mismatch')
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (value instanceof Uint8Array) {
    return JSON.stringify({
      bytes: [...copyBytes(value)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      encoding: 'hex',
    })
  }
  if (Array.isArray(value)) {
    return `[${arrayValues(value).map(canonicalJson).join(',')}]`
  }
  if (plainObject(value)) {
    return `{${dataEntries(value).map(
      ([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
}

function plainObject(value) {
  if (value === null
    || typeof value !== 'object'
    || utilTypes.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactShape(value, fields) {
  try {
    dataRecord(value, fields)
    return true
  } catch {
    return false
  }
}

function dataRecord(
  value,
  expectedFields,
  code = 'minimal-std-subset-parameter-witness-invalid',
) {
  if (!plainObject(value)) throw coded(code)
  const entries = dataEntries(value, code)
  const expected = [...expectedFields].sort()
  if (entries.length !== expected.length
    || entries.some(([name], index) => name !== expected[index])) {
    throw coded(code)
  }
  return Object.fromEntries(entries)
}

function dataEntries(
  value,
  code = 'minimal-std-subset-argument-type-mismatch',
) {
  if (!plainObject(value)) throw coded(code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string')) throw coded(code)
  return keys.sort().map((key) => {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw coded(code)
    }
    return [key, descriptor.value]
  })
}

function arrayValues(
  value,
  code = 'minimal-std-subset-parameter-witness-invalid',
) {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) throw coded(code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const lengthDescriptor = descriptors.length
  if (keys.some((key) => typeof key !== 'string')
    || !Object.hasOwn(lengthDescriptor ?? {}, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || keys.length !== lengthDescriptor.value + 1) {
    throw coded(code)
  }
  const result = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')) {
      throw coded(code)
    }
    result.push(descriptor.value)
  }
  return result
}

function coded(code) {
  return Object.assign(new TypeError(code), { code })
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
