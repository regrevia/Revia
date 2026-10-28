import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'

const INDEX_SCHEMA = 're.project-review-index@0.2.0'
const FACT_SCHEMA = 're.project-review-fact@0.2.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export function buildProjectReviewIndex(project, {
  changedSince = null,
  cursor = null,
  limit = 50,
} = {}) {
  try {
    const ledger = buildFactLedger(project)
    if (!ledger.ok) throw diagnostic(ledger.diagnostics[0].code)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw diagnostic('invalid-review-index-limit', { limit })
    }
    const indexRevision = indexRevisionFor(project.graph_revision, ledger.value.fact_digest)
    if (changedSince !== null && typeof changedSince !== 'string') {
      throw diagnostic('invalid-review-index-changed-since')
    }
    const selected = changedSince === indexRevision
      ? []
      : ledger.value.facts
    const start = decodeCursor(cursor, selected.length)
    const entries = selected.slice(start, start + limit).map((fact) => ({
      fact_id: fact.fact_id,
      graph_revision: fact.graph_revision,
      index_revision: indexRevision,
      kind: fact.kind,
      path: [...fact.path],
      source_sha256: fact.source_sha256,
      summary: fact.summary,
      uid_anchor: fact.uid_anchor,
    }))
    return {
      ok: true,
      value: {
        entries,
        fact_digest: ledger.value.fact_digest,
        graph_revision: project.graph_revision,
        index_revision: indexRevision,
        next_cursor: start + limit < selected.length ? `offset:${start + limit}` : null,
        schema: INDEX_SCHEMA,
      },
    }
  } catch (error) {
    return { diagnostics: [error?.diagnostic ?? { code: 'invalid-project-review-index' }], ok: false }
  }
}

export function expandProjectReviewFact(project, {
  factId,
  indexRevision,
} = {}) {
  try {
    const ledger = buildFactLedger(project)
    if (!ledger.ok) throw diagnostic(ledger.diagnostics[0].code)
    const actual = indexRevisionFor(project.graph_revision, ledger.value.fact_digest)
    if (indexRevision !== actual) throw diagnostic('review-index-revision-mismatch')
    const fact = ledger.value.facts.find((candidate) => candidate.fact_id === factId)
    if (fact === undefined) throw diagnostic('review-fact-not-found', { fact_id: factId })
    return {
      ok: true,
      value: {
        fact: { ...fact, value: structuredClone(fact.value) },
        index_revision: actual,
        schema: FACT_SCHEMA,
      },
    }
  } catch (error) {
    return { diagnostics: [error?.diagnostic ?? { code: 'invalid-project-review-fact' }], ok: false }
  }
}

export function indexRevisionFor(graphRevision, factDigest) {
  if (!DIGEST.test(graphRevision) || !DIGEST.test(factDigest)) {
    throw diagnostic('invalid-review-index-revision-input')
  }
  return `sha256:${createHash('sha256').update(`${graphRevision}\0${factDigest}`).digest('hex')}`
}

function decodeCursor(cursor, length) {
  if (cursor === null || cursor === undefined) return 0
  if (typeof cursor !== 'string' || !/^offset:[0-9]+$/u.test(cursor)) {
    throw diagnostic('invalid-review-index-cursor')
  }
  const value = Number(cursor.slice('offset:'.length))
  if (!Number.isSafeInteger(value) || value > length) throw diagnostic('invalid-review-index-cursor')
  return value
}

function diagnostic(code, details = {}) {
  return Object.assign(new TypeError(code), { diagnostic: { code, ...details } })
}
