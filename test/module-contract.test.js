import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  moduleInterfaceDigest,
  packageManifestDigest,
  planModuleRecheck,
  resolveModuleImport,
  validatePackageManifest,
} from '../src/toolchain/module-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/module-contract-corpus.json', import.meta.url),
  'utf8',
))
const manifest = corpus.manifest
const digest = (character) => `sha256:${character.repeat(64)}`

test('module contract validates exact internal and external dependencies', () => {
  assert.equal(corpus.schema, 're.module-contract-corpus@0.1.0')
  assert.deepEqual(validatePackageManifest(manifest), { ok: true })
  assert.equal(packageManifestDigest(manifest), corpus.expected_package_digest)
})

test('module and package digests ignore collection and object insertion order', () => {
  const reordered = structuredClone(manifest)
  reordered.modules.reverse()
  reordered.external_interfaces.reverse()
  for (const entry of reordered.modules) {
    entry.interface.exports.reverse()
    entry.interface.dependencies.reverse()
  }
  const api = manifest.modules.find(({ name }) => name === 'agent.relay.api')
  const reorderedApi = reordered.modules.find(({ name }) => name === 'agent.relay.api')

  assert.deepEqual(validatePackageManifest(reordered), { ok: true })
  assert.equal(packageManifestDigest(reordered), corpus.expected_package_digest)
  assert.equal(
    moduleInterfaceDigest(reorderedApi.interface),
    moduleInterfaceDigest(api.interface),
  )
})

test('module resolution exposes only declared exports through an exact binding', () => {
  assert.deepEqual(
    resolveModuleImport(manifest, 'agent.relay.api', 'service', 'handle'),
    {
      ok: true,
      reference: {
        binding: 'service',
        contract_digest: digest('c'),
        interface_digest: 'sha256:6cbfa0a9e364b386c5f6015b90a3bc4d962062b4ba553ad25e43f0bcf03fe71c',
        kind: 'function',
        module: 'agent.relay.service',
        name: 'handle',
      },
    },
  )
  assert.deepEqual(
    resolveModuleImport(manifest, 'agent.relay.api', 'service', 'private_helper'),
    {
      diagnostics: [{
        binding: 'service',
        code: 'module-export-not-found',
        export: 'private_helper',
        module: 'agent.relay.service',
      }],
      ok: false,
    },
  )
})

test('module contract rejects ranges, stale interface pins, and unknown claims', () => {
  const ranged = structuredClone(manifest)
  const dependency = ranged.modules[0].interface.dependencies[0]
  delete dependency.package_digest
  dependency.version_range = '^1.0.0'
  ranged.modules[0].interface_digest = moduleInterfaceDigest(ranged.modules[0].interface)
  const rangedResult = validatePackageManifest(ranged)
  assert.equal(rangedResult.ok, false)
  assert.ok(rangedResult.diagnostics.some(
    ({ code, field }) =>
      code === 'unexpected-module-dependency-field' && field === 'version_range',
  ))
  assert.ok(rangedResult.diagnostics.some(
    ({ code }) => code === 'invalid-dependency-package-digest',
  ))

  const stale = structuredClone(manifest)
  stale.modules[0].interface.dependencies[1].interface_digest = digest('0')
  stale.modules[0].interface_digest = moduleInterfaceDigest(stale.modules[0].interface)
  const staleResult = validatePackageManifest(stale)
  assert.equal(staleResult.ok, false)
  assert.ok(staleResult.diagnostics.some(
    ({ code }) => code === 'package-dependency-interface-mismatch',
  ))
})

test('module dependency cycles fail closed even when other pins are stale', () => {
  const cyclic = structuredClone(manifest)
  const core = cyclic.modules.find(({ name }) => name === 'agent.relay.core')
  const api = cyclic.modules.find(({ name }) => name === 'agent.relay.api')
  core.interface.dependencies.push({
    binding: 'api',
    interface_digest: api.interface_digest,
    module: api.name,
    scope: 'package',
  })
  core.interface_digest = moduleInterfaceDigest(core.interface)

  const result = validatePackageManifest(cyclic)

  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(({ code }) => code === 'module-dependency-cycle'))
})

test('incremental plan isolates implementation changes and closes interface dependents', () => {
  assert.deepEqual(planModuleRecheck(manifest, {
    implementation_changed: ['agent.relay.service'],
    interface_changed: [],
  }), {
    modules: ['agent.relay.service'],
    ok: true,
  })
  assert.deepEqual(planModuleRecheck(manifest, {
    implementation_changed: [],
    interface_changed: ['agent.relay.core'],
  }), {
    modules: [
      'agent.relay.core',
      'agent.relay.service',
      'agent.relay.api',
    ],
    ok: true,
  })
})

test('64-module package keeps digest and recheck plan deterministic', () => {
  const large = chainManifest(64)
  const reversed = structuredClone(large)
  reversed.modules.reverse()

  assert.deepEqual(validatePackageManifest(large), { ok: true })
  assert.deepEqual(validatePackageManifest(reversed), { ok: true })
  assert.equal(packageManifestDigest(large), packageManifestDigest(reversed))
  assert.deepEqual(planModuleRecheck(large, {
    implementation_changed: ['scale.m32'],
    interface_changed: [],
  }), {
    modules: ['scale.m32'],
    ok: true,
  })
  const interfacePlan = planModuleRecheck(large, {
    implementation_changed: [],
    interface_changed: ['scale.m00'],
  })
  assert.equal(interfacePlan.ok, true)
  assert.equal(interfacePlan.modules.length, 64)
  assert.equal(interfacePlan.modules[0], 'scale.m00')
  assert.equal(interfacePlan.modules[63], 'scale.m63')
})

test('malformed module collections return diagnostics instead of throwing', () => {
  const malformed = structuredClone(manifest)
  malformed.modules[0].interface = null

  assert.doesNotThrow(() => validatePackageManifest(malformed))
  assert.equal(validatePackageManifest(malformed).ok, false)

  const malformedDependencies = structuredClone(manifest)
  malformedDependencies.modules[0].interface.dependencies = { guessed: true }
  assert.doesNotThrow(() => validatePackageManifest(malformedDependencies))
  const result = validatePackageManifest(malformedDependencies)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(
    ({ code }) => code === 'module-interface-not-canonicalizable',
  ))
})

function chainManifest(count) {
  const modules = []
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, '0')
    const previous = modules.at(-1)
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
        name: 'run',
      }],
      module: `scale.m${suffix}`,
      schema: 're.module-interface@0.1.0',
    }
    modules.push({
      implementation_digest: digest(((index + 1) % 10).toString()),
      interface: moduleInterface,
      interface_digest: moduleInterfaceDigest(moduleInterface),
      name: moduleInterface.module,
    })
  }
  return {
    external_interfaces: [],
    modules,
    package: 'scale',
    schema: 're.package-manifest@0.1.0',
  }
}
