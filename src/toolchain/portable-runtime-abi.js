import { createHash } from 'node:crypto'

import {
  runPortableExecutorBenchmark,
} from './portable-executor-equivalence.js'
import {
  runPortableFaultProtocolBenchmark,
} from './portable-fault-protocol.js'
import {
  runTaskRuntimeLifecycleBenchmark,
} from './task-runtime-lifecycle.js'

export const PORTABLE_RUNTIME_ABI_CORPUS_SCHEMA =
  're.portable-runtime-abi-corpus@0.1.0'
export const PORTABLE_RUNTIME_ABI_REPORT_SCHEMA =
  're.portable-runtime-abi-report@0.1.0'
export const PORTABLE_RUNTIME_ABI_PROFILE = 're.portable-runtime-abi@0.1.0'

const CORPUS_FIELDS = ['domains', 'fault_graph_case_id', 'schema']
const REPORT_FIELDS = ['corpus_digest', 'domains', 'profile', 'report_digest', 'schema']
const DOMAIN_FIELDS = ['id', 'kind', 'report', 'report_digest', 'workload_count']
const DOMAIN_KINDS = Object.freeze([
  ['execution', 'portable-execution'],
  ['fault', 'portable-fault'],
  ['task-lifecycle', 'task-lifecycle'],
])
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export async function runPortableRuntimeAbiCorpus({
  bundle,
  corpus,
  faultCorpus,
  loadGraph,
  taskCorpus,
} = {}) {
  const validated = validatePortableRuntimeAbiCorpus(corpus)
  if (!validated.ok) return validated
  if (typeof loadGraph !== 'function') {
    return rejected('portable-runtime-abi-graph-loader-missing')
  }
  const faultCase = bundle?.cases?.find(
    ({ id }) => id === corpus.fault_graph_case_id,
  )
  if (faultCase === undefined) {
    return rejected('portable-runtime-abi-fault-graph-case-missing')
  }
  let graph
  try {
    graph = await loadGraph(faultCase)
  } catch {
    return rejected('portable-runtime-abi-fault-graph-load-failed')
  }
  if (!plainObject(graph) || graph.graph_revision !== faultCase.graph_revision) {
    return rejected('portable-runtime-abi-fault-graph-authority-mismatch')
  }

  const execution = await runPortableExecutorBenchmark(bundle, { loadGraph })
  if (!execution.ok) return execution
  const fault = await runPortableFaultProtocolBenchmark(faultCorpus, { graph })
  if (!fault.ok) return fault
  const lifecycle = await runTaskRuntimeLifecycleBenchmark(taskCorpus)
  if (!lifecycle.ok) return lifecycle

  const reports = new Map([
    ['execution', execution.value],
    ['fault', fault.value],
    ['task-lifecycle', lifecycle.value],
  ])
  const domains = corpus.domains.map(({ id, kind, workload_count }) => {
    const report = reports.get(id)
    return {
      id,
      kind,
      report,
      report_digest: report.report_digest,
      workload_count,
    }
  })
  const report = {
    corpus_digest: digest(corpus),
    domains,
    profile: PORTABLE_RUNTIME_ABI_PROFILE,
    schema: PORTABLE_RUNTIME_ABI_REPORT_SCHEMA,
  }
  report.report_digest = portableRuntimeAbiReportDigest(report)
  return { ok: true, value: report }
}

export async function verifyPortableRuntimeAbiCorpus(report, inputs = {}) {
  const structural = validateReport(report, inputs.corpus)
  if (!structural.ok) return structural
  const expected = await runPortableRuntimeAbiCorpus(inputs)
  if (!expected.ok) return expected

  for (let index = 0; index < expected.value.domains.length; index += 1) {
    const actual = report.domains[index]
    const authority = expected.value.domains[index]
    if (actual.report_digest !== actual.report?.report_digest) {
      return rejected('portable-runtime-abi-domain-report-digest-mismatch', {
        domain: actual.id,
      })
    }
    if (!canonicalEqual(actual.report, authority.report)) {
      return rejected(`portable-runtime-abi-${actual.id}-authority-mismatch`)
    }
  }
  return { ok: true }
}

export function validatePortableRuntimeAbiCorpus(corpus) {
  if (!plainObject(corpus)
    || corpus.schema !== PORTABLE_RUNTIME_ABI_CORPUS_SCHEMA) {
    return rejected('portable-runtime-abi-corpus-schema-mismatch')
  }
  if (!exactShape(corpus, CORPUS_FIELDS)) {
    return rejected('portable-runtime-abi-corpus-fields-mismatch')
  }
  if (typeof corpus.fault_graph_case_id !== 'string'
    || !Array.isArray(corpus.domains)
    || corpus.domains.length !== DOMAIN_KINDS.length
    || !canonicalEqual(
      corpus.domains.map(({ id, kind }) => [id, kind]),
      DOMAIN_KINDS,
    )) {
    return rejected('portable-runtime-abi-domain-set-mismatch')
  }
  for (const domain of corpus.domains) {
    if (!plainObject(domain)
      || !exactShape(domain, ['id', 'kind', 'workload_count'])
      || !Number.isSafeInteger(domain.workload_count)
      || domain.workload_count <= 0) {
      return rejected('portable-runtime-abi-domain-invalid')
    }
  }
  return { ok: true }
}

export function portableRuntimeAbiReportDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid portable runtime ABI report')
  }
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

function validateReport(report, corpus) {
  const corpusResult = validatePortableRuntimeAbiCorpus(corpus)
  if (!corpusResult.ok) return corpusResult
  if (!plainObject(report)
    || report.schema !== PORTABLE_RUNTIME_ABI_REPORT_SCHEMA) {
    return rejected('portable-runtime-abi-report-schema-mismatch')
  }
  if (!exactShape(report, REPORT_FIELDS)) {
    return rejected('portable-runtime-abi-report-fields-mismatch')
  }
  if (report.profile !== PORTABLE_RUNTIME_ABI_PROFILE
    || report.corpus_digest !== digest(corpus)
    || !DIGEST.test(report.report_digest)
    || report.report_digest !== portableRuntimeAbiReportDigest(report)) {
    return rejected('portable-runtime-abi-report-digest-mismatch')
  }
  if (!Array.isArray(report.domains)
    || report.domains.length !== corpus.domains.length
    || !canonicalEqual(
      report.domains.map(({ id, kind }) => [id, kind]),
      DOMAIN_KINDS,
    )) {
    return rejected('portable-runtime-abi-domain-set-mismatch')
  }
  for (let index = 0; index < report.domains.length; index += 1) {
    const domain = report.domains[index]
    const declaration = corpus.domains[index]
    if (!plainObject(domain) || !exactShape(domain, DOMAIN_FIELDS)
      || domain.id !== declaration.id
      || domain.kind !== declaration.kind
      || domain.workload_count !== declaration.workload_count
      || !plainObject(domain.report)
      || !DIGEST.test(domain.report_digest)) {
      return rejected('portable-runtime-abi-domain-invalid')
    }
  }
  return { ok: true }
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejected(code, detail = {}) {
  return { diagnostics: [{ code, ...detail }], ok: false }
}
