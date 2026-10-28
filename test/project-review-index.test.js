import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFactLedger } from '../src/toolchain/fact-ledger.js'
import {
  buildProjectReviewIndex,
  expandProjectReviewFact,
} from '../src/toolchain/project-review-index.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`
const uid = 'aaaaaaaaaaaaaaaaaaaaaaaaae'

function project() {
  return {
    agents: [{
      agent: 'expense.intake',
      contract_digest: digest('b'),
      module: 'intake',
      node_uid: uid,
      states: [{ name: 'initial' }, { name: 'succeeded' }],
    }],
    graph_revision: digest('a'),
    modules: [{
      interface_digest: digest('c'),
      name: 'intake',
      module_surface_digest: digest('d'),
      source_sha256: digest('e'),
      surface: {
        capabilities: [{ instance: '@db', uid }],
        errors: [{ name: 'validation_error' }],
      },
    }],
    package_digest: digest('f'),
    project_digest: digest('a'),
    resources: [{ alias: 'expense_row', key: 'expense_row', mode: 'write' }],
    tasks: [{
      branch: 'validate',
      graph_revision: digest('a'),
      mutable_aliases: [],
      resources: [],
      scope_path: ['runtime'],
      task_id: digest('b'),
    }],
  }
}

test('project review index includes typed project facts with stable pagination', () => {
  const value = project()
  const ledger = buildFactLedger(value)
  assert.equal(ledger.ok, true)
  const first = buildProjectReviewIndex(value, { limit: 3 })
  assert.equal(first.ok, true)
  assert.equal(first.value.schema, 're.project-review-index@0.2.0')
  assert.equal(first.value.fact_digest, ledger.value.fact_digest)
  assert.equal(first.value.entries.length, 3)
  assert.notEqual(first.value.next_cursor, null)
  const second = buildProjectReviewIndex(value, {
    cursor: first.value.next_cursor,
    limit: 100,
  })
  assert.equal(second.ok, true)
  const ids = [...first.value.entries, ...second.value.entries].map(({ fact_id }) => fact_id)
  assert.deepEqual(ids, [...ids].sort())
  assert.ok(ids.some((id) => id.includes('/agent/')))
  assert.ok(ids.some((id) => id.includes('/task/')))
  assert.ok(ids.some((id) => id.includes('/resource/')))
})

test('project review facts expand only against the current index revision', () => {
  const value = project()
  const index = buildProjectReviewIndex(value, { limit: 100 })
  const factId = index.value.entries.find(({ kind }) => kind === 'module').fact_id
  const expanded = expandProjectReviewFact(value, {
    factId,
    indexRevision: index.value.index_revision,
  })
  assert.equal(expanded.ok, true)
  assert.equal(expanded.value.schema, 're.project-review-fact@0.2.0')
  assert.equal(expanded.value.fact.graph_revision, value.graph_revision)
  assert.equal(expandProjectReviewFact(value, {
    factId,
    indexRevision: digest('f'),
  }).ok, false)
})

test('changed-since and malformed project inputs fail closed', () => {
  const value = project()
  const index = buildProjectReviewIndex(value, { limit: 100 })
  assert.deepEqual(
    buildProjectReviewIndex(value, {
      changedSince: index.value.index_revision,
    }).value.entries,
    [],
  )
  assert.equal(buildProjectReviewIndex(value, { cursor: 'bad' }).ok, false)
  assert.equal(buildFactLedger({ ...value, graph_revision: 'stale' }).ok, false)
})
