import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  minimalStdRuntimePackageDigest,
} from '../src/toolchain/minimal-std-subset.js'
import {
  minimalStdExternalModuleDependency,
  runMinimalStdCacheConformance,
  verifyMinimalStdCacheConformance,
} from '../src/toolchain/minimal-std-cache.js'

const digest = (character) => `sha256:${character.repeat(64)}`

test('minimal std external dependency binds interface and runtime package authority', () => {
  const dependency = minimalStdExternalModuleDependency('std.bytes', {
    binding: 'std_bytes',
  })
  assert.deepEqual(dependency, {
    binding: 'std_bytes',
    interface_digest: dependency.interface_digest,
    module: 'std.bytes',
    package_digest: minimalStdRuntimePackageDigest(),
    scope: 'external',
  })
  assert.match(dependency.interface_digest, /^sha256:[0-9a-f]{64}$/u)
})

test('minimal std cache conformance invalidates 50 and 500 modules on runtime drift', async (context) => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 're-minimal-std-cache-'))
  context.after(() => rm(cacheDirectory, { force: true, recursive: true }))
  const report = await runMinimalStdCacheConformance({
    cacheDirectory,
    moduleCounts: [50, 500],
    profile_digest: digest('a'),
    toolchain_digest: digest('b'),
  })

  assert.deepEqual(verifyMinimalStdCacheConformance(report), { ok: true })
  assert.deepEqual(report.runs.map(({ module_count }) => module_count), [50, 500])
  for (const run of report.runs) {
    assert.deepEqual(run.cold, {
      built: run.module_count,
      hits: 0,
      misses: run.module_count,
    })
    assert.deepEqual(run.warm, {
      built: 0,
      hits: run.module_count,
      misses: 0,
    })
    assert.deepEqual(run.implementation_incremental, {
      built: 1,
      hits: run.module_count - 1,
      misses: 1,
    })
    assert.deepEqual(run.runtime_package_incremental, {
      built: run.module_count,
      hits: 0,
      misses: run.module_count,
    })
  }

  const tampered = structuredClone(report)
  tampered.runtime_package_digest = digest('f')
  assert.equal(verifyMinimalStdCacheConformance(tampered).ok, false)
})
