import assert from 'node:assert/strict'
import test from 'node:test'

import { applyProjectPatch } from '../src/toolchain/project-patch.js'
import { buildFactLedger } from '../src/toolchain/fact-ledger.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`
const uid = (letter) => `${letter.repeat(25)}e`

function project() {
  return {
    allowed_capabilities: ['db.read@0.1.0'],
    graph_revision: digest('a'),
    modules: [{
      dependencies: [],
      name: 'api',
      uid: uid('a'),
      source_sha256: digest('b'),
      states: [{ name: 'draft', uid: uid('b') }],
      tasks: [{ name: 'review', task_id: digest('c') }],
    }],
    package_digest: digest('d'),
  }
}

function patch(base, operations) {
  return {
    base_revision: base,
    operations,
    schema: 're.project-patch@0.1.0',
  }
}

test('project patch atomically renames and moves while preserving module UID', () => {
  const input = project()
  const result = applyProjectPatch(input, patch(input.graph_revision, [
    {
      expected_uid: uid('a'),
      kind: 'rename-module',
      module: 'api',
      new_name: 'review_api',
    },
    {
      expected_uid: uid('a'),
      kind: 'move-module',
      module: 'review_api',
      new_path: 'review/api.re',
    },
  ]))
  assert.equal(result.ok, true)
  assert.equal(result.project.modules[0].name, 'review_api')
  assert.equal(result.project.modules[0].relative_path, 'review/api.re')
  assert.equal(result.project.modules[0].uid, uid('a'))
  assert.match(result.receipt.patch_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.ok(result.receipt.changed_fact_ids.includes('fact:project/module/api'))
})

test('project patch creates identities inside the transaction and reports changed facts', () => {
  const input = project()
  const result = applyProjectPatch(input, patch(input.graph_revision, [
    {
      kind: 'add-state',
      module: 'api',
      value: { name: 'approved' },
    },
    {
      kind: 'add-task',
      module: 'api',
      value: { name: 'notify' },
    },
  ]), { uidFactory: (() => {
    let count = 0
    return () => uid(String.fromCharCode(99 + count++))
  })() })
  assert.equal(result.ok, true)
  assert.equal(result.project.modules[0].states.length, 2)
  assert.equal(result.project.modules[0].tasks.length, 2)
  assert.ok(result.receipt.changed_fact_ids.length > 0)
  assert.equal(buildFactLedger(input).value.facts.length > 0, true)
})

test('project patch rejects stale UID, dependency cycles, escalation, and partial apply', () => {
  const input = project()
  const before = JSON.stringify(input)
  const stale = applyProjectPatch(input, patch(input.graph_revision, [
    {
      expected_uid: uid('z'),
      kind: 'rename-module',
      module: 'api',
      new_name: 'bad',
    },
  ]))
  assert.equal(stale.ok, false)
  assert.equal(JSON.stringify(input), before)

  const cycle = applyProjectPatch(input, patch(input.graph_revision, [{
    kind: 'add-module',
    module: { dependencies: ['api'], name: 'worker' },
  }]))
  assert.equal(cycle.ok, true)
  const cycle2 = applyProjectPatch(cycle.project, patch(cycle.project.graph_revision, [{
    kind: 'rename-module',
    module: 'api',
    expected_uid: uid('a'),
    new_name: 'worker',
  }]))
  assert.equal(cycle2.ok, false)

  const escalation = applyProjectPatch(input, patch(input.graph_revision, [{
    kind: 'add-capability',
    module: 'api',
    value: { reference: 'secret.read@0.1.0' },
  }]))
  assert.equal(escalation.diagnostics[0].code, 'project-patch-capability-escalation')
})

test('project patch allocates all new identities transactionally and rewrites renamed dependencies', () => {
  const input = project()
  input.modules.push({
    dependencies: ['api'],
    name: 'worker',
    uid: uid('c'),
    source_sha256: digest('e'),
  })
  const result = applyProjectPatch(input, patch(input.graph_revision, [
    {
      expected_uid: uid('a'),
      kind: 'rename-module',
      module: 'api',
      new_name: 'review_api',
    },
    {
      kind: 'add-module',
      module: { dependencies: ['review_api'], name: 'notify' },
    },
    {
      kind: 'add-state',
      module: 'review_api',
      value: { name: 'approved' },
    },
  ]), { uidFactory: (() => {
    let next = 0
    return () => uid(String.fromCharCode(100 + next++))
  })() })
  assert.equal(result.ok, true)
  assert.deepEqual(result.project.modules.map(({ name, dependencies }) => [name, dependencies]), [
    ['review_api', []],
    ['worker', ['review_api']],
    ['notify', ['review_api']],
  ])
  assert.equal(result.project.modules[0].states[1].uid, uid('e'))
  assert.equal(result.project.modules[2].uid, uid('d'))
})

test('project patch rejects caller-supplied identities and missing nested module', () => {
  const input = project()
  const supplied = applyProjectPatch(input, patch(input.graph_revision, [{
    kind: 'add-module',
    module: { name: 'worker', uid: uid('c') },
  }]))
  assert.equal(supplied.diagnostics[0].code, 'project-patch-caller-uid-forbidden')

  const missingModule = applyProjectPatch(input, patch(input.graph_revision, [{
    kind: 'add-state',
    value: { name: 'approved' },
  }]))
  assert.equal(missingModule.diagnostics[0].code, 'project-patch-module-required')
})
