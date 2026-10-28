import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  minimalStdModuleAuthority,
} from './minimal-std-abi.js'
import {
  buildModulesWithArtifactCache,
} from './module-artifact-cache.js'
import {
  minimalStdCapabilityDigest,
  minimalStdRuntimePackageDigest,
} from './minimal-std-subset.js'

export const MINIMAL_STD_CACHE_CONFORMANCE_SCHEMA =
  're.minimal-std-cache-conformance@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MODULE_COUNTS = [50, 500]

export function minimalStdExternalModuleDependency(
  module,
  { binding = module.replaceAll('.', '_') } = {},
) {
  const authority = minimalStdModuleAuthority(module)
  if (authority === null
    || typeof binding !== 'string'
    || binding.length === 0) {
    throw new TypeError('invalid minimal std external dependency')
  }
  return {
    binding,
    interface_digest: authority.interface_digest,
    module,
    package_digest: minimalStdRuntimePackageDigest(),
    scope: 'external',
  }
}

export async function runMinimalStdCacheConformance({
  cacheDirectory,
  moduleCounts = MODULE_COUNTS,
  profile_digest,
  toolchain_digest,
}) {
  validateOptions({
    cacheDirectory,
    moduleCounts,
    profile_digest,
    toolchain_digest,
  })
  const runtimePackageDigest = minimalStdRuntimePackageDigest()
  const runtimeDriftDigest = fixedDigest(`${runtimePackageDigest}:drift`)
  const runs = []
  for (const moduleCount of [...moduleCounts].sort((left, right) => left - right)) {
    const directory = join(cacheDirectory, String(moduleCount))
    const manifest = conformanceManifest(moduleCount, runtimePackageDigest)
    const cold = await build(directory, manifest, profile_digest, toolchain_digest)
    const warm = await build(directory, manifest, profile_digest, toolchain_digest)
    const implementationChanged = structuredClone(manifest)
    implementationChanged.modules[Math.floor(moduleCount / 2)].implementation_digest =
      fixedDigest(`minimal-std-cache-implementation-drift-${moduleCount}`)
    const implementationIncremental = await build(
      directory,
      implementationChanged,
      profile_digest,
      toolchain_digest,
    )
    const runtimeChanged = conformanceManifest(moduleCount, runtimeDriftDigest)
    const runtimePackageIncremental = await build(
      directory,
      runtimeChanged,
      profile_digest,
      toolchain_digest,
    )
    runs.push({
      cold,
      implementation_incremental: implementationIncremental,
      module_count: moduleCount,
      runtime_package_incremental: runtimePackageIncremental,
      warm,
    })
  }
  const stdBytes = minimalStdModuleAuthority('std.bytes')
  const content = {
    capability_digest: minimalStdCapabilityDigest(),
    profile_digest,
    runs,
    runtime_drift_digest: runtimeDriftDigest,
    runtime_package_digest: runtimePackageDigest,
    schema: MINIMAL_STD_CACHE_CONFORMANCE_SCHEMA,
    std_interface_digest: stdBytes.interface_digest,
    std_module: stdBytes.module,
    toolchain_digest,
  }
  return {
    ...content,
    report_digest: digest(content),
  }
}

