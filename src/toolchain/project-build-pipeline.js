import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  buildModulesWithArtifactCache,
} from './module-artifact-cache.js'
import { planModuleRecheck } from './module-contract.js'
import { loadProjectDirectory } from './project-loader.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
const BUILD_KEY_SCHEMA = 're.project-build-key@0.1.0'
const BUILD_MANIFEST_SCHEMA = 're.project-build-manifest@0.1.0'

export async function buildProjectWithArtifactCache({
  buildDirectory,
  cacheDirectory,
  compile,
  previousManifest = null,
  profile_digest,
  projectDirectory,
  toolchain_digest,
  verify,
}) {
  if (typeof compile !== 'function' || typeof verify !== 'function') {
    return rejected('invalid-project-build-compiler')
  }
  const loaded = await loadProjectDirectory(projectDirectory)
  if (!loaded.ok) return loaded
  const graph = loaded.value
  let buildKey
  let invalidation
  try {
    buildKey = createProjectBuildKey({
      graph,
      profile_digest,
      toolchain_digest,
    })
    invalidation = await createInvalidationPlan(
      graph,
      previousManifest,
      {
        profile_digest,
        toolchain_digest,
      },
      buildDirectory,
    )
  } catch {
    return rejected('project-build-previous-manifest-mismatch')
  }
  const graphSnapshot = snapshotCanonical(graph)
  const graphModules = new Map(graph.modules.map((module) => [
    module.name,
    snapshotCanonical(module),
  ]))
  const built = await buildModulesWithArtifactCache({
    cacheDirectory,
    compile: async ({ cache_key, module }) => compile({
      cache_key,
      graph: graphSnapshot,
      module: graphModules.get(module.name),
      package_module: module,
    }),
    manifest: graph.package_manifest,
    profile_digest,
    toolchain_digest,
    verify: (payload, { cache_key, module }) => verify(payload, {
      cache_key,
      graph: graphSnapshot,
      module: graphModules.get(module.name),
      package_module: module,
    }),
  })
  if (!built.ok) return built

  let manifest
  try {
    manifest = createProjectBuildManifest({
      artifacts: built.artifacts,
      buildKey,
      graph,
    })
  } catch {
    return rejected('invalid-project-build-manifest')
  }
  const published = await writeProjectBuildManifest(buildDirectory, manifest)
  if (!published.ok) return published
  return {
    invalidation,
    manifest,
    ok: true,
    published: !published.replayed,
    stats: built.stats,
  }
}

export function createProjectBuildKey({
  graph,
  profile_digest,
  toolchain_digest,
}) {
  if (!plainObject(graph)
    || graph.schema !== 're.project-graph@0.1.0'
    || !DIGEST.test(graph.graph_revision)
    || !DIGEST.test(graph.project_digest)
    || !DIGEST.test(graph.package_digest)
    || !Array.isArray(graph.modules)
    || !DIGEST.test(profile_digest)
    || !DIGEST.test(toolchain_digest)) {
    throw new TypeError('invalid project build key')
  }
  const content = {
    graph_revision: graph.graph_revision,
    package_digest: graph.package_digest,
    profile_digest,
    project_digest: graph.project_digest,
    schema: BUILD_KEY_SCHEMA,
    toolchain_digest,
  }
  return { ...content, build_key: digest(content) }
}

export function createProjectBuildManifest({ artifacts, buildKey, graph }) {
  validateBuildKey(buildKey)
  if (!Array.isArray(artifacts) || artifacts.length !== graph.modules.length) {
    throw new TypeError('invalid project build artifacts')
  }
  const artifactsByModule = new Map(artifacts.map((artifact) => [
    artifact?.key?.module,
    artifact,
  ]))
  if (artifactsByModule.size !== graph.modules.length
    || artifacts.some((artifact) =>
      !plainObject(artifact?.key)
      || typeof artifact.key.module !== 'string'
      || artifactsByModule.get(artifact.key.module) !== artifact)) {
    throw new TypeError('project build artifact module mismatch')
  }
  const modules = graph.modules.map((module) => {
    const artifact = artifactsByModule.get(module.name)
    if (!plainObject(artifact)
      || !DIGEST.test(artifact.artifact_digest)
      || !DIGEST.test(artifact.cache_key)
      || artifact.key?.implementation_digest !== module.implementation_digest
      || artifact.key?.interface_digest !== module.interface_digest) {
      throw new TypeError('project build artifact mismatch')
    }
    return {
      artifact_digest: artifact.artifact_digest,
      cache_key: artifact.cache_key,
      implementation_digest: module.implementation_digest,
      interface_digest: module.interface_digest,
      module: module.name,
    }
  })
  const content = {
    build_key: buildKey.build_key,
    graph_revision: graph.graph_revision,
    key: snapshotCanonical(buildKey),
    modules,
    package_digest: graph.package_digest,
    project_digest: graph.project_digest,
    schema: BUILD_MANIFEST_SCHEMA,
  }
  return { ...content, manifest_digest: digest(content) }
}

