import { createHash } from 'node:crypto'

import {
  minimalStdPackageDigest,
  minimalStdPackageManifest,
} from './minimal-std-abi.js'
import {
  checkMinimalStdInvocation,
  executeMinimalStdOperation,
  minimalStdCapabilityDigest,
  minimalStdRuntimePackageDigest,
  translateMinimalStdInvocation,
} from './minimal-std-subset.js'

export const PORTABLE_VM_STD_PROFILE = 're.portable-vm-std@0.1.0'
export const PORTABLE_VM_STD_REQUEST_SCHEMA =
  're.portable-vm-std-request@0.1.0'
export const PORTABLE_VM_STD_RESULT_SCHEMA =
  're.portable-vm-std-result@0.1.0'
export const PORTABLE_VM_STD_CONFORMANCE_SCHEMA =
  're.portable-vm-std-conformance@0.1.0'

const ADMISSIONS = new WeakMap()
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REQUEST_FIELDS = [
  'checked',
  'invocation',
  'receipt',
  'request_digest',
  'schema',
  'translation',
]
const GRAPH_REVISION = `sha256:${'1'.repeat(64)}`
const CASES = [
  ['std.bytes.byte_count', { value: bytes(1, 2) }, []],
  ['std.bytes.concat', { left: bytes(1), right: bytes(2) }, []],
  ['std.bytes.decode_utf8', { value: bytes(0x61) }, []],
  ['std.bytes.decode_utf8', { value: bytes(0xc3, 0x28) }, []],
  ['std.list.append', { value: 'b', values: ['a'] }, ['text.utf8']],
  ['std.list.concat', { left: ['a'], right: ['b'] }, ['text.utf8']],
  ['std.list.length', { values: ['a'] }, ['text.utf8']],
  ['std.result.is_err', { value: { error: 'x', kind: 'err' } }, ['text.utf8', 'text.utf8']],
  ['std.result.is_ok', { value: { kind: 'ok', value: 'x' } }, ['text.utf8', 'text.utf8']],
  ['std.text.concat', { left: 'a', right: 'b' }, []],
  ['std.text.encode_utf8', { value: 'a' }, []],
  ['std.text.scalar_count', { value: 'a😀' }, []],
]

export function createPortableVmStdRequest({
  checked,
  invocation,
  receipt,
  translation,
} = {}) {
  const content = {
    checked: snapshot(checked),
    invocation: snapshot(invocation),
    receipt: snapshot(receipt),
    schema: PORTABLE_VM_STD_REQUEST_SCHEMA,
    translation: snapshot(translation),
  }
  return {
    ...content,
    request_digest: digest(content),
  }
}

export function portableVmStdRequestDigest(request) {
  const {
    request_digest: ignored,
    ...content
  } = request
  return digest(content)
}

export function admitPortableVmStd({ request, trustedInvocation } = {}) {
  if (!exactShape(request, REQUEST_FIELDS)
    || request.schema !== PORTABLE_VM_STD_REQUEST_SCHEMA
    || !DIGEST.test(request.request_digest)
    || request.request_digest !== portableVmStdRequestDigest(request)) {
    return rejected('portable-vm-std-request-invalid')
  }
  const rebuiltChecked = checkMinimalStdInvocation(trustedInvocation)
  const rebuiltTranslation = translateMinimalStdInvocation(trustedInvocation)
  const rebuiltReceipt = executeMinimalStdOperation(trustedInvocation)
  if (!rebuiltChecked.ok
    || !rebuiltTranslation.ok
    || !rebuiltReceipt.ok
    || !canonicalEqual(request.invocation, trustedInvocation)
    || !canonicalEqual(request.checked, rebuiltChecked.value)
    || !canonicalEqual(request.translation, rebuiltTranslation.value)
    || !canonicalEqual(request.receipt, rebuiltReceipt.value)) {
    return rejected('portable-vm-std-authority-mismatch')
  }
  const admission = Object.freeze(Object.create(null))
  ADMISSIONS.set(admission, snapshot({
    receipt: rebuiltReceipt.value,
    request_digest: request.request_digest,
  }))
  return { ok: true, value: admission }
}

export function executePortableVmStd({ admission } = {}) {
  const admitted = ADMISSIONS.get(admission)
  if (admitted === undefined) return rejected('portable-vm-std-admission-missing')
  const content = {
    profile: PORTABLE_VM_STD_PROFILE,
    receipt: admitted.receipt,
    request_digest: admitted.request_digest,
    schema: PORTABLE_VM_STD_RESULT_SCHEMA,
  }
  return {
    ok: true,
    value: {
      ...snapshot(content),
      result_digest: digest(content),
    },
  }
}

export function runPortableVmStdConformance({ core_digest } = {}) {
  if (!DIGEST.test(core_digest)) {
    throw new TypeError('portable VM std core digest missing')
  }
  const workloads = CASES.map(([operation, parameters, typeArguments], index) => {
    const invocation = {
      graph_revision: GRAPH_REVISION,
      operation,
      package_manifest: minimalStdPackageManifest(),
      parameters,
      schema: 're.minimal-std-invocation@0.1.0',
      type_arguments: typeArguments,
    }
    const checked = checkMinimalStdInvocation(invocation)
    const translation = translateMinimalStdInvocation(invocation)
    const receipt = executeMinimalStdOperation(invocation)
    const request = createPortableVmStdRequest({
      checked: checked.value,
      invocation,
      receipt: receipt.value,
      translation: translation.value,
    })
    const admitted = admitPortableVmStd({
      request,
      trustedInvocation: invocation,
    })
    if (!admitted.ok) throw new TypeError(admitted.diagnostics[0].code)
    const executed = executePortableVmStd({ admission: admitted.value })
    if (!executed.ok || !canonicalEqual(executed.value.receipt, receipt.value)) {
      throw new TypeError('portable-vm-std-node-oracle-mismatch')
    }
    return {
      id: `STD-${String(index + 1).padStart(3, '0')}`,
      invocation_digest: checked.value.invocation_digest,
      operation,
      outcome: encodeJson(receipt.value.outcome),
      receipt_digest: receipt.value.receipt_digest,
      request_digest: request.request_digest,
    }
  })
  const content = {
    capability_digest: minimalStdCapabilityDigest(),
    core_digest,
    package_digest: minimalStdPackageDigest(),
    profile: PORTABLE_VM_STD_PROFILE,
    runtime_package_digest: minimalStdRuntimePackageDigest(),
    schema: PORTABLE_VM_STD_CONFORMANCE_SCHEMA,
    workloads,
  }
  return {
    ...content,
    report_digest: digest(content),
  }
}

export function verifyPortableVmStdConformance(report, { core_digest } = {}) {
  try {
    if (!canonicalEqual(report, runPortableVmStdConformance({ core_digest }))) {
      throw new TypeError('portable VM std report mismatch')
    }
    return { ok: true }
  } catch {
    return rejected('portable-vm-std-conformance-invalid')
  }
}

function bytes(...values) {
  return new Uint8Array(values)
}

function encodeJson(value) {
  if (value instanceof Uint8Array) {
    return { $bytes: `hex:${Buffer.from(value).toString('hex')}` }
  }
  if (Array.isArray(value)) return value.map(encodeJson)
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(
      ([key, child]) => [key, encodeJson(child)],
    ))
  }
  return value
}

function snapshot(value) {
  return structuredClone(value)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString('hex') })
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactShape(value, fields) {
  return plainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
