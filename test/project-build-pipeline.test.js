import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  moduleInterfaceDigest,
} from '../src/toolchain/module-contract.js'
import {
  buildProjectWithArtifactCache,
  createProjectBuildKey,
  createProjectBuildManifest,
  readProjectBuildManifest,
  writeProjectBuildManifest,
} from '../src/toolchain/project-build-pipeline.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'

const authority = {
  profile_digest: fixedDigest('profile'),
  toolchain_digest: fixedDigest('toolchain'),
}

test('project build publishes only a complete path-free manifest and reuses a warm graph', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))

  const cold = await build(fixture)
  assert.equal(cold.ok, true, JSON.stringify(cold))
  assert.deepEqual(cold.stats, { built: 2, hits: 0, misses: 2 })
  assert.deepEqual(cold.invalidation, {
    added_modules: ['agent.demo.core', 'agent.demo.api'],
    modules: ['agent.demo.core', 'agent.demo.api'],
    removed_modules: [],
  })
  assert.equal(JSON.stringify(cold.manifest).includes(fixture.root), false)

  const warm = await build(fixture, { previousManifest: cold.manifest })
  assert.equal(warm.ok, true)
  assert.deepEqual(warm.stats, { built: 0, hits: 2, misses: 0 })
  assert.deepEqual(warm.invalidation.modules, [])
  assert.deepEqual(warm.manifest, cold.manifest)
  assert.equal(warm.published, false)
  assert.deepEqual(await readProjectBuildManifest(
    fixture.buildDirectory,
    cold.manifest.key,
  ), {
    found: true,
    manifest: cold.manifest,
    ok: true,
  })
})

test('project build computes minimal implementation and interface invalidation', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)

  await updateImplementation(fixture, 'agent.demo.core')
  const implementation = await build(fixture, {
    previousManifest: baseline.manifest,
  })
  assert.equal(implementation.ok, true, JSON.stringify(implementation))
  assert.deepEqual(implementation.stats, { built: 1, hits: 1, misses: 1 })
  assert.deepEqual(implementation.invalidation.modules, ['agent.demo.core'])

  await updateCoreInterface(fixture)
  const interfaceBuild = await build(fixture, {
    previousManifest: implementation.manifest,
  })
  assert.equal(interfaceBuild.ok, true)
  assert.deepEqual(interfaceBuild.stats, { built: 2, hits: 0, misses: 2 })
  assert.deepEqual(interfaceBuild.invalidation.modules, [
    'agent.demo.core',
    'agent.demo.api',
  ])
})

test('project build closes add, delete, rename, and orphan artifact authority', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)

  await addModule(fixture)
  const added = await build(fixture, { previousManifest: baseline.manifest })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.deepEqual(added.invalidation.added_modules, ['agent.demo.worker'])
  assert.equal(added.manifest.modules.length, 3)

  await removeModule(fixture, 'agent.demo.worker')
  const removed = await build(fixture, { previousManifest: added.manifest })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.invalidation.removed_modules, ['agent.demo.worker'])
  assert.equal(removed.manifest.modules.length, 2)

  await renameCore(fixture)
  const renamed = await build(fixture, { previousManifest: removed.manifest })
  assert.equal(renamed.ok, true)
  assert.deepEqual(renamed.invalidation.added_modules, ['agent.demo.foundation'])
  assert.deepEqual(renamed.invalidation.removed_modules, ['agent.demo.core'])
  assert.deepEqual(
    renamed.manifest.modules.map(({ module }) => module),
    ['agent.demo.foundation', 'agent.demo.api'],
  )
})

test('project build failure never publishes a partial manifest', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)
  await updateImplementation(fixture, 'agent.demo.api')
  const changedGraph = await loadProjectDirectory(fixture.projectDirectory)
  assert.equal(changedGraph.ok, true)
  const changedKey = createProjectBuildKey({
    graph: changedGraph.value,
    ...authority,
  })

  const failed = await build(fixture, {
    compile: async (input) => {
      if (input.module.name === 'agent.demo.api') throw new Error('compile fault')
      return compileModule(input)
    },
    previousManifest: baseline.manifest,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.diagnostics[0].code, 'module-artifact-compile-failure')
  assert.deepEqual(await readProjectBuildManifest(
    fixture.buildDirectory,
    baseline.manifest.key,
  ), {
    found: true,
    manifest: baseline.manifest,
    ok: true,
  })
  assert.deepEqual(await readProjectBuildManifest(
    fixture.buildDirectory,
    changedKey,
  ), {
    found: false,
    ok: true,
  })
})

