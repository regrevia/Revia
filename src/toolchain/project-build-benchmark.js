import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { moduleInterfaceDigest } from './module-contract.js'
import { buildProjectWithArtifactCache } from './project-build-pipeline.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const REPORT_SCHEMA = 're.project-build-benchmark@0.1.0'
const BUDGET_SCHEMA = 're.project-build-benchmark-budget@0.1.0'
const DEFAULT_COUNTS = Object.freeze([50, 500, 5_000])
export const PROJECT_BUILD_BENCHMARK_TOPOLOGIES = Object.freeze([
  'linear',
  'deep',
  'wide',
  'fan-out',
  'fan-in',
])
export const DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET = Object.freeze({
  max_artifact_bytes: 1_073_741_824,
  max_elapsed_ns: 300_000_000_000,
  max_peak_rss_bytes: 2_147_483_648,
  max_recheck_modules: 5_000,
  schema: BUDGET_SCHEMA,
})

export async function createProjectBuildBenchmarkFixture({
  moduleCount,
  rootDirectory,
  topology,
}) {
  const topologyInfo = createProjectBuildBenchmarkTopology({
    moduleCount,
    topology,
  })
  const root = join(rootDirectory, `${topology}-${moduleCount}`)
  const projectDirectory = join(root, 'project')
  const cacheDirectory = join(root, 'cache')
  const buildDirectory = join(root, 'builds')
  await mkdir(join(projectDirectory, 'modules'), { recursive: true })
  const fixture = {
    buildDirectory,
    cacheDirectory,
    moduleCount,
    projectDirectory,
    root,
    topology,
    topologyInfo,
  }
  await writeProjectBuildBenchmarkVariant(fixture, 'baseline')
  return fixture
}

export async function writeProjectBuildBenchmarkVariant(fixture, variant) {
  if (!['add', 'baseline', 'implementation', 'interface'].includes(variant)) {
    throw new TypeError('invalid project build benchmark variant')
  }
  const records = createRecords({
    moduleCount: fixture.moduleCount,
    topology: fixture.topology,
    variant,
  })
  await writeProject(fixture.projectDirectory, records)
}

export function createProjectBuildBenchmarkTopology({
  moduleCount,
  topology,
}) {
  if (!Number.isSafeInteger(moduleCount) || moduleCount < 2
    || !PROJECT_BUILD_BENCHMARK_TOPOLOGIES.includes(topology)) {
    throw new TypeError('invalid project build benchmark topology')
  }
  const names = moduleNames(moduleCount, topology)
  const edges = []
  for (let index = 1; index < moduleCount; index += 1) {
    if (topology === 'linear') {
      edges.push({ from: names[index - 1], to: names[index] })
    } else if (topology === 'deep') {
      edges.push({ from: names[index - 1], to: names[index] })
      if (index > 1 && index % 2 === 0) {
        edges.push({ from: names[index - 2], to: names[index] })
      }
    } else if (topology === 'wide') {
      // An antichain exercises independent ready-queue scheduling.
      continue
    } else if (topology === 'fan-out') {
      edges.push({ from: names[0], to: names[index] })
    } else if (topology === 'fan-in') {
      edges.push({ from: names[index - 1], to: names[index] })
      if (index > 1) {
        edges.push({ from: names[Math.floor(index / 2) - 1], to: names[index] })
      }
    }
  }
  return {
    edges,
    module_count: moduleCount,
    names,
    topology,
    topology_digest: digest({
      edges,
      module_count: moduleCount,
      names,
      topology,
    }),
  }
}

