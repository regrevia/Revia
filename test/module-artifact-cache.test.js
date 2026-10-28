import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildModulesWithArtifactCache,
  createModuleArtifact,
  createModuleArtifactCacheKey,
  readModuleArtifactCache,
  runModuleArtifactCacheBenchmark,
  verifyModuleArtifactCacheBenchmark,
  writeModuleArtifactCache,
} from '../src/toolchain/module-artifact-cache.js'
import { moduleInterfaceDigest } from '../src/toolchain/module-contract.js'

const digest = (character) => `sha256:${character.repeat(64)}`
const authority = {
  profile_digest: digest('b'),
  toolchain_digest: digest('a'),
}

test('module artifact cache key binds implementation, interfaces, dependencies, toolchain, and profile', () => {
  const manifest = chainManifest(3)
  const module = manifest.modules[1]
  const baseline = createModuleArtifactCacheKey({ ...authority, module })
  const reordered = structuredClone(module)
  reordered.interface.dependencies.reverse()

  assert.deepEqual(
    createModuleArtifactCacheKey({ ...authority, module: reordered }),
    baseline,
  )
  for (const mutate of [
    (input) => { input.module.implementation_digest = digest('c') },
    (input) => { input.module.interface_digest = digest('d') },
    (input) => { input.module.interface.dependencies[0].interface_digest = digest('e') },
    (input) => { input.toolchain_digest = digest('f') },
    (input) => { input.profile_digest = digest('1') },
  ]) {
    const input = { ...authority, module: structuredClone(module) }
    mutate(input)
    assert.notEqual(createModuleArtifactCacheKey(input).cache_key, baseline.cache_key)
  }

  const extra = structuredClone(baseline)
  extra.untrusted_claim = true
  resign(extra, 'cache_key')
  assert.throws(
    () => createModuleArtifact({ cacheKey: extra, payload: { ok: true } }),
    /invalid module artifact cache key/,
  )
})

test('module artifact cache publishes atomically and rejects corruption, stale entries, and nondeterminism', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-cache-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const key = createModuleArtifactCacheKey({
    ...authority,
    module: chainManifest(1).modules[0],
  })
  const artifact = createModuleArtifact({
    cacheKey: key,
    payload: { code: ['load', 'return'], module: key.module },
  })

  assert.deepEqual(await readModuleArtifactCache(directory, key), {
    hit: false,
    ok: true,
  })
  const [first, second] = await Promise.all([
    writeModuleArtifactCache(directory, artifact),
    writeModuleArtifactCache(directory, artifact),
  ])
  assert.deepEqual(
    [first.replayed, second.replayed].sort(),
    [false, true],
  )
  assert.deepEqual(await readModuleArtifactCache(directory, key), {
    artifact,
    hit: true,
    ok: true,
  })

  const conflicting = createModuleArtifact({
    cacheKey: key,
    payload: { code: ['different'], module: key.module },
  })
  const conflict = await writeModuleArtifactCache(directory, conflicting)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.diagnostics[0].code, 'module-artifact-cache-nondeterministic')

  const entryPath = join(directory, key.cache_key.slice('sha256:'.length), 'artifact.json')
  await writeFile(entryPath, '{"partial":', 'utf8')
  const corrupted = await readModuleArtifactCache(directory, key)
  assert.equal(corrupted.ok, false)
  assert.equal(corrupted.diagnostics[0].code, 'module-artifact-cache-corrupt')

  await rm(join(directory, key.cache_key.slice('sha256:'.length)), {
    force: true,
    recursive: true,
  })
  await mkdir(join(directory, `.tmp-${key.cache_key.slice(7)}-abandoned`))
  assert.deepEqual(await readModuleArtifactCache(directory, key), {
    hit: false,
    ok: true,
  })

  const stale = createModuleArtifactCacheKey({
    ...authority,
    module: {
      ...chainManifest(1).modules[0],
      implementation_digest: digest('9'),
    },
  })
  assert.deepEqual(await readModuleArtifactCache(directory, stale), {
    hit: false,
    ok: true,
  })
})

test('module build rejects a self-resigned payload that is not semantically equivalent', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-forgery-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const manifest = chainManifest(1)
  const module = manifest.modules[0]
  const key = createModuleArtifactCacheKey({ ...authority, module })
  const forged = createModuleArtifact({
    cacheKey: key,
    payload: {
      cache_key: key.cache_key,
      implementation_digest: digest('f'),
      module: module.name,
    },
  })
  assert.equal((await writeModuleArtifactCache(directory, forged)).ok, true)

  const result = await buildModulesWithArtifactCache({
    ...authority,
    cacheDirectory: directory,
    compile: compileModule,
    manifest,
    verify: verifyCompiledModule,
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'module-artifact-cache-semantic-mismatch')
})