test('project build requires semantic verification and rejects corrupt current cache', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)

  const missingVerifier = await buildProjectWithArtifactCache({
    ...authority,
    buildDirectory: fixture.buildDirectory,
    cacheDirectory: fixture.cacheDirectory,
    compile: compileModule,
    projectDirectory: fixture.projectDirectory,
  })
  assert.equal(missingVerifier.ok, false)
  assert.equal(missingVerifier.diagnostics[0].code, 'invalid-project-build-compiler')

  const cacheKey = baseline.manifest.modules[0].cache_key.slice(7)
  await writeFile(
    join(fixture.cacheDirectory, cacheKey, 'artifact.json'),
    '{"partial":',
    'utf8',
  )
  const corrupted = await build(fixture, { previousManifest: baseline.manifest })
  assert.equal(corrupted.ok, false)
  assert.equal(corrupted.diagnostics[0].code, 'module-artifact-cache-corrupt')
})

test('project build rejects verifier failure and uncommitted previous manifest authority', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)

  const rejectedByVerifier = await build(fixture, {
    cacheDirectory: join(fixture.root, 'empty-cache'),
    verify: () => false,
  })
  assert.equal(rejectedByVerifier.ok, false)
  assert.equal(
    rejectedByVerifier.diagnostics[0].code,
    'module-artifact-cache-semantic-mismatch',
  )

  const resigned = structuredClone(baseline.manifest)
  resigned.modules[0].artifact_digest = fixedDigest('forged-artifact')
  resigned.manifest_digest = canonicalDigest(withoutField(
    resigned,
    'manifest_digest',
  ))
  const rejectedPrevious = await build(fixture, {
    previousManifest: resigned,
  })
  assert.equal(rejectedPrevious.ok, false)
  assert.equal(
    rejectedPrevious.diagnostics[0].code,
    'project-build-previous-manifest-mismatch',
  )
})

test('project build invalidates dependency edges, package pins, toolchain, and profile', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const baseline = await build(fixture)

  await addExternalDependency(fixture, fixedDigest('external-package-v1'))
  const dependency = await build(fixture, { previousManifest: baseline.manifest })
  assert.equal(dependency.ok, true, JSON.stringify(dependency))
  assert.deepEqual(dependency.invalidation.modules, ['agent.demo.api'])
  assert.deepEqual(dependency.stats, { built: 1, hits: 1, misses: 1 })

  await updateExternalPackagePin(fixture, fixedDigest('external-package-v2'))
  const packagePin = await build(fixture, {
    previousManifest: dependency.manifest,
  })
  assert.equal(packagePin.ok, true, JSON.stringify(packagePin))
  assert.deepEqual(packagePin.invalidation.modules, ['agent.demo.api'])
  assert.deepEqual(packagePin.stats, { built: 1, hits: 1, misses: 1 })

  const toolchain = await build(fixture, {
    previousManifest: packagePin.manifest,
    toolchain_digest: fixedDigest('toolchain-v2'),
  })
  assert.equal(toolchain.ok, true)
  assert.deepEqual(toolchain.invalidation.modules, [
    'agent.demo.core',
    'agent.demo.api',
  ])
  assert.deepEqual(toolchain.stats, { built: 2, hits: 0, misses: 2 })

  const profile = await build(fixture, {
    previousManifest: toolchain.manifest,
    profile_digest: fixedDigest('profile-v2'),
    toolchain_digest: fixedDigest('toolchain-v2'),
  })
  assert.equal(profile.ok, true)
  assert.deepEqual(profile.invalidation.modules, [
    'agent.demo.core',
    'agent.demo.api',
  ])
  assert.deepEqual(profile.stats, { built: 2, hits: 0, misses: 2 })
})

test('project build manifest rejects corruption and concurrent conflicting publication', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const graphResult = await loadProjectDirectory(fixture.projectDirectory)
  assert.equal(graphResult.ok, true)
  const graph = graphResult.value
  const buildKey = createProjectBuildKey({ graph, ...authority })
  const left = createProjectBuildManifest({
    artifacts: syntheticArtifacts(graph, 'left'),
    buildKey,
    graph,
  })
  const right = createProjectBuildManifest({
    artifacts: syntheticArtifacts(graph, 'right'),
    buildKey,
    graph,
  })

  const results = await Promise.all([
    writeProjectBuildManifest(fixture.buildDirectory, left),
    writeProjectBuildManifest(fixture.buildDirectory, right),
  ])
  assert.equal(results.filter(({ ok }) => ok).length, 1)
  assert.ok(results.some((result) =>
    result.diagnostics?.[0]?.code === 'project-build-manifest-nondeterministic'))

  const manifestPath = join(
    fixture.buildDirectory,
    buildKey.build_key.slice(7),
    'build.json',
  )
  await writeFile(manifestPath, '{"partial":', 'utf8')
  const corrupted = await readProjectBuildManifest(
    fixture.buildDirectory,
    buildKey,
  )
  assert.equal(corrupted.ok, false)
  assert.equal(
    corrupted.diagnostics[0].code,
    'project-build-manifest-corrupt',
  )
})

