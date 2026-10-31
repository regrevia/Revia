import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'

const SCHEMA = 're.semantic-view-ir@0.2.0'
const LOCALES = new Set(['zh-CN', 'en-US'])

export function buildSemanticViewIR(project, { locale = 'zh-CN' } = {}) {
  try {
    if (!LOCALES.has(locale)) fail('unsupported-semantic-view-locale', { locale })
    const ledger = buildFactLedger(project)
    if (!ledger.ok) fail(ledger.diagnostics[0].code)
    const facts = ledger.value.facts.map((fact) => ({
      evidence: structuredClone(fact.evidence),
      fact_id: fact.fact_id,
      graph_revision: fact.graph_revision,
      kind: fact.kind,
      path: [...fact.path],
      source_sha256: fact.source_sha256,
      summary: fact.summary,
      uid_anchor: fact.uid_anchor,
    }))
    return {
      ok: true,
      value: {
        facts,
        graph_revision: project.graph_revision,
        locale,
        schema: SCHEMA,
        semantic_fact_digest: digest(facts),
      },
    }
  } catch (error) {
    return { diagnostics: [error?.diagnostic ?? { code: 'invalid-semantic-view' }], ok: false }
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
