import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'
import {
  buildHumanSemanticReview,
  createHumanSemanticReviewDecision,
  renderHumanSemanticReview,
  verifyHumanSemanticReview,
  verifyHumanSemanticReviewDecision,
  verifyHumanSemanticReviewRenderings,
} from './human-semantic-review.js'
import { indexRevisionFor } from './project-review-index.js'

const SCHEMA = 're.human-semantic-review-conformance@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const EXPECTED_CASES = [
  'ordinary-modification',
  'high-risk-additions',
  'zero-semantic-reorder',
  'unsupported-template',
  'stale-revision',
  'renderer-drift',
  'fact-omission',
  'approve-decision',
  'reject-decision',
  'decision-forgery',
]

export function runHumanSemanticReviewConformance({
  corpus,
  project,
  source_authority,
  toolchain_digest,
}) {
  validateInputs({ corpus, project, source_authority, toolchain_digest })

  const ordinaryBefore = clone(project)
  const ordinaryAfter = renamedStateProject(ordinaryBefore, 'approved', 'ordinary-after')
  const ordinaryInputs = reviewInputs(ordinaryBefore, ordinaryAfter)
  const ordinaryReview = requireValue(buildHumanSemanticReview(ordinaryInputs))
  const ordinaryRenderings = requireValue(renderHumanSemanticReview(ordinaryReview))
  requireOk(verifyHumanSemanticReview(ordinaryReview, ordinaryInputs))
  requireOk(verifyHumanSemanticReviewRenderings(ordinaryReview, ordinaryRenderings))

  const highRiskBefore = clone(project)
  const highRiskAfter = highRiskProject(highRiskBefore)
  const highRiskReview = requireValue(buildHumanSemanticReview(
    reviewInputs(highRiskBefore, highRiskAfter),
  ))

  const reorderBefore = reorderBaseline(project)
  const reorderAfter = clone(reorderBefore)
  reorderAfter.graph_revision = fixedDigest('reorder-after')
  reorderAfter.project_digest = reorderAfter.graph_revision
  reorderAfter.modules[0].source_sha256 = fixedDigest('reorder-source-after')
  reorderAfter.modules[0].states.reverse()
  reorderAfter.modules[0].surface.errors.reverse()
  const reorderReview = requireValue(buildHumanSemanticReview(
    reviewInputs(reorderBefore, reorderAfter),
  ))

  const graphBefore = canonicalJson(ordinaryBefore)
  const graphAfter = canonicalJson(ordinaryAfter)
  const approved = requireValue(createHumanSemanticReviewDecision(ordinaryReview, {
    current_base_revision: ordinaryReview.base_revision,
    current_result_revision: ordinaryReview.result_revision,
    decision: 'approve',
  }))
  const rejected = requireValue(createHumanSemanticReviewDecision(ordinaryReview, {
    current_base_revision: ordinaryReview.base_revision,
    current_result_revision: ordinaryReview.result_revision,
    decision: 'reject',
  }))
  requireOk(verifyHumanSemanticReviewDecision(approved, ordinaryReview, {
    current_base_revision: ordinaryReview.base_revision,
    current_result_revision: ordinaryReview.result_revision,
  }))
  requireOk(verifyHumanSemanticReviewDecision(rejected, ordinaryReview, {
    current_base_revision: ordinaryReview.base_revision,
    current_result_revision: ordinaryReview.result_revision,
  }))

  const observations = new Map()
  observations.set('ordinary-modification', (
    ordinaryReview.changes.modified.length === 1
    && ordinaryReview.changes.added.length === 0
    && ordinaryReview.changes.removed.length === 0
  ) ? 'success' : 'ordinary-change-mismatch')
  observations.set(
    'high-risk-additions',
    highRiskReview.risk_flags.map(({ code }) => code).join(','),
  )
  observations.set('zero-semantic-reorder', changeCount(reorderReview) === 0
    ? 'zero-semantic-change'
    : 'semantic-change-detected')

  const missingTemplate = renderHumanSemanticReview(ordinaryReview, {
    template_registry: { 'en-US': [], 'zh-CN': [] },
  })
  observations.set('unsupported-template', observedCode(missingTemplate))

  const staleInputs = clone(ordinaryInputs)
  staleInputs.receipt.result_revision = fixedDigest('stale-result')
  observations.set(
    'stale-revision',
    observedCode(buildHumanSemanticReview(staleInputs)),
  )

  const drifted = clone(ordinaryRenderings)
  drifted.svg.content = `${drifted.svg.content}drift`
  observations.set(
    'renderer-drift',
    observedCode(verifyHumanSemanticReviewRenderings(ordinaryReview, drifted)),
  )

  const omitted = clone(ordinaryReview)
  omitted.semantic_facts.after.pop()
  omitted.semantic_fact_digest = digest(omitted.semantic_facts)
  omitted.changes.unchanged_count -= 1
  resign(omitted, 'review_digest')
  observations.set(
    'fact-omission',
    observedCode(verifyHumanSemanticReview(omitted, ordinaryInputs)),
  )

  observations.set(
    'approve-decision',
    observedCode(verifyHumanSemanticReviewDecision(approved, ordinaryReview, {
      current_base_revision: ordinaryReview.base_revision,
      current_result_revision: ordinaryReview.result_revision,
    })),
  )
  observations.set(
    'reject-decision',
    observedCode(verifyHumanSemanticReviewDecision(rejected, ordinaryReview, {
      current_base_revision: ordinaryReview.base_revision,
      current_result_revision: ordinaryReview.result_revision,
    })),
  )

  const forgedDecision = clone(approved)
  forgedDecision.review_digest = fixedDigest('other-review')
  resign(forgedDecision, 'decision_digest')
  observations.set(
    'decision-forgery',
    observedCode(verifyHumanSemanticReviewDecision(
      forgedDecision,
      ordinaryReview,
      {
        current_base_revision: ordinaryReview.base_revision,
        current_result_revision: ordinaryReview.result_revision,
      },
    )),
  )

  const cases = corpus.cases.map((entry) => {
    const observed = observations.get(entry.id)
    if (observed !== entry.expect) {
      fail('human-review-conformance-case-mismatch', {
        actual: observed ?? null,
        expected: entry.expect,
        id: entry.id,
      })
    }
    return {
      expected: entry.expect,
      id: entry.id,
      observed,
      status: 'pass',
    }
  })
  const content = {
    authority: {
      corpus_digest: digest(corpus),
      project_digest: digest(project),
      source_authority: clone(source_authority),
      toolchain_digest,
    },
    cases,
    evidence: {
      approve_decision_digest: approved.decision_digest,
      graph_unchanged: canonicalJson(ordinaryBefore) === graphBefore
        && canonicalJson(ordinaryAfter) === graphAfter,
      reject_decision_digest: rejected.decision_digest,
      renderer_content_digests: Object.fromEntries(Object.entries(
        ordinaryRenderings,
      ).map(([medium, rendering]) => [medium, rendering.content_digest])),
      review_digest: ordinaryReview.review_digest,
      risk_codes: highRiskReview.risk_flags.map(({ code }) => code),
      semantic_fact_digest: ordinaryReview.semantic_fact_digest,
      zero_semantic_change_count: changeCount(reorderReview),
    },
    schema: SCHEMA,
    status: 'pass',
  }
  return {
    ...content,
    report_digest: digest(content),
  }
}

