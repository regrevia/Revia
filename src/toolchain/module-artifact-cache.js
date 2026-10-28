import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { validatePackageManifest } from './module-contract.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const CACHE_KEY_SCHEMA = 're.module-artifact-cache-key@0.1.0'
const ARTIFACT_SCHEMA = 're.module-artifact@0.1.0'

export function createModuleArtifactCacheKey({
  module,
  profile_digest,
  toolchain_digest,
}) {
  if (!plainObject(module)
    || typeof module.name !== 'string'
    || !DIGEST.test(module.implementation_digest)
    || !DIGEST.test(module.interface_digest)
    || !Array.isArray(module.interface?.dependencies)
    || !DIGEST.test(profile_digest)
    || !DIGEST.test(toolchain_digest)) {
    throw new TypeError('invalid module artifact cache key')
  }
  const dependencies = module.interface.dependencies.map((dependency) => {
    if (!plainObject(dependency)
      || typeof dependency.binding !== 'string'
      || typeof dependency.module !== 'string'
      || !['external', 'package'].includes(dependency.scope)
      || !DIGEST.test(dependency.interface_digest)
      || (dependency.scope === 'external' && !DIGEST.test(dependency.package_digest))) {
      throw new TypeError('invalid module artifact cache dependency')
    }
    return {
      binding: dependency.binding,
      interface_digest: dependency.interface_digest,
      module: dependency.module,
      ...(dependency.scope === 'external'
        ? { package_digest: dependency.package_digest }
        : {}),
      scope: dependency.scope,
    }
  }).sort(compareDependency)
  const content = {
    dependencies,
    implementation_digest: module.implementation_digest,
    interface_digest: module.interface_digest,
    module: module.name,
    profile_digest,
    schema: CACHE_KEY_SCHEMA,
    toolchain_digest,
  }
  return {
    ...content,
    cache_key: digest(content),
  }
}

export function createModuleArtifact({ cacheKey, payload }) {
  validateCacheKey(cacheKey)
  const payloadSnapshot = snapshotCanonical(payload)
  const content = {
    cache_key: cacheKey.cache_key,
    key: snapshotCanonical(cacheKey),
    payload: payloadSnapshot,
    payload_digest: digest(payloadSnapshot),
    schema: ARTIFACT_SCHEMA,
  }
  return {
    ...content,
    artifact_digest: digest(content),
  }
}

export async function readModuleArtifactCache(cacheDirectory, cacheKey) {
  try {
    validateCacheDirectory(cacheDirectory)
    validateCacheKey(cacheKey)
    const path = artifactPath(cacheDirectory, cacheKey.cache_key)
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { hit: false, ok: true }
      throw error
    }
    let artifact
    try {
      artifact = JSON.parse(source)
      validateArtifact(artifact, cacheKey)
    } catch {
      return rejected('module-artifact-cache-corrupt')
    }
    return {
      artifact,
      hit: true,
      ok: true,
    }
  } catch {
    return rejected('module-artifact-cache-read-failure')
  }
}

