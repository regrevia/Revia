import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { serializeCanonicalGraph } from '../src/toolchain/canonical.js'
import { checkSource, reviewSource } from '../src/toolchain/demo-toolchain.js'
import { moduleInterfaceDigest } from '../src/toolchain/module-contract.js'
import {
  buildProjectReviewIndex,
  expandProjectReviewFact,
} from '../src/toolchain/review-manifest.js'

const hello = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const argsCheck = await readFile(
  new URL('../examples/args-check.re', import.meta.url),
  'utf8',
)
const readCheck = await readFile(
  new URL('../examples/read-check.re', import.meta.url),
  'utf8',
)
const readEncoding = await readFile(
  new URL('../examples/read-encoding.re', import.meta.url),
  'utf8',
)
const writeCheck = await readFile(
  new URL('../examples/write-check.re', import.meta.url),
  'utf8',
)
const interfaceDigest = moduleInterfaceDigest({
  dependencies: [],
  exports: [],
  module: 'hello',
  schema: 're.module-interface@0.1.0',
})

test('review manifest binds to the graph revision and exposes stable anchors', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)

  const reviewed = reviewSource(hello, { file: 'hello.re' })
  assert.equal(reviewed.ok, true)
  const manifest = reviewed.value
  assert.equal(manifest.schema, 're.review-manifest@0.1.0')
  assert.match(manifest.graph_revision, /^sha256:[a-f0-9]{64}$/)
  assert.equal(manifest.module, '@hello')
  assert.ok(manifest.capabilities.some((cap) => cap.uid))
  assert.ok(manifest.effects.some((effect) => effect.call_uid))
  assert.ok(manifest.effects.every((effect) => effect.parameter === 'data'))
  assert.ok(manifest.error_paths.some((path) => path.consumer_uid))
  assert.ok(manifest.uid_anchors.length > 0)
})

test('review manifest changes when the graph changes but stays revision-pinned', () => {
  const reviewed = reviewSource(hello, { file: 'hello.re' })
  assert.equal(reviewed.ok, true)
  const manifest = reviewed.value

  const changed = hello.replace('Hello, World!', 'Hello, Review!')
  const changedReviewed = reviewSource(changed, { file: 'hello.re' })
  assert.equal(changedReviewed.ok, true)

  assert.notEqual(changedReviewed.value.graph_revision, manifest.graph_revision)
})

test('review manifest represents a zero-argument effect without inventing a parameter', () => {
  const reviewed = reviewSource(argsCheck, { file: 'args-check.re' })

  assert.equal(reviewed.ok, true)
  assert.deepEqual(reviewed.value.effects, [{
    call_uid: reviewed.value.effects[0].call_uid,
    kind: 'capability-member-call',
    member: 'read',
    parameter: null,
    parameter_endpoint: null,
    schema_reference: 'process.args@0.1.0',
  }])
})

test('review manifest projects the schema-bound fs path parameter', () => {
  const reviewed = reviewSource(readCheck, { file: 'read-check.re' })

  assert.equal(reviewed.ok, true)
  assert.equal(reviewed.value.effects[0].member, 'read_file')
  assert.equal(reviewed.value.effects[0].parameter, 'path')
  assert.notEqual(reviewed.value.effects[0].parameter_endpoint, null)
  assert.equal(
    reviewed.value.effects[0].schema_reference,
    'fs.read@0.1.0',
  )
})

test('review manifest projects every multi-call parameter deterministically', () => {
  const reviewed = reviewSource(readEncoding, { file: 'read-encoding.re' })

  assert.equal(reviewed.ok, true)
  assert.equal(reviewed.value.effects[0].parameter, null)
  assert.equal(reviewed.value.effects[0].parameter_endpoint, null)
  assert.deepEqual(
    reviewed.value.effects[0].parameters.map(({ name }) => name),
    ['encoding', 'path'],
  )
  assert.ok(
    reviewed.value.effects[0].parameters.every(({ endpoint }) =>
      typeof endpoint === 'string'
    ),
  )
})

test('review manifest preserves the fs.write bytes parameter endpoint', () => {
  const reviewed = reviewSource(writeCheck, { file: 'write-check.re' })

  assert.equal(reviewed.ok, true)
  assert.deepEqual(
    reviewed.value.effects[0].parameters.map(({ name }) => name),
    ['data', 'path'],
  )
  assert.ok(
    reviewed.value.effects[0].parameters.every(({ endpoint }) =>
      typeof endpoint === 'string' && endpoint.length === 26
    ),
  )
})

test('canonical graph re-entry keeps the review revision stable', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const canonical = serializeCanonicalGraph(checked.program)
  const first = reviewSource(canonical, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  const second = reviewSource(canonical, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.value.graph_revision, second.value.graph_revision)
})

test('project review index pages stable UID anchored facts', () => {
  const reviewed = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(reviewed.ok, true)
  const first = buildProjectReviewIndex(reviewed.value, { limit: 2 })

  assert.equal(first.ok, true)
  assert.equal(first.value.schema, 're.project-review-index@0.1.0')
  assert.equal(first.value.graph_revision, reviewed.value.graph_revision)
  assert.equal(first.value.module_interface_digest, interfaceDigest)
  assert.match(first.value.index_revision, /^sha256:[a-f0-9]{64}$/)
  assert.equal(first.value.entries.length, 2)
  assert.match(first.value.entries[0].fact_id, /^fact:project\/@hello/)
  assert.equal(first.value.entries[0].graph_revision, reviewed.value.graph_revision)
  assert.equal(first.value.entries[0].module_interface_digest, interfaceDigest)
  assert.ok(first.value.entries.every(
    (entry) => reviewed.value.uid_anchors.includes(entry.uid_anchor),
  ))
  assert.ok(Array.isArray(first.value.entries[0].path))
  assert.notEqual(first.value.next_cursor, null)

  const second = buildProjectReviewIndex(reviewed.value, {
    cursor: first.value.next_cursor,
    limit: 50,
  })
  assert.equal(second.ok, true)
  const factIds = [
    ...first.value.entries.map(({ fact_id }) => fact_id),
    ...second.value.entries.map(({ fact_id }) => fact_id),
  ]
  assert.deepEqual(factIds, [...factIds].sort())
  assert.equal(new Set(factIds).size, factIds.length)
  assert.ok(factIds.some((id) => id.includes('/capability/')))
  assert.ok(factIds.some((id) => id.includes('/effect/')))
  assert.ok(factIds.some((id) => id.includes('/error-path/')))
  assert.ok(second.value.entries
    .filter((entry) => entry.kind === 'error_path')
    .every((entry) => reviewed.value.uid_anchors.includes(entry.uid_anchor)))
})