export function verifyHumanSemanticReviewConformance(report, inputs) {
  try {
    exactFields(report, [
      'authority',
      'cases',
      'evidence',
      'report_digest',
      'schema',
      'status',
    ], 'human-review-conformance-report')
    if (report.schema !== SCHEMA || report.status !== 'pass'
      || !DIGEST.test(report.report_digest)) {
      fail('invalid-human-review-conformance-report')
    }
    const { report_digest: reportDigest, ...content } = report
    if (reportDigest !== digest(content)) {
      fail('human-review-conformance-report-digest-mismatch')
    }
    const expected = runHumanSemanticReviewConformance(inputs)
    if (canonicalJson(report) !== canonicalJson(expected)) {
      fail('human-review-conformance-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error, 'invalid-human-review-conformance-report')
  }
}

function reviewInputs(before, after) {
  const beforeLedger = requireLedger(before)
  const afterLedger = requireLedger(after)
  const proposalContent = {
    affected: [{
      fact_id: 'fact:project/module/api/state/draft',
      uid: 'bbbbbbbbbbbbbbbbbbbbbbbbbe',
      value_digest: digest({ name: 'draft', uid: 'bbbbbbbbbbbbbbbbbbbbbbbbbe' }),
    }],
    base_revision: before.graph_revision,
    impact: {
      capabilities_added: [],
      capabilities_removed: [],
      effects_added: [],
      effects_removed: [],
    },
    index_revision: indexRevisionFor(before.graph_revision, beforeLedger.fact_digest),
    operations: [{
      kind: 'rename-state',
      module: 'api',
      new_name: 'approved',
      uid: 'bbbbbbbbbbbbbbbbbbbbbbbbbe',
    }],
    schema: 're.agent-authoring-proposal@0.1.0',
  }
  const proposal = {
    ...proposalContent,
    proposal_digest: digest(proposalContent),
  }
  const patchReceipt = {
    base_revision: before.graph_revision,
    changed_fact_ids: changedFactIds(beforeLedger.facts, afterLedger.facts),
    operations: clone(proposal.operations),
    patch_digest: digest({
      base_revision: before.graph_revision,
      operations: proposal.operations,
      result_revision: after.graph_revision,
    }),
    result_revision: after.graph_revision,
    schema: 're.project-patch-receipt@0.1.0',
  }
  const check = {
    graph_revision: after.graph_revision,
    result_digest: digest({
      fact_digest: afterLedger.fact_digest,
      graph_revision: after.graph_revision,
      status: 'passed',
    }),
    schema: 're.agent-authoring-check-evidence@0.1.0',
  }
  const dryRunContent = {
    base_revision: before.graph_revision,
    check,
    index_revision: proposal.index_revision,
    patch_receipt: patchReceipt,
    proposal_digest: proposal.proposal_digest,
    result_revision: after.graph_revision,
    schema: 're.agent-authoring-dry-run@0.1.0',
    semantic_diff: semanticDiff(beforeLedger.facts, afterLedger.facts),
  }
  const dryRun = {
    ...dryRunContent,
    dry_run_digest: digest(dryRunContent),
  }
  const tool = (name) => ({
    graph_revision: after.graph_revision,
    result_digest: digest({ graph_revision: after.graph_revision, name }),
    schema: 're.agent-authoring-tool-evidence@0.1.0',
  })
  const receiptContent = {
    approval_digest: fixedDigest('review-approval'),
    base_revision: before.graph_revision,
    dry_run_digest: dryRun.dry_run_digest,
    patch_receipt: patchReceipt,
    proposal_digest: proposal.proposal_digest,
    result_revision: after.graph_revision,
    schema: 're.agent-authoring-receipt@0.1.0',
    toolchain: {
      audit: { ...tool('audit'), fact_digest: afterLedger.fact_digest },
      check,
      manifest: {
        ...tool('manifest'),
        fact_digest: afterLedger.fact_digest,
        index_revision: indexRevisionFor(after.graph_revision, afterLedger.fact_digest),
      },
      run: tool('run'),
      translate: {
        ...tool('translate'),
        semantic_fact_digest: digest(afterLedger.facts),
        translation_digest: digest({
          facts: afterLedger.facts.map(({ fact_id: factId }) => factId),
          graph_revision: after.graph_revision,
        }),
      },
    },
  }
  return {
    after_project: after,
    before_project: before,
    dry_run: dryRun,
    proposal,
    receipt: {
      ...receiptContent,
      receipt_digest: digest(receiptContent),
    },
  }
}

function renamedStateProject(project, name, revisionSeed) {
  const output = clone(project)
  output.graph_revision = fixedDigest(revisionSeed)
  output.project_digest = output.graph_revision
  output.modules[0].source_sha256 = fixedDigest(`${revisionSeed}-source`)
  output.modules[0].states[0].name = name
  return output
}

function highRiskProject(project) {
  const output = clone(project)
  output.graph_revision = fixedDigest('high-risk-after')
  output.project_digest = output.graph_revision
  output.modules[0].surface.capabilities.push({
    instance: '@secret',
    member: 'read',
    reference: 'secret.read@0.1.0',
    uid: 'hhhhhhhhhhhhhhhhhhhhhhhhhe',
  })
  output.modules[0].surface.errors.push({
    name: 'denied',
    uid: 'iiiiiiiiiiiiiiiiiiiiiiiiie',
  })
  output.modules[0].tasks.push({
    effects: [{ id: 'secret.read' }],
    lifecycle: { retry: 'never' },
    name: 'load-secret',
    task_id: fixedDigest('high-risk-task'),
  })
  return output
}

function reorderBaseline(project) {
  const output = clone(project)
  output.modules[0].states.push({
    name: 'reviewing',
    uid: 'jjjjjjjjjjjjjjjjjjjjjjjjje',
  })
  output.modules[0].surface.errors.push({
    name: 'unavailable',
    uid: 'kkkkkkkkkkkkkkkkkkkkkkkkke',
  })
  return output
}

function semanticDiff(beforeFacts, afterFacts) {
  const before = new Map(beforeFacts.map((fact) => [fact.fact_id, fact]))
  const after = new Map(afterFacts.map((fact) => [fact.fact_id, fact]))
  const groups = { added: [], modified: [], removed: [] }
  for (const [factId, fact] of before) {
    const next = after.get(factId)
    if (next === undefined) {
      groups.removed.push(delta(fact, null))
    } else if (canonicalJson(fact.value) !== canonicalJson(next.value)) {
      groups.modified.push(delta(fact, next))
    }
    after.delete(factId)
  }
  for (const fact of after.values()) groups.added.push(delta(null, fact))
  for (const values of Object.values(groups)) values.sort(compareFactId)
  return {
    ...groups,
    schema: 're.agent-authoring-semantic-diff@0.1.0',
  }
}

function delta(before, after) {
  const fact = after ?? before
  return {
    after_digest: after === null ? null : digest(after.value),
    before_digest: before === null ? null : digest(before.value),
    fact_id: fact.fact_id,
    kind: fact.kind,
  }
}

function changedFactIds(beforeFacts, afterFacts) {
  const after = new Map(afterFacts.map((fact) => [fact.fact_id, fact]))
  const changed = []
  for (const fact of beforeFacts) {
    const next = after.get(fact.fact_id)
    if (next === undefined || canonicalJson(fact) !== canonicalJson(next)) {
      changed.push(fact.fact_id)
    }
    after.delete(fact.fact_id)
  }
  changed.push(...after.keys())
  return changed.sort(compareText)
}

function changeCount(review) {
  return review.changes.added.length
    + review.changes.modified.length
    + review.changes.removed.length
}

function observedCode(result) {
  return result.ok ? 'success' : result.diagnostics[0].code
}

function requireValue(result) {
  if (!result.ok) fail(result.diagnostics[0].code)
  return result.value
}

function requireOk(result) {
  if (!result.ok) fail(result.diagnostics[0].code)
}

function requireLedger(project) {
  const ledger = buildFactLedger(project)
  if (!ledger.ok) fail(ledger.diagnostics[0].code)
  return ledger.value
}

function validateInputs({ corpus, project, source_authority, toolchain_digest }) {
  if (!isObject(corpus)
    || corpus.schema !== 're.human-semantic-review-corpus@0.1.0'
    || !Array.isArray(corpus.cases)
    || canonicalJson(corpus.cases.map(({ id }) => id)) !== canonicalJson(EXPECTED_CASES)
    || corpus.cases.some((entry) =>
      !isObject(entry)
      || !['expect', 'id', 'rule'].every((field) => typeof entry[field] === 'string'))
    || !isObject(project)
    || !DIGEST.test(project.graph_revision)
    || !isObject(source_authority)
    || Object.keys(source_authority).length === 0
    || Object.entries(source_authority).some(([path, value]) =>
      typeof path !== 'string' || !DIGEST.test(value))
    || !DIGEST.test(toolchain_digest)) {
    fail('invalid-human-review-conformance-input')
  }
}

function resign(value, field) {
  const content = clone(value)
  delete content[field]
  value[field] = digest(content)
}

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
    .digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactFields(value, fields, name) {
  if (!isObject(value)
    || canonicalJson(Object.keys(value).sort(compareText))
      !== canonicalJson([...fields].sort(compareText))) {
    fail(`invalid-${name}`)
  }
}

function compareFactId(left, right) {
  return compareText(left.fact_id, right.fact_id)
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function clone(value) {
  return structuredClone(value)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rejected(error, fallback) {
  return {
    diagnostics: [error?.diagnostic ?? { code: fallback }],
    ok: false,
  }
}

function fail(code, details = {}) {
  throw Object.assign(new TypeError(code), {
    diagnostic: { code, ...details },
  })
}