test('concurrent identical project builds replay and conflicting payloads fail closed', async (context) => {
  const fixture = await createProjectFixture()
  context.after(() => rm(fixture.root, { force: true, recursive: true }))
  const identical = await Promise.all([build(fixture), build(fixture)])
  assert.equal(identical.every(({ ok }) => ok), true)
  assert.deepEqual(
    identical.map(({ published }) => published).sort(),
    [false, true],
  )

  const conflictFixture = await createProjectFixture()
  context.after(() => rm(conflictFixture.root, { force: true, recursive: true }))
  const results = await Promise.all([
    build(conflictFixture, {
      compile: (input) => compileModule(input, 'left'),
    }),
    build(conflictFixture, {
      compile: (input) => compileModule(input, 'right'),
    }),
  ])
  assert.equal(results.filter(({ ok }) => ok).length, 1)
  assert.ok(results.some((result) =>
    result.diagnostics?.[0]?.code === 'module-artifact-cache-nondeterministic'))
})

async function build(fixture, overrides = {}) {
  return buildProjectWithArtifactCache({
    ...authority,
    buildDirectory: fixture.buildDirectory,
    cacheDirectory: fixture.cacheDirectory,
    compile: compileModule,
    projectDirectory: fixture.projectDirectory,
    verify: verifyModule,
    ...overrides,
  })
}

function compileModule({ cache_key, module }, variant = 'canonical') {
  return {
    cache_key,
    implementation_digest: module.implementation_digest,
    interface_digest: module.interface_digest,
    module: module.name,
    variant,
  }
}

function verifyModule(payload, { cache_key, module }) {
  return payload?.cache_key === cache_key
    && payload?.implementation_digest === module.implementation_digest
    && payload?.interface_digest === module.interface_digest
    && payload?.module === module.name
    && typeof payload?.variant === 'string'
}

async function createProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), 're-project-build-'))
  const projectDirectory = join(root, 'project')
  const cacheDirectory = join(root, 'cache')
  const buildDirectory = join(root, 'builds')
  await mkdir(join(projectDirectory, 'modules'), { recursive: true })
  const core = moduleRecord('agent.demo.core', 'normalize')
  const api = moduleRecord('agent.demo.api', 'serve', core)
  await writeProject(projectDirectory, [core, api])
  return { buildDirectory, cacheDirectory, projectDirectory, root }
}

function moduleRecord(name, exported, dependency = null) {
  const moduleInterface = {
    dependencies: dependency === null ? [] : [{
      binding: 'dependency',
      interface_digest: dependency.interface_digest,
      module: dependency.name,
      scope: 'package',
    }],
    exports: [{
      contract_digest: fixedDigest(`${name}-${exported}`),
      kind: 'function',
      name: exported,
    }],
    module: name,
    schema: 're.module-interface@0.1.0',
  }
  const source = [
    're 1.0 compact',
    `module ${name}`,
    ...(dependency === null ? [] : [
      `import ${dependency.name}@${dependency.interface_digest} as dependency`,
    ]),
    `export ${exported}`,
    '',
  ].join('\n')
  return {
    interface: moduleInterface,
    interface_digest: moduleInterfaceDigest(moduleInterface),
    name,
    path: `modules/${name.split('.').at(-1)}.re`,
    source,
    source_sha256: sourceDigest(source),
  }
}

async function writeProject(projectDirectory, records, externalInterfaces = []) {
  const manifest = {
    modules: records.map(({ name, path, source_sha256 }) => ({
      name, path, source_sha256,
    })),
    package_manifest: {
      external_interfaces: externalInterfaces,
      modules: records.map(({ interface: moduleInterface, interface_digest, name, source_sha256 }) => ({
        implementation_digest: source_sha256,
        interface: moduleInterface,
        interface_digest,
        name,
      })),
      package: 'agent.demo',
      schema: 're.package-manifest@0.1.0',
    },
    schema: 're.project-manifest@0.1.0',
  }
  const modulesDirectory = join(projectDirectory, 'modules')
  await mkdir(modulesDirectory, { recursive: true })
  const existing = await readFileNames(modulesDirectory)
  for (const file of existing) await rm(join(modulesDirectory, file), { force: true })
  for (const record of records) {
    await writeFile(join(projectDirectory, record.path), record.source)
  }
  await writeFile(join(projectDirectory, 'project.json'), `${JSON.stringify(manifest)}\n`)
}

async function readRecords(fixture) {
  const manifest = JSON.parse(await readFile(
    join(fixture.projectDirectory, 'project.json'),
    'utf8',
  ))
  return Promise.all(manifest.modules.map(async (entry) => {
    const packageModule = manifest.package_manifest.modules.find(
      ({ name }) => name === entry.name,
    )
    return {
      interface: packageModule.interface,
      interface_digest: packageModule.interface_digest,
      name: entry.name,
      path: entry.path,
      source: await readFile(join(fixture.projectDirectory, entry.path), 'utf8'),
      source_sha256: entry.source_sha256,
    }
  }))
}

