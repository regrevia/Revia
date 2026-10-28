import assert from 'node:assert/strict'
import test from 'node:test'

import { translateProject } from '../src/toolchain/project-translator.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`
const uid = (letter) => `${letter.repeat(25)}e`

function project() {
  return {
    agents: [{
      agent: 'expense.review',
      contract: {
        events: ['ready'],
        initial_state: 'created',
        states: ['created', 'succeeded'],
        terminal_states: [{ outcome: 'succeeded', state: 'succeeded' }],
        transitions: [{ event: 'ready', from: 'created', to: 'succeeded' }],
      },
      module: 'api',
      node_uid: uid('a'),
    }],
    allowed_capabilities: ['db.read@0.1.0'],
    graph_revision: digest('a'),
    modules: [{
      capabilities: [{ name: 'db', reference: 'db.read@0.1.0', uid: uid('b') }],
      edges: [{ from: 'start', to: 'finish', uid: uid('c') }],
      errors: [{ name: 'invalid', uid: uid('d') }],
      name: 'api',
      source_sha256: digest('b'),
      states: [{ name: 'created', uid: uid('e') }],
      tasks: [{ name: 'review', task_id: digest('c') }],
      surface: {
        capabilities: [{ name: 'db', reference: 'db.read@0.1.0', uid: uid('b') }],
        errors: [{ name: 'invalid', uid: uid('d') }],
      },
    }],
    resources: [{ alias: 'database', uid: uid('f') }],
  }
}

test('project translation emits one fact-preserving receipt for all media', () => {
  const result = translateProject(project(), { locale: 'zh-CN' })
  assert.equal(result.ok, true)
  assert.equal(result.value.schema, 're.project-translation@0.1.0')
  assert.equal(result.value.renderings.text.match(/fact:/gu).length >= result.value.facts.length, true)
  assert.equal((result.value.renderings.html.match(/data-fact-id=/gu) ?? []).length, result.value.facts.length)
  assert.equal((result.value.renderings.svg.match(/data-fact-id=/gu) ?? []).length, result.value.facts.length)
  assert.deepEqual(result.value.receipt.fact_ids, result.value.facts.map(({ fact_id: id }) => id))
})

test('locale changes wording but not semantic identity or translation digest', () => {
  const chinese = translateProject(project(), { locale: 'zh-CN' })
  const english = translateProject(project(), { locale: 'en-US' })
  assert.equal(chinese.ok, true)
  assert.equal(english.ok, true)
  assert.equal(chinese.value.semantic_fact_digest, english.value.semantic_fact_digest)
  assert.equal(chinese.value.receipt.translation_digest, english.value.receipt.translation_digest)
  assert.notEqual(chinese.value.renderings.text, english.value.renderings.text)
})

test('project translation fails closed on incomplete, invalid, or mismatched input', () => {
  const incomplete = translateProject({ ...project(), resources: [] })
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.diagnostics[0].code, 'project-translation-incomplete')

  const invalid = translateProject({ ...project(), graph_revision: 'stale' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.diagnostics[0].code, 'invalid-project-translation-project')
  const mismatch = translateProject(project(), {
    semanticView: { facts: [], graph_revision: digest('z'), semantic_fact_digest: digest('z') },
  })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.diagnostics[0].code, 'project-translation-semantic-view-mismatch')
})
