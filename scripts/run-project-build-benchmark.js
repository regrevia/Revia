#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET,
  PROJECT_BUILD_BENCHMARK_TOPOLOGIES,
  runProjectBuildBenchmark,
  verifyProjectBuildBenchmark,
} from '../src/toolchain/project-build-benchmark.js'

const root = new URL('../', import.meta.url)
const lock = JSON.parse(await readFile(
  new URL('../release/agent-project-release-lock.json', import.meta.url),
  'utf8',
))
const toolchainDigest = digestTrackedFiles(await Promise.all(
  RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
    bytes: await readFile(new URL(path, root)),
    path,
  })),
))
if (toolchainDigest !== lock.toolchain.digest) {
  throw new TypeError('release toolchain digest mismatch')
}

const benchmarkDirectory = await mkdtemp(join(tmpdir(), 're-project-build-benchmark-'))
try {
  const report = await runProjectBuildBenchmark({
    benchmarkDirectory,
    budget: DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET,
    moduleCounts: [50, 500, 5_000],
    profile_digest: lock.profile.digest,
    sampleCount: 1,
    toolchain_digest: toolchainDigest,
    topologies: PROJECT_BUILD_BENCHMARK_TOPOLOGIES,
  })
  const verified = verifyProjectBuildBenchmark(report)
  if (!verified.ok) throw new TypeError(verified.diagnostics[0].code)
  await writeFile(
    new URL('../release/project-build-benchmark-report.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${report.report_digest}\n`)
} finally {
  await rm(benchmarkDirectory, { force: true, recursive: true })
}