export async function readProjectBuildManifest(buildDirectory, buildKey) {
  try {
    validateDirectory(buildDirectory)
    validateBuildKey(buildKey)
    let source
    try {
      source = await readFile(manifestPath(buildDirectory, buildKey.build_key), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { found: false, ok: true }
      throw error
    }
    const manifest = JSON.parse(source)
    validateBuildManifest(manifest, buildKey)
    return { found: true, manifest, ok: true }
  } catch {
    return rejected('project-build-manifest-corrupt')
  }
}

export async function writeProjectBuildManifest(buildDirectory, manifest) {
  let temporaryDirectory = null
  try {
    validateDirectory(buildDirectory)
    validateBuildManifest(manifest, manifest.key)
    await mkdir(buildDirectory, { recursive: true })
    const key = manifest.build_key.slice(7)
    const finalDirectory = join(buildDirectory, key)
    temporaryDirectory = join(
      buildDirectory,
      `.tmp-${key}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    await mkdir(temporaryDirectory)
    await writeFile(
      join(temporaryDirectory, 'build.json'),
      `${canonicalJson(manifest)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    try {
      await rename(temporaryDirectory, finalDirectory)
      temporaryDirectory = null
      return { ok: true, replayed: false }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
    }
    const existing = await readProjectBuildManifest(buildDirectory, manifest.key)
    if (!existing.ok) return existing
    if (!existing.found || canonicalJson(existing.manifest) !== canonicalJson(manifest)) {
      return rejected('project-build-manifest-nondeterministic')
    }
    return { ok: true, replayed: true }
  } catch {
    return rejected('project-build-manifest-write-failure')
  } finally {
    if (temporaryDirectory !== null) {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => {})
    }
  }
}

async function createInvalidationPlan(
  graph,
  previousManifest,
  authority,
  buildDirectory,
) {
  if (previousManifest === null) {
    return {
      added_modules: graph.modules.map(({ name }) => name),
      modules: graph.modules.map(({ name }) => name),
      removed_modules: [],
    }
  }
  validateBuildManifest(previousManifest, previousManifest.key)
  const published = await readProjectBuildManifest(
    buildDirectory,
    previousManifest.key,
  )
  if (!published.ok
    || !published.found
    || canonicalJson(published.manifest) !== canonicalJson(previousManifest)) {
    throw new TypeError('project-build-previous-manifest-mismatch')
  }
  const currentNames = new Set(graph.modules.map(({ name }) => name))
  const previousByName = new Map(previousManifest.modules.map((module) => [
    module.module,
    module,
  ]))
  const added = graph.modules
    .map(({ name }) => name)
    .filter((name) => !previousByName.has(name))
  const removed = previousManifest.modules
    .map(({ module }) => module)
    .filter((name) => !currentNames.has(name))
    .sort()
  const authorityChanged =
    previousManifest.key.toolchain_digest !== authority.toolchain_digest
    || previousManifest.key.profile_digest !== authority.profile_digest
  const implementationChanged = []
  const interfaceChanged = [...added]
  for (const module of graph.package_manifest.modules) {
    const previous = previousByName.get(module.name)
    if (previous === undefined) continue
    if (authorityChanged || previous.interface_digest !== module.interface_digest) {
      interfaceChanged.push(module.name)
    } else if (previous.implementation_digest !== module.implementation_digest) {
      implementationChanged.push(module.name)
    }
  }
  const planned = planModuleRecheck(graph.package_manifest, {
    implementation_changed: implementationChanged,
    interface_changed: interfaceChanged,
  })
  if (!planned.ok) throw new TypeError('invalid project build invalidation')
  return {
    added_modules: added.sort(),
    modules: planned.modules,
    removed_modules: removed,
  }
}

function validateBuildKey(key) {
  if (!plainObject(key)
    || !exactFields(key, [
      'build_key',
      'graph_revision',
      'package_digest',
      'profile_digest',
      'project_digest',
      'schema',
      'toolchain_digest',
    ])
    || key.schema !== BUILD_KEY_SCHEMA
    || ![
      'build_key',
      'graph_revision',
      'package_digest',
      'profile_digest',
      'project_digest',
      'toolchain_digest',
    ].every((field) => DIGEST.test(key[field]))) {
    throw new TypeError('invalid project build key')
  }
  const { build_key, ...content } = key
  if (build_key !== digest(content)) throw new TypeError('project build key mismatch')
}

function validateBuildManifest(manifest, expectedKey) {
  validateBuildKey(expectedKey)
  if (!plainObject(manifest)
    || !exactFields(manifest, [
      'build_key',
      'graph_revision',
      'key',
      'manifest_digest',
      'modules',
      'package_digest',
      'project_digest',
      'schema',
    ])
    || manifest.schema !== BUILD_MANIFEST_SCHEMA
    || canonicalJson(manifest.key) !== canonicalJson(expectedKey)
    || manifest.build_key !== expectedKey.build_key
    || manifest.graph_revision !== expectedKey.graph_revision
    || manifest.package_digest !== expectedKey.package_digest
    || manifest.project_digest !== expectedKey.project_digest
    || !Array.isArray(manifest.modules)
    || !DIGEST.test(manifest.manifest_digest)) {
    throw new TypeError('invalid project build manifest')
  }
  const names = new Set()
  for (const module of manifest.modules) {
    if (!plainObject(module)
      || !exactFields(module, [
        'artifact_digest',
        'cache_key',
        'implementation_digest',
        'interface_digest',
        'module',
      ])
      || typeof module.module !== 'string'
      || names.has(module.module)
      || ![
        'artifact_digest',
        'cache_key',
        'implementation_digest',
        'interface_digest',
      ].every((field) => DIGEST.test(module[field]))) {
      throw new TypeError('invalid project build module')
    }
    names.add(module.module)
  }
  const { manifest_digest, ...content } = manifest
  if (manifest_digest !== digest(content)) {
    throw new TypeError('project build manifest digest mismatch')
  }
}

function manifestPath(buildDirectory, buildKey) {
  return join(buildDirectory, buildKey.slice(7), 'build.json')
}

function validateDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('invalid project build directory')
  }
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
    throw new TypeError('non-canonical project build value')
  }
  return JSON.stringify(value)
}

function exactFields(value, fields) {
  return Object.keys(value).sort().join('\0') === [...fields].sort().join('\0')
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