test('module artifact cache reuses implementation-only builds and invalidates interface dependents', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-build-'))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const manifest = chainManifest(64)
  const cold = await buildModulesWithArtifactCache({
    ...authority,
    cacheDirectory: directory,
    compile: compileModule,
    manifest,
    verify: verifyCompiledModule,
  })
  assert.deepEqual(cold.stats, { built: 64, hits: 0, misses: 64 })
  const warm = await buildModulesWithArtifactCache({
    ...authority,
    cacheDirectory: directory,
    compile: compileModule,
    manifest,
  })
  assert.deepEqual(warm.stats, { built: 0, hits: 64, misses: 0 })

  const implementationChanged = structuredClone(manifest)
  implementationChanged.modules[32].implementation_digest = digest('e')
  const incremental = await buildModulesWithArtifactCache({
    ...authority,
    cacheDirectory: directory,
    compile: compileModule,
    manifest: implementationChanged,
    verify: verifyCompiledModule,
  })
  assert.deepEqual(incremental.stats, { built: 1, hits: 63, misses: 1 })

  const interfaceChanged = changeInterfaceFrom(manifest, 32)
  const propagated = await buildModulesWithArtifactCache({
    ...authority,
    cacheDirectory: directory,
    compile: compileModule,
    manifest: interfaceChanged,
    verify: verifyCompiledModule,
  })
  assert.deepEqual(propagated.stats, { built: 32, hits: 32, misses: 32 })
})

test('50 and 500 module benchmark records cold, warm, implementation, and interface builds', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 're-module-benchmark-'))
  context.after(() => rm(directory, { force: true, recursive: true }))

  const report = await runModuleArtifactCacheBenchmark({
    ...authority,
    cacheDirectory: directory,
    moduleCounts: [50, 500],
    sampleCount: 2,
  })

  assert.equal(report.schema, 're.module-artifact-cache-benchmark@0.1.0')
  assert.match(report.report_digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(verifyModuleArtifactCacheBenchmark(report), { ok: true })
  assert.deepEqual(report.runs.map(({ module_count }) => module_count), [50, 500])
  for (const run of report.runs) {
    assert.equal(run.samples.length, 2)
    for (const sample of run.samples) {
      assert.deepEqual(sample.cold.stats, {
        built: run.module_count,
        hits: 0,
        misses: run.module_count,
      })
      assert.deepEqual(sample.warm.stats, {
        built: 0,
        hits: run.module_count,
        misses: 0,
      })
      assert.deepEqual(sample.implementation_incremental.stats, {
        built: 1,
        hits: run.module_count - 1,
        misses: 1,
      })
      assert.deepEqual(sample.interface_incremental.stats, {
        built: Math.ceil(run.module_count / 2),
        hits: Math.floor(run.module_count / 2),
        misses: Math.ceil(run.module_count / 2),
      })
      for (const build of Object.values(sample)) {
        assert.ok(build.artifact_bytes > 0)
        assert.ok(Number.isSafeInteger(build.elapsed_ns) && build.elapsed_ns >= 0)
      }
    }
  }

  const tampered = structuredClone(report)
  tampered.runs[0].samples[0].warm.stats.hits -= 1
  assert.equal(verifyModuleArtifactCacheBenchmark(tampered).ok, false)

  const extra = structuredClone(report)
  extra.untrusted_claim = true
  resign(extra, 'report_digest')
  assert.equal(verifyModuleArtifactCacheBenchmark(extra).ok, false)
})

function chainManifest(count) {
  const width = String(count - 1).length
  const modules = []
  for (let index = 0; index < count; index += 1) {
    const previous = modules.at(-1)
    const name = `cache.m${String(index).padStart(width, '0')}`
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
        contract_digest: digest((index % 10).toString()),
        kind: 'function',
        name: 'build',
      }],
      module: name,
      schema: 're.module-interface@0.1.0',
    }
    modules.push({
      implementation_digest: digest(((index + 1) % 10).toString()),
      interface: moduleInterface,
      interface_digest: moduleInterfaceDigest(moduleInterface),
      name,
    })
  }
  return {
    external_interfaces: [],
    modules,
    package: 'cache',
    schema: 're.package-manifest@0.1.0',
  }
}

function changeInterfaceFrom(manifest, start) {
  const changed = structuredClone(manifest)
  for (let index = start; index < changed.modules.length; index += 1) {
    const module = changed.modules[index]
    if (index === start) {
      module.interface.exports[0].contract_digest = digest('f')
    } else {
      module.interface.dependencies[0].interface_digest =
        changed.modules[index - 1].interface_digest
    }
    module.interface_digest = moduleInterfaceDigest(module.interface)
  }
  return changed
}

async function compileModule({ cache_key, module }) {
  return {
    cache_key,
    implementation_digest: module.implementation_digest,
    module: module.name,
  }
}

function verifyCompiledModule(payload, { cache_key, module }) {
  return payload?.cache_key === cache_key
    && payload?.implementation_digest === module.implementation_digest
    && payload?.module === module.name
}

function resign(value, field) {
  const content = structuredClone(value)
  delete content[field]
  value[field] = `sha256:${createHash('sha256').update(canonicalJson(content)).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
