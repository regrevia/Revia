import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'
import { buildSemanticViewIR } from './semantic-view-ir.js'
import { renderProjectLocale } from './locale-renderer.js'

const SCHEMA = 're.project-translation@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REQUIRED_KINDS = new Set([
  'agent',
  'agent-event',
  'agent-transition',
  'capability',
  'edge',
  'error',
  'module',
  'project',
  'resource',
  'state',
  'task',
])

export function translateProject(project, {
  changedSince = null,
  locale = 'zh-CN',
  media = 'all',
  semanticView = null,
} = {}) {
  try {
    validateProjectRevision(project)
    if (changedSince !== null && !DIGEST.test(changedSince)) {
      fail('invalid-project-translation-changed-since')
    }
    const ledger = buildFactLedger(project)
    if (!ledger.ok) fail(ledger.diagnostics[0].code)
    const irResult = buildSemanticViewIR(project, { ledger, locale })
    if (!irResult.ok) fail(irResult.diagnostics[0].code)
    const ir = irResult.value
    if (semanticView !== null) validateSemanticView(semanticView, ir)
    const kinds = new Set(ledger.value.facts.map((fact) => fact.kind))
    for (const kind of REQUIRED_KINDS) {
      if (!kinds.has(kind)) fail('project-translation-incomplete', { kind })
    }
    const renderings = renderProjectLocale({ ...ir, changed_since: changedSince }, {
      locale,
      media,
    })
    const factIds = ledger.value.facts.map(({ fact_id: factId }) => factId)
    const receipt = {
      changed_since: changedSince,
      fact_ids: factIds,
      graph_revision: project.graph_revision,
      locale,
      media,
      schema: SCHEMA,
      semantic_fact_digest: ir.semantic_fact_digest,
      translation_digest: digest({
        changed_since: changedSince,
        fact_ids: factIds,
        graph_revision: project.graph_revision,
        semantic_fact_digest: ir.semantic_fact_digest,
        schema: SCHEMA,
      }),
    }
    return {
      ok: true,
      value: {
        changed_since: changedSince,
        facts: ir.facts,
        graph_revision: project.graph_revision,
        locale,
        receipt,
        renderings,
        schema: SCHEMA,
        semantic_fact_digest: ir.semantic_fact_digest,
      },
    }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? { code: 'invalid-project-translation' }],
      ok: false,
    }
  }
}

function validateSemanticView(input, expected) {
  if (input.graph_revision !== expected.graph_revision
    || input.semantic_fact_digest !== expected.semantic_fact_digest
    || !Array.isArray(input.facts)
    || input.facts.length !== expected.facts.length
    || input.facts.some((fact, index) => fact.fact_id !== expected.facts[index].fact_id)) {
    fail('project-translation-semantic-view-mismatch')
  }
}

function validateProjectRevision(project) {
  if (project === null || typeof project !== 'object' || !DIGEST.test(project.graph_revision)) {
    fail('invalid-project-translation-project')
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
  throw Object.assign(new TypeError(code), { diagnostic: { code, ...details } })
}