export async function runProjectBuildBenchmark({
  benchmarkDirectory,
  moduleCounts = DEFAULT_COUNTS,
  profile_digest,
  sampleCount = 1,
  toolchain_digest,
  topologies = PROJECT_BUILD_BENCHMARK_TOPOLOGIES,
  budget = DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET,
}) {
  validateBenchmarkInputs({
    benchmarkDirectory,
    budget,
    moduleCounts,
    profile_digest,
    sampleCount,
    toolchain_digest,
    topologies,
  })
  const runs = []
  for (const moduleCount of [...moduleCounts].sort((left, right) => left - right)) {
    for (const topology of topologyOrder(topologies)) {
      const samples = []
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const sampleRoot = join(
          benchmarkDirectory,
          `sample-${sample}`,
          `${topology}-${moduleCount}`,
        )
        await rm(sampleRoot, { force: true, recursive: true })
        await mkdir(sampleRoot, { recursive: true })
        const fixture = await createProjectBuildBenchmarkFixture({
          moduleCount,
          rootDirectory: sampleRoot,
          topology,
        })
        samples.push(await runFixtureSample({
          fixture,
          profile_digest,
          toolchain_digest,
        }))
      }
      runs.push({
        module_count: moduleCount,
        samples,
        samples_digest: digest(samples.map(stableSample)),
        topology,
        topology_digest: createProjectBuildBenchmarkTopology({
          moduleCount,
          topology,
        }).topology_digest,
      })
    }
  }
  const report = {
    budget,
    budget_policy_digest: digest(budget),
    environment: currentEnvironment(),
    environment_digest: digest(currentEnvironment()),
    fixture: 'graph-first-project-directory',
    mode: 'local-node-reference',
    profile_digest,
    runs,
    sample_count: sampleCount,
    schema: REPORT_SCHEMA,
    toolchain_digest,
  }
  const completeReport = {
    ...report,
    report_digest: digest(stableReportContent(report)),
  }
  const verified = verifyProjectBuildBenchmark(completeReport, {
    requiredModuleCounts: moduleCounts,
    requiredTopologies: topologies,
  })
  if (!verified.ok) {
    throw new TypeError(`${verified.diagnostics[0].code}:${verified.diagnostics[0].reason}`)
  }
  return completeReport
}

