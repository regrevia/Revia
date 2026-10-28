import { createHash } from 'node:crypto'

import {
  compilePortableBytecode,
} from './portable-bytecode.js'
import {
  verifyPortableRuntimeAbiCorpus,
} from './portable-runtime-abi.js'
import {
  executePortableVm,
} from './portable-vm.js'

export const PORTABLE_VM_CONFORMANCE_SCHEMA =
  're.portable-vm-conformance@0.1.0'
export const PORTABLE_VM_CONFORMANCE_PROFILE = 're.portable-vm@0.1.0'

const REPORT_FIELDS = [
  'abi_report_digest',
  'profile',
  'report_digest',
  'schema',
  'workloads',
]
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export async function runPortableVmConformance({
  abiInputs,
  abiReport,
  bundle,
  loadGraph,
} = {}) {
  const verifiedAbi = await verifyPortableRuntimeAbiCorpus(abiReport, abiInputs)
  if (!verifiedAbi.ok) return withPrefix(verifiedAbi, 'portable-vm-abi')
  if (!plainObject(bundle) || !Array.isArray(bundle.cases)) {
    return rejected('portable-vm-bundle-invalid')
  }
  if (typeof loadGraph !== 'function') {
    return rejected('portable-vm-graph-loader-missing')
  }
  const execution = abiReport.domains.find(({ id }) => id === 'execution')?.report
  const authority = execution?.candidates?.find(
    ({ candidate }) => candidate === 'portable-core',
  )?.workloads
  if (!Array.isArray(authority)
    || authority.length !== bundle.cases.length) {
    return rejected('portable-vm-execution-authority-missing')
  }

  const workloads = []
  for (let index = 0; index < bundle.cases.length; index += 1) {
    const entry = bundle.cases[index]
    const expected = authority[index]
    if (entry?.id !== expected?.id) {
      return rejected('portable-vm-workload-set-mismatch')
    }
    let graph
    try {
      graph = await loadGraph(entry)
    } catch {
      return rejected('portable-vm-graph-load-failed')
    }
    if (!plainObject(graph) || graph.graph_revision !== expected.request.graph_revision) {
      return rejected('portable-vm-graph-authority-mismatch')
    }
    const artifact = compilePortableBytecode(graph)
    if (!artifact.ok) return withPrefix(artifact, 'portable-vm-artifact')
    const executed = executePortableVm({
      artifact: artifact.value,
      checkedGraph: graph,
      expectedArtifactDigest: expected.request.artifact_digest,
      expectedGraphRevision: expected.request.graph_revision,
      invokeCapability: scriptedCapability(entry),
      request: expected.request,
    })
    if (!executed.ok) return withPrefix(executed, 'portable-vm-execution')
    const observed = {
      invocations: executed.value.invocations,
      outcome: executed.value.outcome,
    }
    const expectedObserved = {
      invocations: expected.result.receipt.invocations,
      outcome: expected.result.outcome,
    }
    if (!canonicalEqual(observed, expectedObserved)) {
      return rejected('portable-vm-node-oracle-mismatch', { workload: entry.id })
    }
    workloads.push({
      id: entry.id,
      outcome: snapshotJson(observed.outcome),
      receipt: snapshotJson(observed.invocations),
      request_digest: expected.request.request_digest,
    })
  }
  const report = {
    abi_report_digest: abiReport.report_digest,
    profile: PORTABLE_VM_CONFORMANCE_PROFILE,
    schema: PORTABLE_VM_CONFORMANCE_SCHEMA,
    workloads,
  }
  report.report_digest = portableVmConformanceReportDigest(report)
  return { ok: true, value: report }
}

export async function verifyPortableVmConformance(report, inputs = {}) {
  if (!plainObject(report) || report.schema !== PORTABLE_VM_CONFORMANCE_SCHEMA) {
    return rejected('portable-vm-report-schema-mismatch')
  }
  if (!exactShape(report, REPORT_FIELDS)
    || report.profile !== PORTABLE_VM_CONFORMANCE_PROFILE
    || !DIGEST.test(report.abi_report_digest)
    || !DIGEST.test(report.report_digest)
    || report.report_digest !== portableVmConformanceReportDigest(report)) {
    return rejected('portable-vm-report-digest-mismatch')
  }
  const expected = await runPortableVmConformance(inputs)
  if (!expected.ok) return expected
  if (!canonicalEqual(report, expected.value)) {
    return rejected('portable-vm-node-oracle-authority-mismatch')
  }
  return { ok: true }
}

export function portableVmConformanceReportDigest(report) {
  if (!plainObject(report)) throw new TypeError('invalid portable VM report')
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

function scriptedCapability(entry) {
  let index = 0
  return (instance, member, args, invocationId) => {
    const expected = entry.invocations[index]
    index += 1
    if (expected === undefined
      || expected.instance !== instance
      || expected.member !== member
      || expected.invocation_id !== invocationId
      || !canonicalEqual(encodeValue(args), expected.arguments)) {
      return { diagnostics: [{ code: 'portable-vm-invocation-mismatch' }], kind: 'check-failure' }
    }
    return decodeValue(expected.response)
  }
}

function encodeValue(value) {
  if (value instanceof Uint8Array) {
    return { $bytes: `hex:${[...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` }
  }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (plainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(
      ([key, child]) => [key, encodeValue(child)],
    ))
  }
  return value
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (plainObject(value)) {
    if (Object.keys(value).length === 1 && typeof value.$bytes === 'string') {
      const bytes = new Uint8Array((value.$bytes.length - 4) / 2)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.$bytes.slice(4 + index * 2, 6 + index * 2), 16)
      }
      return bytes
    }
    return Object.fromEntries(Object.entries(value).map(
      ([key, child]) => [key, decodeValue(child)],
    ))
  }
  return value
}

function snapshotJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function withPrefix(result, prefix) {
  return {
    diagnostics: result.diagnostics.map(({ code }) => ({ code: `${prefix}-${code}` })),
    ok: false,
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
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

function exactShape(value, fields) {
  return plainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}