export async function writeModuleArtifactCache(cacheDirectory, artifact) {
  let temporaryDirectory = null
  try {
    validateCacheDirectory(cacheDirectory)
    validateArtifact(artifact, artifact.key)
    await mkdir(cacheDirectory, { recursive: true })
    const key = artifact.cache_key.slice('sha256:'.length)
    const finalDirectory = join(cacheDirectory, key)
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    temporaryDirectory = join(cacheDirectory, `.tmp-${key}-${nonce}`)
    await mkdir(temporaryDirectory)
    await writeFile(
      join(temporaryDirectory, 'artifact.json'),
      `${canonicalJson(artifact)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    try {
      await rename(temporaryDirectory, finalDirectory)
      temporaryDirectory = null
      return { ok: true, replayed: false }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
    }
    const existing = await readModuleArtifactCache(cacheDirectory, artifact.key)
    if (!existing.ok) return existing
    if (!existing.hit || canonicalJson(existing.artifact) !== canonicalJson(artifact)) {
      return rejected('module-artifact-cache-nondeterministic')
    }
    return { ok: true, replayed: true }
  } catch {
    return rejected('module-artifact-cache-write-failure')
  } finally {
    if (temporaryDirectory !== null) {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => {})
    }
  }
}

export async function buildModulesWithArtifactCache({
  cacheDirectory,
  compile,
  manifest,
  profile_digest,
  toolchain_digest,
  verify = null,
}) {
  const validation = validatePackageManifest(manifest)
  if (!validation.ok) return validation
  if (typeof compile !== 'function') {
    return rejected('invalid-module-artifact-compiler')
  }
  const artifacts = []
  const stats = { built: 0, hits: 0, misses: 0 }
  const modulesByName = new Map(manifest.modules.map((module) => [
    module.name,
    module,
  ]))
  for (const name of topologicalOrder(manifest.modules)) {
    const module = modulesByName.get(name)
    let key
    try {
      key = createModuleArtifactCacheKey({
        module,
        profile_digest,
        toolchain_digest,
      })
    } catch {
      return rejected('invalid-module-artifact-cache-key')
    }
    const cached = await readModuleArtifactCache(cacheDirectory, key)
    if (!cached.ok) return cached
    if (cached.hit) {
      if (!verifyArtifact(verify, cached.artifact.payload, key.cache_key, module)) {
        return rejected('module-artifact-cache-semantic-mismatch')
      }
      stats.hits += 1
      artifacts.push(cached.artifact)
      continue
    }
    stats.misses += 1
    let payload
    try {
      payload = await compile({
        cache_key: key.cache_key,
        module: snapshotCanonical(module),
      })
    } catch {
      return rejected('module-artifact-compile-failure')
    }
    let artifact
    try {
      artifact = createModuleArtifact({ cacheKey: key, payload })
    } catch {
      return rejected('invalid-module-artifact')
    }
    if (!verifyArtifact(verify, artifact.payload, key.cache_key, module)) {
      return rejected('module-artifact-cache-semantic-mismatch')
    }
    const written = await writeModuleArtifactCache(cacheDirectory, artifact)
    if (!written.ok) return written
    stats.built += written.replayed ? 0 : 1
    stats.hits += written.replayed ? 1 : 0
    artifacts.push(artifact)
  }
  return {
    artifacts,
    ok: true,
    stats,
  }
}

export async function runModuleArtifactCacheBenchmark({
  cacheDirectory,
  moduleCounts = [50, 500],
  profile_digest,
  sampleCount = 3,
  toolchain_digest,
}) {
  if (!Array.isArray(moduleCounts)
    || moduleCounts.length === 0
    || moduleCounts.some((count) => !Number.isSafeInteger(count) || count < 2 || count > 5_000)
    || !Number.isSafeInteger(sampleCount)
    || sampleCount < 1
    || sampleCount > 100
    || !DIGEST.test(profile_digest)
    || !DIGEST.test(toolchain_digest)) {
    throw new TypeError('invalid module artifact cache benchmark')
  }
  const runs = []
  for (const moduleCount of [...moduleCounts].sort((left, right) => left - right)) {
    const samples = []
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const sampleDirectory = join(cacheDirectory, `${moduleCount}-${sample}`)
      await rm(sampleDirectory, { force: true, recursive: true })
      const manifest = benchmarkManifest(moduleCount)
      const compile = async ({ cache_key, module }) => ({
        cache_key,
        implementation_digest: module.implementation_digest,
        module: module.name,
      })
      const cold = await measuredBuild({
        cacheDirectory: sampleDirectory,
        compile,
        manifest,
        profile_digest,
        toolchain_digest,
        verify: verifyBenchmarkModule,
      })
      const warm = await measuredBuild({
        cacheDirectory: sampleDirectory,
        compile,
        manifest,
        profile_digest,
        toolchain_digest,
        verify: verifyBenchmarkModule,
      })
      const implementationManifest = structuredClone(manifest)
      const changedIndex = Math.floor(moduleCount / 2)
      implementationManifest.modules[changedIndex].implementation_digest = fixedDigest('implementation-change')
      const implementationIncremental = await measuredBuild({
        cacheDirectory: sampleDirectory,
        compile,
        manifest: implementationManifest,
        profile_digest,
        toolchain_digest,
        verify: verifyBenchmarkModule,
      })
      const interfaceIncremental = await measuredBuild({
        cacheDirectory: sampleDirectory,
        compile,
        manifest: changeBenchmarkInterface(manifest, changedIndex),
        profile_digest,
        toolchain_digest,
        verify: verifyBenchmarkModule,
      })
      samples.push({
        cold,
        implementation_incremental: implementationIncremental,
        interface_incremental: interfaceIncremental,
        warm,
      })
    }
    runs.push({
      module_count: moduleCount,
      samples,
      samples_digest: digest(samples),
    })
  }
  const report = {
    cache_schema: ARTIFACT_SCHEMA,
    fixture: 'linear-package-dag',
    mode: 'local-node-reference',
    profile_digest,
    runs,
    sample_count: sampleCount,
    schema: 're.module-artifact-cache-benchmark@0.1.0',
    toolchain_digest,
  }
  return {
    ...report,
    report_digest: digest(report),
  }
}

export function verifyModuleArtifactCacheBenchmark(report) {
  try {
    if (!plainObject(report)
      || !exactFields(report, [
        'cache_schema',
        'fixture',
        'mode',
        'profile_digest',
        'report_digest',
        'runs',
        'sample_count',
        'schema',
        'toolchain_digest',
      ])
      || report.schema !== 're.module-artifact-cache-benchmark@0.1.0'
      || report.cache_schema !== ARTIFACT_SCHEMA
      || report.fixture !== 'linear-package-dag'
      || report.mode !== 'local-node-reference'
      || !DIGEST.test(report.profile_digest)
      || !DIGEST.test(report.toolchain_digest)
      || !Number.isSafeInteger(report.sample_count)
      || report.sample_count < 1
      || !Array.isArray(report.runs)
      || report.runs.length === 0
      || !DIGEST.test(report.report_digest)) {
      throw new TypeError('invalid module artifact cache benchmark')
    }
    const { report_digest, ...content } = report
    if (report_digest !== digest(content)) throw new TypeError('module artifact cache benchmark digest mismatch')
    const counts = new Set()
    for (const run of report.runs) {
      if (!plainObject(run)
        || !exactFields(run, ['module_count', 'samples', 'samples_digest'])
        || !Number.isSafeInteger(run.module_count)
        || run.module_count < 2
        || counts.has(run.module_count)
        || !Array.isArray(run.samples)
        || run.samples.length !== report.sample_count
        || !DIGEST.test(run.samples_digest)
        || run.samples_digest !== digest(run.samples)) {
        throw new TypeError('invalid module artifact cache benchmark run')
      }
      counts.add(run.module_count)
      for (const sample of run.samples) {
        if (!plainObject(sample)
          || !exactFields(sample, [
            'cold',
            'implementation_incremental',
            'interface_incremental',
            'warm',
          ])) {
          throw new TypeError('invalid module artifact cache benchmark sample')
        }
        const expected = {
          cold: { built: run.module_count, hits: 0, misses: run.module_count },
          implementation_incremental: {
            built: 1,
            hits: run.module_count - 1,
            misses: 1,
          },
          interface_incremental: {
            built: Math.ceil(run.module_count / 2),
            hits: Math.floor(run.module_count / 2),
            misses: Math.ceil(run.module_count / 2),
          },
          warm: { built: 0, hits: run.module_count, misses: 0 },
        }
        for (const [name, build] of Object.entries(sample)) {
          if (!plainObject(build)
            || !exactFields(build, ['artifact_bytes', 'elapsed_ns', 'stats'])
            || !plainObject(build.stats)
            || !exactFields(build.stats, ['built', 'hits', 'misses'])
            || !['built', 'hits', 'misses'].every((field) =>
              Number.isSafeInteger(build.stats[field]) && build.stats[field] >= 0)
            || canonicalJson(build.stats) !== canonicalJson(expected[name])
            || !Number.isSafeInteger(build.artifact_bytes)
            || build.artifact_bytes <= 0
            || !Number.isSafeInteger(build.elapsed_ns)
            || build.elapsed_ns < 0) {
            throw new TypeError('invalid module artifact cache benchmark sample')
          }
        }
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-module-artifact-cache-benchmark',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

async function measuredBuild(options) {
  const start = process.hrtime.bigint()
  const result = await buildModulesWithArtifactCache(options)
  const elapsed = process.hrtime.bigint() - start
  if (!result.ok) throw new TypeError(result.diagnostics[0].code)
  return {
    artifact_bytes: Buffer.byteLength(JSON.stringify(result.artifacts)),
    elapsed_ns: Number(elapsed),
    stats: result.stats,
  }
}

function verifyBenchmarkModule(payload, { cache_key, module }) {
  return payload?.cache_key === cache_key
    && payload?.implementation_digest === module.implementation_digest
    && payload?.module === module.name
}

function verifyArtifact(verify, payload, cacheKey, module) {
  if (verify === null) return true
  if (typeof verify !== 'function') return false
  try {
    return verify(payload, {
      cache_key: cacheKey,
      module: snapshotCanonical(module),
    }) === true
  } catch {
    return false
  }
}

function validateCacheKey(key) {
  if (!plainObject(key)
    || !exactFields(key, [
      'cache_key',
      'dependencies',
      'implementation_digest',
      'interface_digest',
      'module',
      'profile_digest',
      'schema',
      'toolchain_digest',
    ])
    || key.schema !== CACHE_KEY_SCHEMA
    || typeof key.module !== 'string'
    || !Array.isArray(key.dependencies)
    || key.dependencies.some((dependency) =>
      !plainObject(dependency)
      || !exactFields(
        dependency,
        dependency.scope === 'external'
          ? ['binding', 'interface_digest', 'module', 'package_digest', 'scope']
          : ['binding', 'interface_digest', 'module', 'scope'],
      )
      || typeof dependency.binding !== 'string'
      || typeof dependency.module !== 'string'
      || !['external', 'package'].includes(dependency.scope)
      || !DIGEST.test(dependency.interface_digest)
      || (dependency.scope === 'external' && !DIGEST.test(dependency.package_digest)))
    || !DIGEST.test(key.implementation_digest)
    || !DIGEST.test(key.interface_digest)
    || !DIGEST.test(key.profile_digest)
    || !DIGEST.test(key.toolchain_digest)
    || !DIGEST.test(key.cache_key)) {
    throw new TypeError('invalid module artifact cache key')
  }
  const { cache_key, ...content } = key
  if (cache_key !== digest(content)) {
    throw new TypeError('module artifact cache key digest mismatch')
  }
}

function validateArtifact(artifact, expectedKey) {
  validateCacheKey(expectedKey)
  if (!plainObject(artifact)
    || !exactFields(artifact, [
      'artifact_digest',
      'cache_key',
      'key',
      'payload',
      'payload_digest',
      'schema',
    ])
    || artifact.schema !== ARTIFACT_SCHEMA
    || artifact.cache_key !== expectedKey.cache_key
    || !plainObject(artifact.key)
    || canonicalJson(artifact.key) !== canonicalJson(expectedKey)
    || !DIGEST.test(artifact.payload_digest)
    || !DIGEST.test(artifact.artifact_digest)
    || artifact.payload_digest !== digest(artifact.payload)) {
    throw new TypeError('invalid module artifact')
  }
  const { artifact_digest, ...content } = artifact
  if (artifact_digest !== digest(content)) {
    throw new TypeError('module artifact digest mismatch')
  }
}

function artifactPath(cacheDirectory, cacheKey) {
  return join(cacheDirectory, cacheKey.slice('sha256:'.length), 'artifact.json')
}

function validateCacheDirectory(cacheDirectory) {
  if (typeof cacheDirectory !== 'string' || cacheDirectory.length === 0) {
    throw new TypeError('invalid module artifact cache directory')
  }
}

function compareDependency(left, right) {
  return compareText(canonicalJson(left), canonicalJson(right))
}

function topologicalOrder(modules) {
  const byName = new Map(modules.map((module) => [module.name, module]))
  const pending = new Map(modules.map((module) => [
    module.name,
    module.interface.dependencies.filter(
      (dependency) => dependency.scope === 'package' && byName.has(dependency.module),
    ).length,
  ]))
  const reverse = new Map(modules.map((module) => [module.name, []]))
  for (const module of modules) {
    for (const dependency of module.interface.dependencies) {
      if (dependency.scope === 'package' && reverse.has(dependency.module)) {
        reverse.get(dependency.module).push(module.name)
      }
    }
  }
  const ready = [...pending]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
  heapify(ready)
  const order = []
  while (ready.length > 0) {
    const name = heapPop(ready)
    order.push(name)
    for (const dependent of reverse.get(name).sort(compareText)) {
      const count = pending.get(dependent) - 1
      pending.set(dependent, count)
      if (count === 0) heapPush(ready, dependent)
    }
  }
  return order
}

function heapify(values) {
  for (let index = Math.floor(values.length / 2) - 1; index >= 0; index -= 1) {
    heapDown(values, index)
  }
}

function heapPush(values, value) {
  values.push(value)
  let index = values.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (compareText(values[parent], value) <= 0) break
    values[index] = values[parent]
    index = parent
  }
  values[index] = value
}

function heapPop(values) {
  const first = values[0]
  const last = values.pop()
  if (values.length > 0) {
    values[0] = last
    heapDown(values, 0)
  }
  return first
}

function heapDown(values, start) {
  let index = start
  const value = values[index]
  while (true) {
    const left = index * 2 + 1
    if (left >= values.length) break
    const right = left + 1
    let child = left
    if (right < values.length && compareText(values[right], values[left]) < 0) {
      child = right
    }
    if (compareText(values[child], value) >= 0) break
    values[index] = values[child]
    index = child
  }
  values[index] = value
}

function benchmarkManifest(count) {
  const width = String(count - 1).length
  const modules = []
  for (let index = 0; index < count; index += 1) {
    const previous = modules.at(-1)
    const name = `benchmark.m${String(index).padStart(width, '0')}`
    const moduleInterface = {
      dependencies: previous === undefined
        ? []
        : [{
          binding: 'previous',
          interface_digest: previous.interface_digest,
          module: previous.name,
          scope: 'package',
        }],
      exports: [{
        contract_digest: fixedDigest(`contract-${index}`),
        kind: 'function',
        name: 'build',
      }],
      module: name,
      schema: 're.module-interface@0.1.0',
    }
    modules.push({
      implementation_digest: fixedDigest(`implementation-${index}`),
      interface: moduleInterface,
      interface_digest: digest(normalizeModuleInterface(moduleInterface)),
      name,
    })
  }
  return {
    external_interfaces: [],
    modules,
    package: 'benchmark',
    schema: 're.package-manifest@0.1.0',
  }
}

function changeBenchmarkInterface(manifest, start) {
  const changed = structuredClone(manifest)
  for (let index = start; index < changed.modules.length; index += 1) {
    const module = changed.modules[index]
    if (index === start) {
      module.interface.exports[0].contract_digest = fixedDigest('interface-change')
    } else {
      module.interface.dependencies[0].interface_digest =
        changed.modules[index - 1].interface_digest
    }
    module.interface_digest = digest(normalizeModuleInterface(module.interface))
  }
  return changed
}

function normalizeModuleInterface(moduleInterface) {
  return {
    dependencies: [...moduleInterface.dependencies].sort(compareDependency),
    exports: [...moduleInterface.exports].sort(
      (left, right) => compareText(left.name, right.name),
    ),
    module: moduleInterface.module,
    schema: moduleInterface.schema,
  }
}

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function snapshotCanonical(value) {
  return JSON.parse(canonicalJson(value))
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-canonical module artifact value')
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value, fields) {
  return Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
}

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function rejected(code) {
  return {
    diagnostics: [{ code }],
    ok: false,
  }
}
