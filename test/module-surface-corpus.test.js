import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  moduleInterfaceDigest,
  packageManifestDigest,
  validatePackageManifest,
} from '../src/toolchain/module-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/module-surface-corpus.json', import.meta.url),
  'utf8',
))
const baseManifest = JSON.parse(await readFile(
  new URL('./fixtures/module-contract-corpus.json', import.meta.url),
  'utf8',
)).manifest
const basePackageDigest = packageManifestDigest(baseManifest)
const substitutePackageDigest = `sha256:${'0'.repeat(64)}`
const staleInterfaceDigest = `sha256:${'f'.repeat(64)}`

test('module surface corpus names exact-pin attacks without inventing source grammar', () => {
  assert.equal(corpus.schema, 're.module-surface-corpus@0.2.0')
  assert.equal(corpus.status, 'abstract-boundary')
  assert.deepEqual(corpus.cases.map(({ shape }) => shape), [
    'consistent-diamond',
    'inconsistent-diamond-pin',
    'same-name-binding',
    'same-name-export',
    'unresolved-external-package-substitution',
    'coherent-external-package-substitution',
    'exact-pin-success',
  ])
})

test('a consistent DAG diamond is valid and an inconsistent path pin is rejected', () => {
  const consistent = manifestFor('consistent-diamond')
  assert.deepEqual(validatePackageManifest(consistent), { ok: true })

  const inconsistent = manifestFor('inconsistent-diamond-pin')
  const result = validatePackageManifest(inconsistent)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(
    ({ code, module, target }) =>
      code === 'package-dependency-interface-mismatch' &&
      module === 'agent.relay.audit' &&
      target === 'agent.relay.core',
  ))
})

test('duplicate binding and export names receive their stable set diagnostics', () => {
  for (const shape of ['same-name-binding', 'same-name-export']) {
    const entry = corpus.cases.find((candidate) => candidate.shape === shape)
    const result = validatePackageManifest(manifestFor(shape))
    assert.equal(result.ok, false, entry.id)
    assert.ok(
      result.diagnostics.some(({ code }) => code === entry.expected.diagnostic),
      entry.id,
    )
    assert.equal(
      result.diagnostics.some(({ code }) => code === 'module-interface-digest-mismatch'),
      false,
      `${entry.id} must not hide the named conflict behind a stale digest`,
    )
  }
})

test('external substitution is either unresolved or changes the locked package digest', () => {
  const unresolved = manifestFor('unresolved-external-package-substitution')
  const unresolvedResult = validatePackageManifest(unresolved)
  assert.equal(unresolvedResult.ok, false)
  assert.ok(unresolvedResult.diagnostics.some(
    ({ code }) => code === 'external-dependency-not-found',
  ))

  const coherent = manifestFor('coherent-external-package-substitution')
  assert.deepEqual(validatePackageManifest(coherent), { ok: true })
  assert.notEqual(packageManifestDigest(coherent), basePackageDigest)
})

test('every abstract surface case matches its executable manifest oracle', () => {
  for (const entry of corpus.cases) {
    const manifest = manifestFor(entry.shape)
    const result = validatePackageManifest(manifest)
    assert.equal(result.ok, entry.expected.ok, entry.id)
    if (entry.expected.diagnostic !== undefined) {
      assert.ok(
        result.diagnostics.some(({ code }) => code === entry.expected.diagnostic),
        entry.id,
      )
    }
    if (entry.expected.package_digest_changed !== undefined) {
      assert.equal(
        packageManifestDigest(manifest) !== basePackageDigest,
        entry.expected.package_digest_changed,
        entry.id,
      )
    }
  }
})

function manifestFor(shape) {
  const manifest = structuredClone(baseManifest)
  if (shape === 'consistent-diamond' || shape === 'inconsistent-diamond-pin') {
    addDiamond(manifest)
    if (shape === 'inconsistent-diamond-pin') {
      const audit = moduleByName(manifest, 'agent.relay.audit')
      audit.interface.dependencies[0].interface_digest = staleInterfaceDigest
      refreshInterface(audit)
      const api = moduleByName(manifest, 'agent.relay.api')
      api.interface.dependencies.find(({ binding }) => binding === 'audit')
        .interface_digest = audit.interface_digest
      refreshInterface(api)
    }
    return manifest
  }
  if (shape === 'same-name-binding') {
    const api = moduleByName(manifest, 'agent.relay.api')
    api.interface.dependencies.push(structuredClone(
      api.interface.dependencies.find(({ binding }) => binding === 'service'),
    ))
    refreshInterface(api)
    return manifest
  }
  if (shape === 'same-name-export') {
    const service = moduleByName(manifest, 'agent.relay.service')
    service.interface.exports.push(structuredClone(service.interface.exports[0]))
    refreshInterface(service)
    const api = moduleByName(manifest, 'agent.relay.api')
    api.interface.dependencies.find(({ binding }) => binding === 'service')
      .interface_digest = service.interface_digest
    refreshInterface(api)
    return manifest
  }
  if (shape === 'unresolved-external-package-substitution') {
    manifest.external_interfaces[0].package_digest = substitutePackageDigest
    return manifest
  }
  if (shape === 'coherent-external-package-substitution') {
    manifest.external_interfaces[0].package_digest = substitutePackageDigest
    const api = moduleByName(manifest, 'agent.relay.api')
    api.interface.dependencies.find(({ binding }) => binding === 'log')
      .package_digest = substitutePackageDigest
    refreshInterface(api)
    return manifest
  }
  return manifest
}

function addDiamond(manifest) {
  const core = moduleByName(manifest, 'agent.relay.core')
  const audit = moduleByName(manifest, 'agent.relay.audit')
  audit.interface.dependencies.push({
    binding: 'core',
    interface_digest: core.interface_digest,
    module: core.name,
    scope: 'package',
  })
  refreshInterface(audit)
  const api = moduleByName(manifest, 'agent.relay.api')
  api.interface.dependencies.push({
    binding: 'audit',
    interface_digest: audit.interface_digest,
    module: audit.name,
    scope: 'package',
  })
  refreshInterface(api)
}

function moduleByName(manifest, name) {
  return manifest.modules.find((entry) => entry.name === name)
}

function refreshInterface(moduleEntry) {
  moduleEntry.interface_digest = moduleInterfaceDigest(moduleEntry.interface)
}
