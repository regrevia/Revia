import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSemanticViewIR } from '../src/toolchain/semantic-view-ir.js'
import { buildFactLedger } from '../src/toolchain/fact-ledger.js'

const digest = (letter) => `sha256:${letter.repeat(64)}`

const project = {
  graph_revision: digest('a'),
  modules: [{
    name: 'api',
    source_sha256: digest('b'),
    surface: { capabilities: [], errors: [] },
  }],
}

test('semantic view IR derives one fact identity across locales', () => {
  const chinese = buildSemanticViewIR(project, { locale: 'zh-CN' })
  const english = buildSemanticViewIR(project, { locale: 'en-US' })
  assert.equal(chinese.ok, true)
  assert.equal(english.ok, true)
  assert.equal(chinese.value.schema, 're.semantic-view-ir@0.2.0')
  assert.equal(chinese.value.semantic_fact_digest, english.value.semantic_fact_digest)
  assert.deepEqual(
    chinese.value.facts.map(({ fact_id }) => fact_id),
    english.value.facts.map(({ fact_id }) => fact_id),
  )
  assert.notEqual(chinese.value.locale, english.value.locale)
  assert.match(chinese.value.semantic_fact_digest, /^sha256:[0-9a-f]{64}$/u)
})

test('semantic view rejects unsupported locale and keeps ledger evidence', () => {
  assert.equal(buildSemanticViewIR(project, { locale: 'fr-FR' }).ok, false)
  const ledger = buildFactLedger(project)
  const view = buildSemanticViewIR(project)
  assert.equal(view.value.facts.length, ledger.value.facts.length)
  assert.ok(view.value.facts.every((fact) => fact.graph_revision === project.graph_revision))
})