export function verifyProjectBuildBenchmark(
  report,
  {
    requiredModuleCounts = DEFAULT_COUNTS,
    requiredTopologies = PROJECT_BUILD_BENCHMARK_TOPOLOGIES,
  } = {},
) {
  try {
    validateReportShape(report)
    if (report.report_digest !== digest(stableReportContent(report))) {
      throw new TypeError('project build benchmark digest mismatch')
    }
    if (report.budget_policy_digest !== digest(report.budget)) {
      throw new TypeError('project build benchmark budget digest mismatch')
    }
    if (report.environment_digest !== digest(report.environment)) {
      throw new TypeError('project build benchmark environment digest mismatch')
    }
    const counts = [...new Set(requiredModuleCounts)].sort((left, right) => left - right)
    const topologies = topologyOrder(requiredTopologies)
    const expectedRuns = new Map(
      counts.flatMap((moduleCount) => topologies.map((topology) => [
        `${moduleCount}:${topology}`,
        true,
      ])),
    )
    if (report.runs.length !== expectedRuns.size) {
      throw new TypeError('project build benchmark run set mismatch')
    }
    const seen = new Set()
    for (const run of report.runs) {
      const key = `${run.module_count}:${run.topology}`
      if (!expectedRuns.has(key) || seen.has(key)) {
        throw new TypeError('project build benchmark run identity mismatch')
      }
      seen.add(key)
      verifyRun(run, report)
    }
    if (seen.size !== expectedRuns.size) {
      throw new TypeError('project build benchmark run set mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-project-build-benchmark',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

async function runFixtureSample({ fixture, profile_digest, toolchain_digest }) {
  const build = (previousManifest = null) => buildProjectWithArtifactCache({
    buildDirectory: fixture.buildDirectory,
    cacheDirectory: fixture.cacheDirectory,
    compile: ({ cache_key, module }) => ({
      cache_key,
      implementation_digest: module.implementation_digest,
      interface_digest: module.interface_digest,
      module: module.name,
    }),
    previousManifest,
    profile_digest,
    projectDirectory: fixture.projectDirectory,
    toolchain_digest,
    verify: (payload, { cache_key, module }) =>
      payload?.cache_key === cache_key
      && payload?.implementation_digest === module.implementation_digest
      && payload?.interface_digest === module.interface_digest
      && payload?.module === module.name,
  })

  const cold = await measuredBuild(build(), fixture.cacheDirectory)
  const warm = await measuredBuild(build(cold.result.manifest), fixture.cacheDirectory)

  await writeProjectBuildBenchmarkVariant(fixture, 'implementation')
  const implementation = await measuredBuild(
    build(cold.result.manifest),
    fixture.cacheDirectory,
  )

  await writeProjectBuildBenchmarkVariant(fixture, 'interface')
  const interfaceBuild = await measuredBuild(
    build(cold.result.manifest),
    fixture.cacheDirectory,
  )

  await writeProjectBuildBenchmarkVariant(fixture, 'add')
  const added = await measuredBuild(build(cold.result.manifest), fixture.cacheDirectory)

  await writeProjectBuildBenchmarkVariant(fixture, 'baseline')
  const deleted = await measuredBuild(
    build(added.result.manifest),
    fixture.cacheDirectory,
  )

  return {
    add: scenarioValue(added),
    cold: scenarioValue(cold),
    delete: scenarioValue(deleted),
    implementation: scenarioValue(implementation),
    interface: scenarioValue(interfaceBuild),
    warm: scenarioValue(warm),
  }
}

async function measuredBuild(operation, cacheDirectory) {
  const before = maxRssBytes()
  const start = process.hrtime.bigint()
  const result = await operation
  const elapsed = Number(process.hrtime.bigint() - start)
  const after = maxRssBytes()
  if (!result.ok) throw new TypeError(result.diagnostics[0].code)
  const artifact_bytes = await projectArtifactBytes(
    cacheDirectory,
    result.manifest,
  )
  return {
    elapsed_ns: elapsed,
    peak_rss_bytes: Math.max(before, after),
    result,
    artifact_bytes,
  }
}

async function projectArtifactBytes(cacheDirectory, manifest) {
  let total = 0
  for (let start = 0; start < manifest.modules.length; start += 128) {
    const chunk = manifest.modules.slice(start, start + 128)
    const sizes = await Promise.all(chunk.map(async (module) => (
      await readFile(join(
        cacheDirectory,
        module.cache_key.slice(7),
        'artifact.json',
      ))
    ).byteLength))
    total += sizes.reduce((sum, size) => sum + size, 0)
  }
  return total
}

function maxRssBytes() {
  return process.resourceUsage().maxRSS * 1024
}

function scenarioValue(measurement) {
  const invalidation = measurement.result.invalidation
  return {
    added_modules_count: invalidation.added_modules.length,
    added_modules_digest: digest(invalidation.added_modules),
    artifact_bytes: measurement.artifact_bytes,
    elapsed_ns: measurement.elapsed_ns,
    peak_rss_bytes: measurement.peak_rss_bytes,
    recheck_modules_count: invalidation.modules.length,
    recheck_modules_digest: digest(invalidation.modules),
    removed_modules_count: invalidation.removed_modules.length,
    removed_modules_digest: digest(invalidation.removed_modules),
    stats: measurement.result.stats,
  }
}

function verifyRun(run, report) {
  if (!plainObject(run)
    || !exactFields(run, [
      'module_count',
      'samples',
      'samples_digest',
      'topology',
      'topology_digest',
    ])
    || !Number.isSafeInteger(run.module_count)
    || run.module_count < 2
    || !PROJECT_BUILD_BENCHMARK_TOPOLOGIES.includes(run.topology)
    || !Array.isArray(run.samples)
    || !DIGEST.test(run.samples_digest)) {
    throw new TypeError('invalid project build benchmark run')
  }
  const topology = createProjectBuildBenchmarkTopology({
    moduleCount: run.module_count,
    topology: run.topology,
  })
  if (run.topology_digest !== topology.topology_digest) {
    throw new TypeError('project build benchmark topology digest mismatch')
  }
  if (run.samples.length !== report.sample_count
    || run.samples_digest !== digest(run.samples.map(stableSample))) {
    throw new TypeError('project build benchmark samples digest mismatch')
  }
  const expected = expectedScenarios(topology)
  let previousStable = null
  for (const sample of run.samples) {
    const stable = stableSample(sample)
    if (previousStable !== null && canonicalJson(stable) !== canonicalJson(previousStable)) {
      throw new TypeError('project build benchmark nondeterministic semantic sample')
    }
    previousStable = stable
    for (const [name, value] of Object.entries(sample)) {
      const expectation = expected[name]
      if (!expectation || !plainObject(value)
        || !exactFields(value, [
          'added_modules_count',
          'added_modules_digest',
          'artifact_bytes',
          'elapsed_ns',
          'peak_rss_bytes',
          'recheck_modules_count',
          'recheck_modules_digest',
          'removed_modules_count',
          'removed_modules_digest',
          'stats',
        ])
        || !plainObject(value.stats)
        || !['built', 'hits', 'misses'].every((field) =>
          Number.isSafeInteger(value.stats[field]) && value.stats[field] >= 0)
        || canonicalJson(value.stats) !== canonicalJson(expectation.stats)
        || value.recheck_modules_count !== expectation.recheck_modules.length
        || value.recheck_modules_digest !== digest(expectation.recheck_modules)
        || value.added_modules_count !== expectation.added_modules.length
        || value.added_modules_digest !== digest(expectation.added_modules)
        || value.removed_modules_count !== expectation.removed_modules.length
        || value.removed_modules_digest !== digest(expectation.removed_modules)
        || !Number.isSafeInteger(value.artifact_bytes)
        || value.artifact_bytes <= 0
        || !Number.isSafeInteger(value.elapsed_ns)
        || value.elapsed_ns < 0
        || !Number.isSafeInteger(value.peak_rss_bytes)
        || value.peak_rss_bytes <= 0
        || value.elapsed_ns > report.budget.max_elapsed_ns
        || value.peak_rss_bytes > report.budget.max_peak_rss_bytes
        || value.artifact_bytes > report.budget.max_artifact_bytes
        || value.recheck_modules_count > report.budget.max_recheck_modules) {
        throw new TypeError(`project build benchmark scenario mismatch: ${name}`)
      }
    }
  }
}

function expectedScenarios(topology) {
  const names = topology.names
  const target = names[Math.floor(names.length / 2)]
  const interfaceSet = new Set([target])
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const edge of topology.edges) {
      if (edge.from === current && !interfaceSet.has(edge.to)) {
        interfaceSet.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  const order = topologicalNames(topology)
  const interfaceModules = order.filter((name) => interfaceSet.has(name))
  const extra = `benchmark.${topology.topology.replace('-', '_')}.extra`
  return {
    add: {
      added_modules: [extra],
      recheck_modules: [extra],
      removed_modules: [],
      stats: { built: 1, hits: names.length, misses: 1 },
    },
    cold: {
      added_modules: names,
      recheck_modules: names,
      removed_modules: [],
      stats: { built: names.length, hits: 0, misses: names.length },
    },
    delete: {
      added_modules: [],
      recheck_modules: [],
      removed_modules: [extra],
      stats: { built: 0, hits: names.length, misses: 0 },
    },
    implementation: {
      added_modules: [],
      recheck_modules: [target],
      removed_modules: [],
      stats: { built: 1, hits: names.length - 1, misses: 1 },
    },
    interface: {
      added_modules: [],
      recheck_modules: interfaceModules,
      removed_modules: [],
      stats: {
        built: interfaceModules.length,
        hits: names.length - interfaceModules.length,
        misses: interfaceModules.length,
      },
    },
    warm: {
      added_modules: [],
      recheck_modules: [],
      removed_modules: [],
      stats: { built: 0, hits: names.length, misses: 0 },
    },
  }
}

function createRecords({ moduleCount, topology, variant }) {
  const topologyInfo = createProjectBuildBenchmarkTopology({ moduleCount, topology })
  const dependenciesByModule = new Map(
    topologyInfo.names.map((name) => [name, []]),
  )
  for (const edge of topologyInfo.edges) {
    dependenciesByModule.get(edge.to).push(edge.from)
  }
  const target = Math.floor(moduleCount / 2)
  const records = []
  const recordsByName = new Map()
  for (let index = 0; index < moduleCount; index += 1) {
    const name = topologyInfo.names[index]
    const dependencyNames = dependenciesByModule.get(name)
    const dependencies = dependencyNames.map((dependency, dependencyIndex) => {
      const dependencyRecord = recordsByName.get(dependency)
      return {
        binding: `dep${dependencyIndex}`,
        interface_digest: dependencyRecord.interface_digest,
        module: dependency,
        scope: 'package',
      }
    })
    const changedInterface = variant === 'interface' && index === target
    const moduleInterface = {
      dependencies,
      exports: [{
        contract_digest: fixedDigest(
          `${name}-${changedInterface ? 'changed' : 'build'}`,
        ),
        kind: 'function',
        name: changedInterface ? 'build_changed' : 'build',
      }],
      module: name,
      schema: 're.module-interface@0.1.0',
    }
    const imports = dependencies.map((dependency) => (
      `import ${dependency.module}@${dependency.interface_digest} as ${dependency.binding}`
    ))
    let source = [
      're 1.0 compact',
      `module ${name}`,
      ...imports,
      `export ${moduleInterface.exports[0].name}`,
      '',
    ].join('\n')
    if (variant === 'implementation' && index === target) source += '\n'
    const record = {
      interface: moduleInterface,
      interface_digest: moduleInterfaceDigest(moduleInterface),
      name,
      path: `modules/${String(index).padStart(String(moduleCount).length, '0')}.re`,
      source,
      source_sha256: fixedDigest(source),
    }
    records.push(record)
    recordsByName.set(name, record)
  }
  if (variant === 'interface') {
    for (const record of records) {
      const dependencies = topologyInfo.edges
        .filter(({ to }) => to === record.name)
        .map(({ from }) => records.find(({ name }) => name === from))
      if (dependencies.length === 0) continue
      record.interface.dependencies = record.interface.dependencies.map((dependency, index) => ({
        ...dependency,
        interface_digest: dependencies[index].interface_digest,
      }))
      record.interface_digest = moduleInterfaceDigest(record.interface)
      record.source = [
        're 1.0 compact',
        `module ${record.name}`,
        ...record.interface.dependencies.map((dependency) =>
          `import ${dependency.module}@${dependency.interface_digest} as ${dependency.binding}`),
        `export ${record.interface.exports[0].name}`,
        '',
      ].join('\n')
      record.source_sha256 = fixedDigest(record.source)
    }
  }
  if (variant === 'add') {
    const extraName = `benchmark.${topology.replace('-', '_')}.extra`
    const extraInterface = {
      dependencies: [],
      exports: [{
        contract_digest: fixedDigest(`${extraName}-build`),
        kind: 'function',
        name: 'build',
      }],
      module: extraName,
      schema: 're.module-interface@0.1.0',
    }
    const source = [
      're 1.0 compact',
      `module ${extraName}`,
      'export build',
      '',
    ].join('\n')
    records.push({
      interface: extraInterface,
      interface_digest: moduleInterfaceDigest(extraInterface),
      name: extraName,
      path: 'modules/extra.re',
      source,
      source_sha256: fixedDigest(source),
    })
  }
  return records
}

async function writeProject(projectDirectory, records) {
  await mkdir(join(projectDirectory, 'modules'), { recursive: true })
  const manifestPath = join(projectDirectory, 'project.json')
  let previous = null
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {}
  const previousByName = new Map(
    (previous?.modules ?? []).map((entry) => [entry.name, entry]),
  )
  const nextPaths = new Set(records.map(({ path }) => path))
  await Promise.all((previous?.modules ?? [])
    .map(({ path }) => path)
    .filter((path) => !nextPaths.has(path))
    .map((path) => rm(join(projectDirectory, path), { force: true })))
  for (let start = 0; start < records.length; start += 128) {
    await Promise.all(records.slice(start, start + 128).map(async (record) => {
      const old = previousByName.get(record.name)
      if (old?.path === record.path && old.source_sha256 === record.source_sha256) return
      await writeFile(join(projectDirectory, record.path), record.source, 'utf8')
    }))
  }
  await writeFile(manifestPath, `${JSON.stringify({
    modules: records.map(({ name, path, source_sha256 }) => ({
      name,
      path,
      source_sha256,
    })),
    package_manifest: {
      external_interfaces: [],
      modules: records.map(({ interface: moduleInterface, interface_digest, name, source_sha256 }) => ({
        implementation_digest: source_sha256,
        interface: moduleInterface,
        interface_digest,
        name,
      })),
      package: 'benchmark',
      schema: 're.package-manifest@0.1.0',
    },
    schema: 're.project-manifest@0.1.0',
  })}\n`, 'utf8')
}

function validateBenchmarkInputs({
  benchmarkDirectory,
  budget,
  moduleCounts,
  profile_digest,
  sampleCount,
  toolchain_digest,
  topologies,
}) {
  if (typeof benchmarkDirectory !== 'string' || benchmarkDirectory.length === 0
    || !Array.isArray(moduleCounts) || moduleCounts.length === 0
    || moduleCounts.some((count) => !Number.isSafeInteger(count) || count < 2 || count > 5_000)
    || !Array.isArray(topologies) || topologies.length === 0
    || topologies.some((topology) => !PROJECT_BUILD_BENCHMARK_TOPOLOGIES.includes(topology))
    || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 10
    || !DIGEST.test(profile_digest) || !DIGEST.test(toolchain_digest)
    || !plainObject(budget)
    || !exactFields(budget, Object.keys(DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET))
    || Object.entries(budget).some(([field, value]) =>
      field !== 'schema'
      && (!Number.isSafeInteger(value) || value <= 0))
    || budget.schema !== BUDGET_SCHEMA) {
    throw new TypeError('invalid project build benchmark')
  }
}

function validateReportShape(report) {
  if (!plainObject(report)
    || !exactFields(report, [
      'budget',
      'budget_policy_digest',
      'environment',
      'environment_digest',
      'fixture',
      'mode',
      'profile_digest',
      'report_digest',
      'runs',
      'sample_count',
      'schema',
      'toolchain_digest',
    ])
    || report.schema !== REPORT_SCHEMA
    || !plainObject(report.environment)
    || !exactFields(report.environment, [
      'architecture',
      'node_version',
      'platform',
      'runtime',
    ])
    || report.environment.runtime !== 'node'
    || typeof report.environment.architecture !== 'string'
    || typeof report.environment.node_version !== 'string'
    || typeof report.environment.platform !== 'string'
    || !DIGEST.test(report.environment_digest)
    || report.fixture !== 'graph-first-project-directory'
    || report.mode !== 'local-node-reference'
    || !DIGEST.test(report.profile_digest)
    || !DIGEST.test(report.toolchain_digest)
    || !DIGEST.test(report.report_digest)
    || !Number.isSafeInteger(report.sample_count)
    || report.sample_count < 1
    || !Array.isArray(report.runs)
    || !plainObject(report.budget)
    || !exactFields(report.budget, Object.keys(DEFAULT_PROJECT_BUILD_BENCHMARK_BUDGET))
    || Object.entries(report.budget).some(([field, value]) =>
      field !== 'schema'
      && (!Number.isSafeInteger(value) || value <= 0))
    || report.budget.schema !== BUDGET_SCHEMA) {
    throw new TypeError('invalid project build benchmark')
  }
}

function stableReportContent(report) {
  return {
    budget: report.budget,
    budget_policy_digest: report.budget_policy_digest,
    environment: report.environment,
    environment_digest: report.environment_digest,
    fixture: report.fixture,
    mode: report.mode,
    profile_digest: report.profile_digest,
    runs: report.runs.map((run) => ({
      module_count: run.module_count,
      samples_digest: run.samples_digest,
      topology: run.topology,
      topology_digest: run.topology_digest,
    })),
    sample_count: report.sample_count,
    schema: report.schema,
    toolchain_digest: report.toolchain_digest,
  }
}

function currentEnvironment() {
  return {
    architecture: process.arch,
    node_version: process.version,
    platform: process.platform,
    runtime: 'node',
  }
}

function stableSample(sample) {
  return Object.fromEntries(Object.entries(sample).sort().map(([name, value]) => [
    name,
    {
      added_modules_count: value.added_modules_count,
      added_modules_digest: value.added_modules_digest,
      artifact_bytes: value.artifact_bytes,
      recheck_modules_count: value.recheck_modules_count,
      recheck_modules_digest: value.recheck_modules_digest,
      removed_modules_count: value.removed_modules_count,
      removed_modules_digest: value.removed_modules_digest,
      stats: value.stats,
    },
  ]))
}

function topologicalNames(topology) {
  const pending = new Map(topology.names.map((name) => [name, 0]))
  const reverse = new Map(topology.names.map((name) => [name, []]))
  for (const edge of topology.edges) {
    pending.set(edge.to, pending.get(edge.to) + 1)
    reverse.get(edge.from).push(edge.to)
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([name]) => name).sort()
  const order = []
  while (ready.length > 0) {
    const name = ready.shift()
    order.push(name)
    for (const dependent of reverse.get(name).sort()) {
      pending.set(dependent, pending.get(dependent) - 1)
      if (pending.get(dependent) === 0) {
        ready.push(dependent)
        ready.sort()
      }
    }
  }
  return order
}

function moduleNames(moduleCount, topology) {
  const width = String(moduleCount - 1).length
  const shape = topology.replace('-', '_')
  return Array.from({ length: moduleCount }, (_, index) =>
    `benchmark.${shape}.m${String(index).padStart(width, '0')}`)
}

function topologyOrder(topologies) {
  return [...new Set(topologies)].sort(
    (left, right) =>
      PROJECT_BUILD_BENCHMARK_TOPOLOGIES.indexOf(left)
      - PROJECT_BUILD_BENCHMARK_TOPOLOGIES.indexOf(right),
  )
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-canonical project benchmark value')
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, fields) {
  return Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
}
