import { createHash } from 'node:crypto'

import { agentProjectReleaseLockDigest } from './backend-contract.js'

const REQUEST_SCHEMA = 're.backend-request@0.1.0'

export async function runBackendBenchmark({
  backend,
  iterations = 30,
  project,
  releaseLock = null,
}) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 10_000) {
    throw new TypeError('invalid benchmark iterations')
  }
  const workloads = [
    {
      id: 'identity',
      request: {
        graph_revision: project.graph_revision,
        operation: 'identity',
        schema: REQUEST_SCHEMA,
      },
    },
    {
      id: 'translate-en-US',
      request: {
        graph_revision: project.graph_revision,
        input: { locale: 'en-US', media: 'all' },
        operation: 'translate',
        schema: REQUEST_SCHEMA,
      },
    },
    {
      id: 'translate-zh-CN',
      request: {
        graph_revision: project.graph_revision,
        input: { locale: 'zh-CN', media: 'all' },
        operation: 'translate',
        schema: REQUEST_SCHEMA,
      },
    },
  ]
  const runs = []
  for (const workload of workloads) {
    const samples_ns = []
    for (let index = 0; index < iterations; index += 1) {
      const start = process.hrtime.bigint()
      const result = await backend.run(project, workload.request)
      const elapsed = process.hrtime.bigint() - start
      if (!result.ok) throw new TypeError(`benchmark workload failed: ${workload.id}`)
      samples_ns.push(Number(elapsed))
    }
    samples_ns.sort((left, right) => left - right)
    runs.push({
      id: workload.id,
      input_digest: digest(workload.request),
      metrics: {
        max_ns: samples_ns.at(-1),
        median_ns: percentile(samples_ns, 0.5),
        min_ns: samples_ns[0],
        p99_ns: percentile(samples_ns, 0.99),
        throughput_ops_sec: 1_000_000_000 / percentile(samples_ns, 0.5),
      },
      sample_count: samples_ns.length,
      samples_digest: digest(samples_ns),
      status: 'measured',
    })
  }
  const report = {
    backend: backend.describe(),
    environment: {
      architecture: process.arch,
      node: process.version,
      platform: process.platform,
    },
    graph_revision: project.graph_revision,
    iterations,
    independent_review: releaseLock?.independent_review?.status ?? null,
    measurement_status: 'partial',
    mode: 'offline-reproducible',
    release_lock_digest: releaseLock === null
      ? null
      : agentProjectReleaseLockDigest(releaseLock),
    release_stage: releaseLock?.stage ?? null,
    runs,
    schema: 're.agent-project-benchmark@0.2.0',
  }
  return {
    ...report,
    report_digest: digest(report),
  }
}

export function verifyBackendBenchmarkReport(report) {
  try {
    if (report === null || typeof report !== 'object' || Array.isArray(report)
      || report.schema !== 're.agent-project-benchmark@0.2.0'
      || report.measurement_status !== 'partial'
      || report.mode !== 'offline-reproducible'
      || !/^sha256:[0-9a-f]{64}$/u.test(report.release_lock_digest)
      || typeof report.release_stage !== 'string'
      || !['pending', 'pass', 'fail'].includes(report.independent_review)
      || !Array.isArray(report.runs)
      || report.runs.map(({ id }) => id).join(',') !== 'identity,translate-en-US,translate-zh-CN') {
      throw new TypeError('invalid benchmark report')
    }
    const { report_digest, ...content } = report
    if (report_digest !== digest(content)) throw new TypeError('benchmark report digest mismatch')
    for (const run of report.runs) {
      if (run.status !== 'measured'
        || !Number.isSafeInteger(run.sample_count)
        || run.sample_count !== report.iterations
        || !/^sha256:[0-9a-f]{64}$/u.test(run.input_digest)
        || !/^sha256:[0-9a-f]{64}$/u.test(run.samples_digest)
        || Object.values(run.metrics).some((value) => !Number.isFinite(value) || value < 0)) {
        throw new TypeError('invalid benchmark run')
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-backend-benchmark-report',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

function percentile(samples, ratio) {
  return samples[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)]
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