test('project review index supports changed-since without becoming truth source', () => {
  const reviewed = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(reviewed.ok, true)
  const reviewedIndex = buildProjectReviewIndex(reviewed.value)
  assert.equal(reviewedIndex.ok, true)
  const unchanged = buildProjectReviewIndex(reviewed.value, {
    changedSince: reviewedIndex.value.index_revision,
  })
  assert.equal(unchanged.ok, true)
  assert.deepEqual(unchanged.value.entries, [])

  const changed = reviewSource(hello.replace('Hello, World!', 'Hello, Index!'), {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(changed.ok, true)
  const changedIndex = buildProjectReviewIndex(changed.value, {
    changedSince: reviewed.value.graph_revision,
  })
  assert.equal(changedIndex.ok, true)
  assert.ok(changedIndex.value.entries.length > 0)
  assert.ok(changedIndex.value.entries.every(
    (entry) => entry.graph_revision === changed.value.graph_revision,
  ))

  const interfaceChanged = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: moduleInterfaceDigest({
      dependencies: [],
      exports: [{ contract_digest: 'sha256:' + 'a'.repeat(64), kind: 'function', name: 'main' }],
      module: 'hello',
      schema: 're.module-interface@0.1.0',
    }),
  })
  assert.equal(interfaceChanged.ok, true)
  const interfaceChangedIndex = buildProjectReviewIndex(interfaceChanged.value)
  assert.equal(interfaceChangedIndex.ok, true)
  const interfaceIndex = buildProjectReviewIndex(interfaceChanged.value, {
    changedSince: reviewedIndex.value.index_revision,
  })
  assert.equal(interfaceIndex.ok, true)
  assert.ok(interfaceIndex.value.entries.length > 0)
  assert.equal(interfaceIndex.value.index_revision, interfaceChangedIndex.value.index_revision)
  assert.notEqual(interfaceIndex.value.index_revision, reviewedIndex.value.index_revision)
  assert.ok(interfaceIndex.value.entries.every(
    (entry) => entry.module_interface_digest !== interfaceDigest,
  ))
})

test('project review index fails closed for invalid paging inputs', () => {
  const reviewed = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(reviewed.ok, true)

  const badCursor = buildProjectReviewIndex(reviewed.value, { cursor: 'page:2' })
  assert.deepEqual(badCursor, {
    diagnostics: [{ code: 'invalid-review-index-cursor', cursor: 'page:2' }],
    ok: false,
  })
  const badLimit = buildProjectReviewIndex(reviewed.value, { limit: 0 })
  assert.deepEqual(badLimit, {
    diagnostics: [{ code: 'invalid-review-index-limit', limit: 0 }],
    ok: false,
  })
})

test('project review index requires a validated module interface digest', () => {
  const reviewed = reviewSource(hello, { file: 'hello.re' })
  assert.equal(reviewed.ok, true)
  assert.deepEqual(buildProjectReviewIndex(reviewed.value), {
    diagnostics: [{ code: 'review-index-module-interface-digest-required' }],
    ok: false,
  })
})

test('project review facts expand by revision-pinned stable fact ID', () => {
  const reviewed = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(reviewed.ok, true)
  const index = buildProjectReviewIndex(reviewed.value)
  assert.equal(index.ok, true)
  const effect = index.value.entries.find(({ kind }) => kind === 'effect')
  const expanded = expandProjectReviewFact(reviewed.value, {
    factId: effect.fact_id,
    indexRevision: index.value.index_revision,
  })

  assert.equal(expanded.ok, true)
  assert.equal(expanded.value.schema, 're.project-review-fact@0.1.0')
  assert.deepEqual(expanded.value.fact, effect)
  assert.equal(expanded.value.detail.call_uid, effect.uid_anchor)
  assert.equal(expanded.value.index_revision, index.value.index_revision)
})

test('project review fact expansion rejects stale or unknown identities', () => {
  const reviewed = reviewSource(hello, {
    file: 'hello.re',
    moduleInterfaceDigest: interfaceDigest,
  })
  assert.equal(reviewed.ok, true)
  const index = buildProjectReviewIndex(reviewed.value)
  assert.equal(index.ok, true)

  const stale = expandProjectReviewFact(reviewed.value, {
    factId: index.value.entries[0].fact_id,
    indexRevision: 'sha256:' + '0'.repeat(64),
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.diagnostics[0].code, 'review-index-revision-mismatch')
  assert.equal(stale.diagnostics[0].actual, index.value.index_revision)

  assert.deepEqual(expandProjectReviewFact(reviewed.value, {
    factId: 'fact:project/@hello/missing',
    indexRevision: index.value.index_revision,
  }), {
    diagnostics: [{
      code: 'review-fact-not-found',
      fact_id: 'fact:project/@hello/missing',
    }],
    ok: false,
  })
})
