import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { loadCanonicalGraph } from '../src/toolchain/canonical.js'
import { translateSource } from '../src/toolchain/demo-toolchain.js'
import {
  translateCheckedGraph,
  TRANSLATION_ARTIFACT_SCHEMA,
  TRANSLATION_RUNTIME_KIND,
  TRANSLATION_TARGET_PROFILE,
} from '../src/toolchain/translation-artifact.js'

test('translator emits a path-free revision-bound execution artifact', async () => {
  const source = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  const first = translateSource(source, { file: '/tmp/a/hello.re' })
  const second = translateSource(source, { file: '/private/tmp/b/renamed.re' })

  assert.equal(first.ok, true)
  assert.deepEqual(first, second)
  assert.equal(first.value.schema, TRANSLATION_ARTIFACT_SCHEMA)
  assert.equal(first.value.runtime.kind, TRANSLATION_RUNTIME_KIND)
  assert.equal(first.value.target_profile, TRANSLATION_TARGET_PROFILE)
  assert.match(first.value.graph_revision, /^sha256:[0-9a-f]{64}$/)
  assert.match(first.value.artifact_sha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.value.canonical.sha256, first.value.graph_revision)
  assert.equal(first.value.canonical.bytes.includes('/tmp/'), false)
  assert.equal(loadCanonicalGraph(first.value.canonical.bytes).ok, true)
})

test('translator identity changes with graph, runtime, and target profile', async () => {
  const source = await readFile(
    new URL('../examples/hello.re', import.meta.url),
    'utf8',
  )
  const changed = source.replace('Hello, World!', 'Hello, translator!')
  const first = translateSource(source)
  const second = translateSource(changed)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(first.value.graph_revision, second.value.graph_revision)
  assert.notEqual(first.value.artifact_sha256, second.value.artifact_sha256)

  const rebound = translateCheckedGraph(
    loadCanonicalGraph(first.value.canonical.bytes).value,
    {
      runtimeKind: 'test-runtime',
      targetProfile: 'test-profile@0.1.0',
    },
  )
  assert.equal(rebound.ok, true)
  assert.equal(rebound.value.graph_revision, first.value.graph_revision)
  assert.notEqual(rebound.value.artifact_sha256, first.value.artifact_sha256)
  assert.equal(rebound.value.canonical.sha256, first.value.canonical.sha256)
  assert.equal(rebound.value.runtime.kind, 'test-runtime')
  assert.equal(rebound.value.target_profile, 'test-profile@0.1.0')
})

test('translator rejects unsupported graph constructs without partial artifact', () => {
  const translated = translateCheckedGraph({
    capabilities: [],
    functions: [{
      kind: 'function',
      literals: [],
      name: '@main',
      returnType: 'process.status',
      statements: [{ kind: 'loop' }],
      uid: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
    }],
    unit: '@unsupported',
    version: '0.1',
  })

  assert.deepEqual(translated, {
    diagnostics: [{
      actual: 'unsupported canonical graph construct: graph kind=loop',
      code: 'unsupported-translation-graph',
    }],
    ok: false,
  })
})