async function updateImplementation(fixture, name) {
  const records = await readRecords(fixture)
  const record = records.find((candidate) => candidate.name === name)
  record.source += '\n'
  record.source_sha256 = sourceDigest(record.source)
  await writeProject(fixture.projectDirectory, records)
}

async function updateCoreInterface(fixture) {
  const records = await readRecords(fixture)
  const core = records[0]
  core.interface.exports[0].contract_digest = fixedDigest('changed-interface')
  core.interface.exports[0].name = 'normalize_changed'
  core.interface_digest = moduleInterfaceDigest(core.interface)
  core.source = core.source.replace('export normalize', 'export normalize_changed')
  core.source_sha256 = sourceDigest(core.source)
  const api = records[1]
  api.interface.dependencies[0].interface_digest = core.interface_digest
  api.interface_digest = moduleInterfaceDigest(api.interface)
  api.source = api.source.replace(
    /agent\.demo\.core@sha256:[0-9a-f]{64}/u,
    `agent.demo.core@${core.interface_digest}`,
  )
  api.source_sha256 = sourceDigest(api.source)
  await writeProject(fixture.projectDirectory, records)
}

async function addExternalDependency(fixture, packageDigest) {
  const records = await readRecords(fixture)
  const api = records.find(({ name }) => name === 'agent.demo.api')
  const external = moduleInterface('std.log', 'write')
  const interfaceDigest = moduleInterfaceDigest(external)
  api.interface.dependencies.push({
    binding: 'log',
    interface_digest: interfaceDigest,
    module: external.module,
    package_digest: packageDigest,
    scope: 'external',
  })
  api.interface_digest = moduleInterfaceDigest(api.interface)
  api.source = api.source.replace(
    'export serve',
    `import external std.log@${interfaceDigest} from ${packageDigest} as log\nexport serve`,
  )
  api.source_sha256 = sourceDigest(api.source)
  await writeProject(fixture.projectDirectory, records, [{
    interface: external,
    interface_digest: interfaceDigest,
    module: external.module,
    package_digest: packageDigest,
  }])
}

async function updateExternalPackagePin(fixture, packageDigest) {
  const manifestPath = join(fixture.projectDirectory, 'project.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const external = manifest.package_manifest.external_interfaces[0]
  const previous = external.package_digest
  external.package_digest = packageDigest
  const api = manifest.package_manifest.modules.find(
    ({ name }) => name === 'agent.demo.api',
  )
  api.interface.dependencies.find(
    ({ scope }) => scope === 'external',
  ).package_digest = packageDigest
  api.interface_digest = moduleInterfaceDigest(api.interface)
  const projectApi = manifest.modules.find(({ name }) => name === 'agent.demo.api')
  const sourcePath = join(fixture.projectDirectory, projectApi.path)
  const source = (await readFile(sourcePath, 'utf8')).replace(previous, packageDigest)
  projectApi.source_sha256 = sourceDigest(source)
  api.implementation_digest = projectApi.source_sha256
  await writeFile(sourcePath, source)
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
}

async function addModule(fixture) {
  const records = await readRecords(fixture)
  records.push(moduleRecord('agent.demo.worker', 'work', records[0]))
  await writeProject(fixture.projectDirectory, records)
}

async function removeModule(fixture, name) {
  const records = (await readRecords(fixture)).filter(
    (record) => record.name !== name,
  )
  await writeProject(fixture.projectDirectory, records)
}

async function renameCore(fixture) {
  const records = await readRecords(fixture)
  const renamed = moduleRecord('agent.demo.foundation', 'normalize')
  const api = moduleRecord('agent.demo.api', 'serve', renamed)
  await writeProject(fixture.projectDirectory, [renamed, api])
}

async function readFileNames(directory) {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

function moduleInterface(module, exported) {
  return {
    dependencies: [],
    exports: [{
      contract_digest: fixedDigest(`${module}-${exported}`),
      kind: 'function',
      name: exported,
    }],
    module,
    schema: 're.module-interface@0.1.0',
  }
}

function syntheticArtifacts(graph, variant) {
  return graph.modules.map((module) => ({
    artifact_digest: fixedDigest(`${variant}-${module.name}-artifact`),
    cache_key: fixedDigest(`${variant}-${module.name}-cache`),
    key: {
      implementation_digest: module.implementation_digest,
      interface_digest: module.interface_digest,
      module: module.name,
    },
  }))
}

function withoutField(value, field) {
  const copy = structuredClone(value)
  delete copy[field]
  return copy
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
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

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sourceDigest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}
