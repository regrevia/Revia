import assert from 'node:assert/strict'
import test from 'node:test'

import { createProductionBackend } from '../src/runtime/production-backend.js'
import { createReferenceBackend } from '../src/runtime/reference-backend.js'
import { loadProjectDirectory } from '../src/toolchain/project-loader.js'

const fixture = new URL('./fixtures/agent-expense-review/', import.meta.url)
const digest = (character) => `sha256:${character.repeat(64)}`

test('reference and production backends are equivalent on the checked project corpus', async () => {
  const loaded = await loadProjectDirectory(fixture.pathname)
  assert.equal(loaded.ok, true)
  const project = enrichProject(loaded.value)
  const identity = {
    artifact_digest: digest('a'),
    profile_digest: digest('b'),
    toolchain_digest: digest('c'),
  }
  const reference = createReferenceBackend(identity)
  const production = createProductionBackend(identity)
  assert.deepEqual(reference.check(project), { ok: true })
  assert.deepEqual(production.check(project), { ok: true })

  for (const operation of ['identity', 'translate']) {
    const request = {
      graph_revision: project.graph_revision,
      ...(operation === 'translate'
        ? { input: { locale: 'en-US', media: 'all' } }
        : {}),
      operation,
      schema: 're.backend-request@0.1.0',
    }
    const left = reference.run(project, request)
    const right = production.run(project, request)
    assert.equal(left.ok, right.ok)
    assert.deepEqual(stripBackend(left.value), stripBackend(right.value))
  }
})

test('backend execution rejects stale graph and unsupported translation requests', async () => {
  const loaded = await loadProjectDirectory(fixture.pathname)
  const backend = createReferenceBackend({
    artifact_digest: digest('a'),
    profile_digest: digest('b'),
    toolchain_digest: digest('c'),
  })
  const stale = backend.run(loaded.value, {
    graph_revision: digest('f'),
    operation: 'identity',
    schema: 're.backend-request@0.1.0',
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.diagnostics[0].code, 'backend-request-identity-mismatch')
  const unsupported = backend.run(loaded.value, {
    graph_revision: loaded.value.graph_revision,
    input: { locale: 'fr-FR', media: 'all' },
    operation: 'translate',
    schema: 're.backend-request@0.1.0',
  })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.diagnostics[0].code, 'backend-translation-request-invalid')
})

function stripBackend(value) {
  const { backend, ...rest } = value
  return rest
}

function enrichProject(input) {
  const project = structuredClone(input)
  project.resources = [{ alias: 'expense_db', key: 'expense_db', uid: uid('f') }]
  project.modules = project.modules.map((module, index) => ({
    ...module,
    uid: uid(String.fromCharCode(97 + index)),
    edges: [{
      from: `${module.name}.input`,
      to: `${module.name}.output`,
      uid: uid(String.fromCharCode(104 + index)),
    }],
    states: [{ name: 'ready', uid: uid(String.fromCharCode(111 + index)) }],
    tasks: [{
      name: `${module.name}.task`,
      task_id: digest(String.fromCharCode(97 + index)),
    }],
    surface: {
      ...module.surface,
      capabilities: [{
        instance: `${module.name}.db`,
        member: 'write',
        reference: 'db.write@0.1.0',
        uid: uid(String.fromCharCode(117 + index)),
      }],
      errors: [{
        name: `${module.name}.error`,
        uid: uid(String.fromCharCode(50 + index)),
      }],
    },
  }))
  return project
}

function uid(letter) {
  return `${letter.repeat(25)}e`
}