export function verifyMinimalStdCacheConformance(report) {
  try {
    exactFields(report, [
      'capability_digest',
      'profile_digest',
      'report_digest',
      'runs',
      'runtime_drift_digest',
      'runtime_package_digest',
      'schema',
      'std_interface_digest',
      'std_module',
      'toolchain_digest',
    ])
    const {
      report_digest: reportDigest,
      ...content
    } = report
    const authority = minimalStdModuleAuthority('std.bytes')
    if (report.schema !== MINIMAL_STD_CACHE_CONFORMANCE_SCHEMA
      || reportDigest !== digest(content)
      || report.capability_digest !== minimalStdCapabilityDigest()
      || report.runtime_package_digest !== minimalStdRuntimePackageDigest()
      || report.std_interface_digest !== authority.interface_digest
      || report.std_module !== authority.module
      || !DIGEST.test(report.profile_digest)
      || !DIGEST.test(report.toolchain_digest)
      || !DIGEST.test(report.runtime_drift_digest)
      || report.runtime_drift_digest === report.runtime_package_digest
      || !Array.isArray(report.runs)
      || report.runs.length === 0) {
      throw new TypeError('minimal std cache authority mismatch')
    }
    let previous = 0
    for (const run of report.runs) {
      exactFields(run, [
        'cold',
        'implementation_incremental',
        'module_count',
        'runtime_package_incremental',
        'warm',
      ])
      if (!Number.isSafeInteger(run.module_count)
        || run.module_count <= previous
        || run.module_count < 2) {
        throw new TypeError('invalid minimal std cache module count')
      }
      exactStats(run.cold, {
        built: run.module_count,
        hits: 0,
        misses: run.module_count,
      })
      exactStats(run.warm, {
        built: 0,
        hits: run.module_count,
        misses: 0,
      })
      exactStats(run.implementation_incremental, {
        built: 1,
        hits: run.module_count - 1,
        misses: 1,
      })
      exactStats(run.runtime_package_incremental, {
        built: run.module_count,
        hits: 0,
        misses: run.module_count,
      })
      previous = run.module_count
    }
    return { ok: true }
  } catch {
    return {
      diagnostics: [{ code: 'minimal-std-cache-conformance-invalid' }],
      ok: false,
    }
  }
}

async function build(cacheDirectory, manifest, profileDigest, toolchainDigest) {
  const result = await buildModulesWithArtifactCache({
    cacheDirectory,
    compile: compileModule,
    manifest,
    profile_digest: profileDigest,
    toolchain_digest: toolchainDigest,
    verify: verifyModule,
  })
  if (!result.ok) throw new TypeError(result.diagnostics[0].code)
  return result.stats
}

function conformanceManifest(moduleCount, runtimePackageDigest) {
  const std = minimalStdModuleAuthority('std.bytes')
  const width = String(moduleCount - 1).length
  const externalDependency = {
    ...minimalStdExternalModuleDependency('std.bytes', { binding: 'std_bytes' }),
    package_digest: runtimePackageDigest,
  }
  const modules = Array.from({ length: moduleCount }, (_, index) => {
    const name = `std_cache.m${String(index).padStart(width, '0')}`
    const moduleInterface = {
      dependencies: [externalDependency],
      exports: [{
        contract_digest: fixedDigest(`minimal-std-cache-contract-${index}`),
        kind: 'function',
        name: 'build',
      }],
      module: name,
      schema: 're.module-interface@0.1.0',
    }
    return {
      implementation_digest: fixedDigest(`minimal-std-cache-implementation-${index}`),
      interface: moduleInterface,
      interface_digest: digest(moduleInterface),
      name,
    }
  })
  return {
    external_interfaces: [{
      interface: std.interface,
      interface_digest: std.interface_digest,
      module: std.module,
      package_digest: runtimePackageDigest,
    }],
    modules,
    package: 'std_cache',
    schema: 're.package-manifest@0.1.0',
  }
}

async function compileModule({ cache_key, module }) {
  return {
    cache_key,
    implementation_digest: module.implementation_digest,
    module: module.name,
  }
}

function verifyModule(payload, { cache_key, module }) {
  return payload?.cache_key === cache_key
    && payload?.implementation_digest === module.implementation_digest
    && payload?.module === module.name
}

function exactStats(actual, expected) {
  exactFields(actual, ['built', 'hits', 'misses'])
  if (actual.built !== expected.built
    || actual.hits !== expected.hits
    || actual.misses !== expected.misses) {
    throw new TypeError('minimal std cache stats mismatch')
  }
}

function validateOptions({
  cacheDirectory,
  moduleCounts,
  profile_digest,
  toolchain_digest,
}) {
  if (typeof cacheDirectory !== 'string'
    || cacheDirectory.length === 0
    || !Array.isArray(moduleCounts)
    || moduleCounts.length === 0
    || moduleCounts.some(
      (count) => !Number.isSafeInteger(count) || count < 2 || count > 5_000,
    )
    || new Set(moduleCounts).size !== moduleCounts.length
    || !DIGEST.test(profile_digest)
    || !DIGEST.test(toolchain_digest)) {
    throw new TypeError('invalid minimal std cache conformance options')
  }
}

function exactFields(value, fields) {
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) {
    throw new TypeError('minimal std cache fields mismatch')
  }
}

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
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
    throw new TypeError('non-canonical minimal std cache value')
  }
  return JSON.stringify(value)
}
