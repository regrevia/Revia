import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createProjectBuildBenchmarkTopology,
  DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET,
  PROJECT_BUILD_BENCHMARK_TOPOLOGIES,
  runProjectBuildBenchmark,
  verifyProjectBuildBenchmark,
} from '../src/toolchain/project-build-benchmark.js'

const authority = {
  profile_digest: fixedDigest('profile'),
  toolchain_digest: fixedDigest('toolchain'),
}

test('project benchmark topology generation is deterministic and covers DAG shapes', () => {
  for (const topology of PROJECT_BUILD_BENCHMARK_TOPOLOGIES) {
    const first = createProjectBuildBenchmarkTopology({
      moduleCount: 8,
      topology,
    })
    const second = createProjectBuildBenchmarkTopology({
      moduleCount: 8,
      topology,
    })
    assert.deepEqual(first, second)
    assert.equal(first.edges.some(({ from, to }) => from === to), false)
    assert.match(first.topology_digest, /^sha256:[0-9a-f]{64}$/u)
  }
})

test('project benchmark runs real graph-first incremental scenarios and rejects tampering', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-project-benchmark-'))
  context.after(() => rm(directory, { force: true, recursive: true }))

  const report = await runProjectBuildBenchmark({
    ...authority,
    benchmarkDirectory: directory,
    budget: DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET,
    moduleCounts: [8],
    sampleCount: 2,
    topologies: ['linear', 'fan-in'],
  })
  assert.deepEqual(verifyProjectBuildBenchmark(report, {
    requiredModuleCounts: [8],
    requiredTopologies: ['linear', 'fan-in'],
  }), { ok: true })
  assert.deepEqual(report.environment, {
    architecture: process.arch,
    node_version: process.version,
    platform: process.platform,
    runtime: 'node',
  })
  assert.match(report.environment_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(verifyProjectBuildBenchmark(report).ok, false)
  assert.ok(report.runs.every((run) =>
    run.samples.length === 2
    && /^sha256:[0-9a-f]{64}$/u.test(run.samples_digest)
    &&
    Object.values(run.samples[0]).every((scenario) =>
      scenario.peak_rss_bytes >= 1_048_576)))

  const tampered = structuredClone(report)
  tampered.runs[0].samples[0].interface.stats.built += 1
  assert.equal(verifyProjectBuildBenchmark(tampered, {
    requiredModuleCounts: [8],
    requiredTopologies: ['linear', 'fan-in'],
  }).ok, false)

  const overBudget = structuredClone(report)
  overBudget.runs[0].samples[0].cold.elapsed_ns =
    overBudget.budget.max_elapsed_ns + 1
  assert.equal(verifyProjectBuildBenchmark(overBudget, {
    requiredModuleCounts: [8],
    requiredTopologies: ['linear', 'fan-in'],
  }).ok, false)
})

function fixedDigest(value) {
  return `sha256:${Buffer.from(value).toString('hex').slice(0, 64).padEnd(64, '0')}`
}
