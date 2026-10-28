import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'
import { indexRevisionFor } from './project-review-index.js'

const REVIEW_SCHEMA = 're.human-semantic-review@0.1.0'
const RENDERING_SCHEMA = 're.human-semantic-review-rendering@0.1.0'
const DECISION_SCHEMA = 're.human-semantic-review-decision@0.1.0'
const PROPOSAL_SCHEMA = 're.agent-authoring-proposal@0.1.0'
const DRY_RUN_SCHEMA = 're.agent-authoring-dry-run@0.1.0'
const PATCH_RECEIPT_SCHEMA = 're.project-patch-receipt@0.1.0'
const AUTHORING_RECEIPT_SCHEMA = 're.agent-authoring-receipt@0.1.0'
const CHECK_EVIDENCE_SCHEMA = 're.agent-authoring-check-evidence@0.1.0'
const TOOL_EVIDENCE_SCHEMA = 're.agent-authoring-tool-evidence@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const UID = /^[a-z2-7]{25}[aeimquy4]$/u
const LOCALES = ['zh-CN', 'en-US']
const MEDIA = ['json', 'zh-CN', 'en-US', 'html', 'svg']
const SUPPORTED_KINDS = new Set([
  'adapter-contract',
  'agent',
  'agent-event',
  'agent-transition',
  'capability',
  'concurrency-event',
  'edge',
  'error',
  'function-declaration',
  'module',
  'package',
  'project',
  'resource',
  'run-case',
  'state',
  'task',
  'task-contract',
  'type-declaration',
])
const UNORDERED_ARRAY_FIELDS = new Set([
  'capabilities',
  'dependencies',
  'effects',
  'errors',
  'events',
  'states',
  'terminal_states',
  'transitions',
  'variants',
])

export function buildHumanSemanticReview(input) {
  try {
    exactFields(input, [
      'after_project',
      'before_project',
      'dry_run',
      'proposal',
      'receipt',
    ], 'human-review-input')
    const beforeLedger = requireLedger(input.before_project)
    const afterLedger = requireLedger(input.after_project)
    validateEvidence(input, beforeLedger, afterLedger)
    const beforeFacts = semanticFacts(beforeLedger.facts)
    const afterFacts = semanticFacts(afterLedger.facts)
    const changes = classifyChanges(beforeFacts, afterFacts)
    const semanticFactsAuthority = {
      after: afterFacts,
      before: beforeFacts,
      schema: 're.human-semantic-facts@0.1.0',
    }
    const semanticFactDigest = digest(semanticFactsAuthority)
    const riskFlags = riskFlagsFor(changes)
    const content = {
      base_revision: input.before_project.graph_revision,
      changes,
      evidence: {
        check: evidenceStatus(input.dry_run.check, 'passed'),
        receipt: {
          anchor: input.receipt.receipt_digest,
          graph_revision: input.receipt.result_revision,
          status: 'bound',
        },
        run: evidenceStatus(input.receipt.toolchain.run, 'passed'),
      },
      index_revision: input.proposal.index_revision,
      proposal_digest: input.proposal.proposal_digest,
      result_revision: input.after_project.graph_revision,
      risk_flags: riskFlags,
      schema: REVIEW_SCHEMA,
      semantic_fact_digest: semanticFactDigest,
      semantic_facts: semanticFactsAuthority,
    }
    return {
      ok: true,
      value: {
        ...content,
        review_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-human-semantic-review')
  }
}

export function renderHumanSemanticReview(review, {
  template_registry: templateRegistry = defaultTemplateRegistry(),
} = {}) {
  try {
    validateReview(review)
    validateTemplates(review, templateRegistry)
    const rendered = {
      json: renderEntry(review, 'json', canonicalJson(review)),
      'zh-CN': renderEntry(review, 'zh-CN', renderText(review, 'zh-CN')),
      'en-US': renderEntry(review, 'en-US', renderText(review, 'en-US')),
      html: renderEntry(review, 'html', renderHtml(review)),
      svg: renderEntry(review, 'svg', renderSvg(review)),
    }
    return { ok: true, value: rendered }
  } catch (error) {
    return rejected(error, 'invalid-human-review-rendering')
  }
}

export function verifyHumanSemanticReview(review, input) {
  try {
    validateReview(review)
    const expected = buildHumanSemanticReview(input)
    if (!expected.ok || canonicalJson(review) !== canonicalJson(expected.value)) {
      fail('human-review-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error, 'invalid-human-semantic-review')
  }
}

export function verifyHumanSemanticReviewRenderings(review, renderings, options = {}) {
  try {
    validateReview(review)
    exactFields(renderings, MEDIA, 'human-review-renderings')
    for (const medium of MEDIA) validateRenderingEntry(renderings[medium], medium, review)
    const expected = renderHumanSemanticReview(review, options)
    if (!expected.ok || canonicalJson(renderings) !== canonicalJson(expected.value)) {
      fail('human-review-renderer-drift')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error, 'invalid-human-review-renderings')
  }
}

export function verifyHumanSemanticReviewDecision(decision, review, current) {
  try {
    validateReview(review)
    validateDecision(decision)
    exactFields(current, [
      'current_base_revision',
      'current_result_revision',
    ], 'human-review-current-revisions')
    if (decision.review_digest !== review.review_digest
      || decision.proposal_digest !== review.proposal_digest
      || decision.base_revision !== review.base_revision
      || decision.result_revision !== review.result_revision
      || decision.current_base_revision !== current.current_base_revision
      || decision.current_result_revision !== current.current_result_revision) {
      fail('human-review-decision-authority-mismatch')
    }
    const revisionsMatch = current.current_base_revision === review.base_revision
      && current.current_result_revision === review.result_revision
    if (decision.decision === 'stale' ? revisionsMatch : !revisionsMatch) {
      fail('human-review-decision-revision-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error, 'invalid-human-review-decision')
  }
}

export function createHumanSemanticReviewDecision(review, input) {
  try {
    validateReview(review)
    exactFields(input, [
      'current_base_revision',
      'current_result_revision',
      'decision',
    ], 'human-review-decision-input')
    if (!['approve', 'reject', 'stale'].includes(input.decision)
      || !DIGEST.test(input.current_base_revision)
      || !DIGEST.test(input.current_result_revision)) {
      fail('invalid-human-review-decision')
    }
    const revisionsMatch = input.current_base_revision === review.base_revision
      && input.current_result_revision === review.result_revision
    if (input.decision === 'stale' ? revisionsMatch : !revisionsMatch) {
      fail('human-review-decision-revision-mismatch')
    }
    const content = {
      base_revision: review.base_revision,
      current_base_revision: input.current_base_revision,
      current_result_revision: input.current_result_revision,
      decision: input.decision,
      proposal_digest: review.proposal_digest,
      result_revision: review.result_revision,
      review_digest: review.review_digest,
      schema: DECISION_SCHEMA,
    }
    return {
      ok: true,
      value: {
        ...content,
        decision_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-human-review-decision')
  }
}

function semanticFacts(facts) {
  return facts.map((fact) => {
    if (!SUPPORTED_KINDS.has(fact.kind)) {
      fail('human-review-unsupported-fact', {
        fact_id: fact.fact_id,
        kind: fact.kind,
      })
    }
    const semantic = semanticValue(fact.value)
    return {
      dimensions: dimensionsFor(fact, semantic),
      evidence_anchor: fact.evidence?.anchor ?? `path:${fact.path.join('/')}`,
      fact_id: fact.fact_id,
      identity: typeof fact.uid_anchor === 'string' && UID.test(fact.uid_anchor)
        ? `uid:${fact.uid_anchor}`
        : `fact:${fact.fact_id}`,
      kind: fact.kind,
      module: moduleFor(fact),
      path: [...fact.path],
      semantic,
      semantic_digest: digest(semantic),
      uid_anchor: fact.uid_anchor,
    }
  }).sort(compareIdentity)
}

function classifyChanges(beforeFacts, afterFacts) {
  const before = uniqueByIdentity(beforeFacts)
  const after = uniqueByIdentity(afterFacts)
  const added = []
  const modified = []
  const removed = []
  let unchangedCount = 0
  for (const [identity, fact] of before) {
    const next = after.get(identity)
    if (next === undefined) {
      removed.push(changeEntry('removed', fact, null))
    } else if (fact.semantic_digest !== next.semantic_digest
      || fact.fact_id !== next.fact_id) {
      modified.push(changeEntry('modified', fact, next))
    } else {
      unchangedCount += 1
    }
    after.delete(identity)
  }
  for (const fact of after.values()) added.push(changeEntry('added', null, fact))
  return {
    added: added.sort(compareChange),
    modified: modified.sort(compareChange),
    removed: removed.sort(compareChange),
    unchanged_count: unchangedCount,
  }
}

function changeEntry(change, before, after) {
  const current = after ?? before
  return {
    after: after === null ? null : factSnapshot(after),
    before: before === null ? null : factSnapshot(before),
    change,
    evidence_anchors: sortedUnique([
      before?.evidence_anchor,
      after?.evidence_anchor,
    ].filter(Boolean)),
    fact_id: current.fact_id,
    kind: current.kind,
    module: current.module,
    uid_anchor: current.uid_anchor,
  }
}

function factSnapshot(fact) {
  return {
    dimensions: clone(fact.dimensions),
    evidence_anchor: fact.evidence_anchor,
    fact_id: fact.fact_id,
    path: [...fact.path],
    semantic: clone(fact.semantic),
    semantic_digest: fact.semantic_digest,
  }
}

function riskFlagsFor(changes) {
  const flags = []
  for (const change of [...changes.added, ...changes.modified]) {
    const before = change.before?.semantic ?? null
    const after = change.after?.semantic ?? null
    if (change.kind === 'capability' && change.change === 'added') {
      flags.push(riskFlag('capability-added', change))
    }
    if (change.kind === 'error' && change.change === 'added') {
      flags.push(riskFlag('error-added', change))
    }
    if (difference(valuesForKey(after, 'effects'), valuesForKey(before, 'effects')).length > 0) {
      flags.push(riskFlag('effect-added', change))
    }
  }
  return dedupeRiskFlags(flags).sort((left, right) => {
    const byCode = compareText(left.code, right.code)
    return byCode === 0 ? compareText(left.fact_id, right.fact_id) : byCode
  })
}

function riskFlag(code, change) {
  return {
    code,
    evidence_anchor: change.after?.evidence_anchor ?? change.before?.evidence_anchor,
    fact_id: change.fact_id,
    severity: 'high',
    uid_anchor: change.uid_anchor,
  }
}

function dimensionsFor(fact, semantic) {
  return {
    capability: fact.kind === 'capability' || hasKey(semantic, 'capabilities')
      || hasKey(semantic, 'reference'),
    concurrency: fact.kind === 'concurrency-event' || hasAnyKey(semantic, [
      'branch', 'concurrency', 'ordinal', 'scope_path', 'trace',
    ]),
    effect: hasAnyKey(semantic, ['effect', 'effects']),
    error: fact.kind === 'error' || hasAnyKey(semantic, ['error', 'errors']),
    input: hasAnyKey(semantic, ['input', 'inputs', 'parameters', 'request']),
    lifecycle: fact.kind === 'agent-transition' || hasAnyKey(semantic, [
      'cancel', 'deadline', 'lifecycle', 'retry', 'terminal_states',
      'timeout', 'transitions',
    ]),
    output: hasAnyKey(semantic, ['outcome', 'output', 'outputs', 'response', 'result']),
    resource: fact.kind === 'resource' || hasAnyKey(semantic, ['resource', 'resources']),
    type: fact.kind === 'type-declaration' || hasAnyKey(semantic, [
      'type', 'type_arguments', 'variants',
    ]),
  }
}

function semanticValue(value, key = null) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => semanticValue(entry))
    return UNORDERED_ARRAY_FIELDS.has(key)
      ? entries.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
      : entries
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value)
      .filter((field) => !['implementation_digest', 'source_sha256'].includes(field))
      .sort(compareText)
      .map((field) => [field, semanticValue(value[field], field)]))
  }
  return value
}

function validateEvidence(input, beforeLedger, afterLedger) {
  const { proposal, dry_run: dryRun, receipt } = input
  validateProposalEvidence(proposal, beforeLedger)
  validateDryRunEvidence(dryRun)
  validateReceiptEvidence(receipt, { verifyDigest: false })
  const expectedBeforeIndex = indexRevisionFor(
    input.before_project.graph_revision,
    beforeLedger.fact_digest,
  )
  const expectedAfterIndex = indexRevisionFor(
    input.after_project.graph_revision,
    afterLedger.fact_digest,
  )
  if (proposal.base_revision !== input.before_project.graph_revision
    || dryRun.base_revision !== input.before_project.graph_revision
    || receipt.base_revision !== input.before_project.graph_revision
    || proposal.index_revision !== expectedBeforeIndex
    || dryRun.index_revision !== expectedBeforeIndex
    || dryRun.result_revision !== input.after_project.graph_revision
    || receipt.result_revision !== input.after_project.graph_revision
    || receipt.patch_receipt?.result_revision !== input.after_project.graph_revision
    || receipt.toolchain?.manifest?.index_revision !== expectedAfterIndex
    || receipt.toolchain?.audit?.fact_digest !== afterLedger.fact_digest
    || receipt.toolchain?.manifest?.fact_digest !== afterLedger.fact_digest
    || receipt.proposal_digest !== proposal.proposal_digest
    || dryRun.proposal_digest !== proposal.proposal_digest
    || receipt.dry_run_digest !== dryRun.dry_run_digest) {
    fail('human-review-revision-mismatch')
  }
  for (const name of ['audit', 'check', 'manifest', 'run', 'translate']) {
    if (receipt.toolchain?.[name]?.graph_revision !== input.after_project.graph_revision) {
      fail('human-review-revision-mismatch', { tool: name })
    }
  }
  verifyReceiptDigest(receipt)
}

function validateProposalEvidence(proposal, ledger) {
  exactFields(proposal, [
    'affected',
    'base_revision',
    'impact',
    'index_revision',
    'operations',
    'proposal_digest',
    'schema',
  ], 'human-review-proposal')
  if (proposal.schema !== PROPOSAL_SCHEMA
    || !DIGEST.test(proposal.base_revision)
    || !DIGEST.test(proposal.index_revision)
    || !DIGEST.test(proposal.proposal_digest)
    || !Array.isArray(proposal.affected)
    || !Array.isArray(proposal.operations)
    || proposal.operations.length === 0) {
    fail('invalid-human-review-proposal')
  }
  const { proposal_digest: proposalDigest, ...content } = proposal
  if (proposalDigest !== digest(content)) {
    fail('human-review-proposal-digest-mismatch')
  }
  validateImpactEvidence(proposal.impact)
  const facts = new Map(ledger.facts.map((fact) => [fact.fact_id, fact]))
  let previousFactId = null
  for (const affected of proposal.affected) {
    exactFields(affected, ['fact_id', 'uid', 'value_digest'], 'human-review-affected-fact')
    if (typeof affected.fact_id !== 'string'
      || !UID.test(affected.uid)
      || !DIGEST.test(affected.value_digest)
      || (previousFactId !== null && compareText(previousFactId, affected.fact_id) >= 0)) {
      fail('invalid-human-review-affected-fact')
    }
    previousFactId = affected.fact_id
    const fact = facts.get(affected.fact_id)
    if (fact === undefined
      || fact.uid_anchor !== affected.uid
      || digest(fact.value) !== affected.value_digest) {
      fail('human-review-proposal-precondition-mismatch', {
        fact_id: affected.fact_id,
      })
    }
  }
  for (const operation of proposal.operations) {
    if (!isObject(operation) || typeof operation.kind !== 'string') {
      fail('invalid-human-review-operation')
    }
  }
}

function validateDryRunEvidence(dryRun) {
  exactFields(dryRun, [
    'base_revision',
    'check',
    'dry_run_digest',
    'index_revision',
    'patch_receipt',
    'proposal_digest',
    'result_revision',
    'schema',
    'semantic_diff',
  ], 'human-review-dry-run')
  if (dryRun.schema !== DRY_RUN_SCHEMA
    || ![
      dryRun.base_revision,
      dryRun.dry_run_digest,
      dryRun.index_revision,
      dryRun.proposal_digest,
      dryRun.result_revision,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-human-review-dry-run')
  }
  const { dry_run_digest: dryRunDigest, ...content } = dryRun
  if (dryRunDigest !== digest(content)) {
    fail('human-review-dry-run-digest-mismatch')
  }
  validateToolEvidence(dryRun.check, 'check', CHECK_EVIDENCE_SCHEMA)
  validatePatchReceipt(dryRun.patch_receipt)
  exactFields(dryRun.semantic_diff, [
    'added',
    'modified',
    'removed',
    'schema',
  ], 'human-review-semantic-diff')
  if (dryRun.semantic_diff.schema !== 're.agent-authoring-semantic-diff@0.1.0'
    || ![
      dryRun.semantic_diff.added,
      dryRun.semantic_diff.modified,
      dryRun.semantic_diff.removed,
    ].every(Array.isArray)) {
    fail('invalid-human-review-semantic-diff')
  }
  for (const entries of [
    dryRun.semantic_diff.added,
    dryRun.semantic_diff.modified,
    dryRun.semantic_diff.removed,
  ]) {
    for (const entry of entries) {
      exactFields(entry, [
        'after_digest',
        'before_digest',
        'fact_id',
        'kind',
      ], 'human-review-semantic-diff-entry')
      if (typeof entry.fact_id !== 'string'
        || typeof entry.kind !== 'string'
        || (entry.before_digest !== null && !DIGEST.test(entry.before_digest))
        || (entry.after_digest !== null && !DIGEST.test(entry.after_digest))) {
        fail('invalid-human-review-semantic-diff-entry')
      }
    }
  }
}

function validateReceiptEvidence(receipt, { verifyDigest = true } = {}) {
  exactFields(receipt, [
    'approval_digest',
    'base_revision',
    'dry_run_digest',
    'patch_receipt',
    'proposal_digest',
    'receipt_digest',
    'result_revision',
    'schema',
    'toolchain',
  ], 'human-review-receipt')
  if (receipt.schema !== AUTHORING_RECEIPT_SCHEMA
    || ![
      receipt.approval_digest,
      receipt.base_revision,
      receipt.dry_run_digest,
      receipt.proposal_digest,
      receipt.receipt_digest,
      receipt.result_revision,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-human-review-receipt')
  }
  const { receipt_digest: receiptDigest, ...content } = receipt
  if (verifyDigest && receiptDigest !== digest(content)) {
    fail('human-review-receipt-digest-mismatch')
  }
  validatePatchReceipt(receipt.patch_receipt)
  exactFields(receipt.toolchain, [
    'audit',
    'check',
    'manifest',
    'run',
    'translate',
  ], 'human-review-toolchain')
  validateToolEvidence(receipt.toolchain.audit, 'audit', TOOL_EVIDENCE_SCHEMA, [
    'fact_digest',
  ])
  validateToolEvidence(receipt.toolchain.check, 'check', CHECK_EVIDENCE_SCHEMA)
  validateToolEvidence(receipt.toolchain.manifest, 'manifest', TOOL_EVIDENCE_SCHEMA, [
    'fact_digest',
    'index_revision',
  ])
  validateToolEvidence(receipt.toolchain.run, 'run', TOOL_EVIDENCE_SCHEMA)
  validateToolEvidence(receipt.toolchain.translate, 'translate', TOOL_EVIDENCE_SCHEMA, [
    'semantic_fact_digest',
    'translation_digest',
  ])
}

function verifyReceiptDigest(receipt) {
  const { receipt_digest: receiptDigest, ...content } = receipt
  if (receiptDigest !== digest(content)) {
    fail('human-review-receipt-digest-mismatch')
  }
}

function validatePatchReceipt(receipt) {
  exactFields(receipt, [
    'base_revision',
    'changed_fact_ids',
    'operations',
    'patch_digest',
    'result_revision',
    'schema',
  ], 'human-review-patch-receipt')
  if (receipt.schema !== PATCH_RECEIPT_SCHEMA
    || !DIGEST.test(receipt.base_revision)
    || !DIGEST.test(receipt.patch_digest)
    || !DIGEST.test(receipt.result_revision)
    || !Array.isArray(receipt.changed_fact_ids)
    || !Array.isArray(receipt.operations)
    || receipt.changed_fact_ids.some((value) => typeof value !== 'string')
    || receipt.operations.some((value) => !isObject(value))) {
    fail('invalid-human-review-patch-receipt')
  }
}

function validateToolEvidence(evidence, name, schema, extraFields = []) {
  exactFields(evidence, [
    'graph_revision',
    'result_digest',
    'schema',
    ...extraFields,
  ], `human-review-${name}-evidence`)
  if (evidence.schema !== schema
    || !DIGEST.test(evidence.graph_revision)
    || !DIGEST.test(evidence.result_digest)
    || extraFields.some((field) => !DIGEST.test(evidence[field]))) {
    fail(`invalid-human-review-${name}-evidence`)
  }
}

function validateImpactEvidence(impact) {
  exactFields(impact, [
    'capabilities_added',
    'capabilities_removed',
    'effects_added',
    'effects_removed',
  ], 'human-review-impact')
  for (const field of [
    'capabilities_added',
    'capabilities_removed',
    'effects_added',
    'effects_removed',
  ]) {
    if (!Array.isArray(impact[field])
      || impact[field].some((value) => typeof value !== 'string')) {
      fail('invalid-human-review-impact')
    }
  }
}

function validateReview(review) {
  exactFields(review, [
    'base_revision',
    'changes',
    'evidence',
    'index_revision',
    'proposal_digest',
    'result_revision',
    'review_digest',
    'risk_flags',
    'schema',
    'semantic_fact_digest',
    'semantic_facts',
  ], 'human-review')
  if (review.schema !== REVIEW_SCHEMA
    || ![
      review.base_revision,
      review.index_revision,
      review.proposal_digest,
      review.result_revision,
      review.review_digest,
      review.semantic_fact_digest,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-human-semantic-review')
  }
  const { review_digest: reviewDigest, ...content } = review
  if (reviewDigest !== digest(content)) fail('human-review-digest-mismatch')
  if (review.semantic_fact_digest !== digest(review.semantic_facts)) {
    fail('human-review-semantic-fact-digest-mismatch')
  }
}

function validateDecision(decision) {
  exactFields(decision, [
    'base_revision',
    'current_base_revision',
    'current_result_revision',
    'decision',
    'decision_digest',
    'proposal_digest',
    'result_revision',
    'review_digest',
    'schema',
  ], 'human-review-decision')
  if (decision.schema !== DECISION_SCHEMA
    || !['approve', 'reject', 'stale'].includes(decision.decision)
    || ![
      decision.base_revision,
      decision.current_base_revision,
      decision.current_result_revision,
      decision.decision_digest,
      decision.proposal_digest,
      decision.result_revision,
      decision.review_digest,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-human-review-decision')
  }
  const { decision_digest: decisionDigest, ...content } = decision
  if (decisionDigest !== digest(content)) {
    fail('human-review-decision-digest-mismatch')
  }
}

function validateTemplates(review, registry) {
  if (!isObject(registry)) fail('invalid-human-review-template-registry')
  const kinds = sortedUnique([
    ...review.changes.added,
    ...review.changes.modified,
    ...review.changes.removed,
  ].map(({ kind }) => kind))
  for (const locale of LOCALES) {
    if (!Array.isArray(registry[locale])) fail('invalid-human-review-template-registry')
    const available = new Set(registry[locale])
    for (const kind of kinds) {
      if (!available.has(kind)) fail('human-review-template-missing', { kind, locale })
    }
  }
}

function renderEntry(review, media, content) {
  const entry = {
    content,
    media,
    review_digest: review.review_digest,
    schema: RENDERING_SCHEMA,
    semantic_fact_digest: review.semantic_fact_digest,
  }
  return {
    ...entry,
    content_digest: digest(content),
  }
}

function validateRenderingEntry(entry, medium, review) {
  exactFields(entry, [
    'content',
    'content_digest',
    'media',
    'review_digest',
    'schema',
    'semantic_fact_digest',
  ], 'human-review-rendering')
  if (entry.schema !== RENDERING_SCHEMA
    || entry.media !== medium
    || entry.review_digest !== review.review_digest
    || entry.semantic_fact_digest !== review.semantic_fact_digest
    || entry.content_digest !== digest(entry.content)
    || typeof entry.content !== 'string') {
    fail('human-review-renderer-drift', { media: medium })
  }
}

function renderText(review, locale) {
  const zh = locale === 'zh-CN'
  const lines = [
    zh ? 'RE 人类语义审阅 0.1' : 'RE Human Semantic Review 0.1',
    `${zh ? '基线修订' : 'Base revision'}: ${review.base_revision}`,
    `${zh ? '结果修订' : 'Result revision'}: ${review.result_revision}`,
    `${zh ? '语义事实摘要' : 'Semantic fact digest'}: ${review.semantic_fact_digest}`,
    `${zh ? '审阅摘要' : 'Review digest'}: ${review.review_digest}`,
    `${zh ? '检查' : 'Check'}: ${review.evidence.check.status}`,
    `${zh ? '运行' : 'Run'}: ${review.evidence.run.status}`,
    `${zh ? '回执' : 'Receipt'}: ${review.evidence.receipt.status}`,
  ]
  for (const category of ['added', 'removed', 'modified']) {
    lines.push('', `${labelForCategory(category, locale)}:`)
    for (const change of review.changes[category]) {
      lines.push(renderChangeText(change, locale))
    }
  }
  lines.push('', `${zh ? '高风险' : 'High risk'}:`)
  for (const flag of review.risk_flags) {
    lines.push(`- HIGH ${flag.code} [${flag.fact_id}] {${flag.evidence_anchor}}`)
  }
  return `${lines.join('\n')}\n`
}

function renderChangeText(change, locale) {
  const current = change.after ?? change.before
  const uid = change.uid_anchor ?? 'none'
  const module = change.module ?? 'project'
  const dimensions = Object.entries(current.dimensions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(',')
  return `- ${labelForCategory(change.change, locale)} ${change.kind}`
    + ` module=${module} uid=${uid} fact=${change.fact_id}`
    + ` dimensions=${dimensions || 'none'} evidence=${change.evidence_anchors.join(',')}`
    + ` before=${change.before === null ? 'null' : canonicalJson(change.before.semantic)}`
    + ` after=${change.after === null ? 'null' : canonicalJson(change.after.semantic)}`
}

function renderHtml(review) {
  const changes = allChanges(review).map((change) => {
    const current = change.after ?? change.before
    return `<article data-change="${escapeMarkup(change.change)}"`
      + ` data-fact-id="${escapeMarkup(change.fact_id)}"`
      + ` data-uid="${escapeMarkup(change.uid_anchor ?? '')}"`
      + ` data-module="${escapeMarkup(change.module ?? '')}"`
      + ` data-evidence-anchor="${escapeMarkup(change.evidence_anchors.join(','))}">`
      + `<h2>${escapeMarkup(change.change)} ${escapeMarkup(change.kind)}</h2>`
      + `<pre>${escapeMarkup(canonicalJson(current.semantic))}</pre></article>`
  }).join('')
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>RE Human Semantic Review</title></head>'
    + `<body data-schema="${REVIEW_SCHEMA}"`
    + ` data-base-revision="${review.base_revision}"`
    + ` data-result-revision="${review.result_revision}"`
    + ` data-semantic-fact-digest="${review.semantic_fact_digest}"`
    + ` data-review-digest="${review.review_digest}"><main>${changes}</main></body></html>\n`
}

function renderSvg(review) {
  const changes = allChanges(review)
  const height = Math.max(100, 54 * changes.length + 60)
  const rows = changes.map((change, index) => (
    `<g data-change="${escapeMarkup(change.change)}"`
    + ` data-fact-id="${escapeMarkup(change.fact_id)}"`
    + ` data-uid="${escapeMarkup(change.uid_anchor ?? '')}"`
    + ` data-evidence-anchor="${escapeMarkup(change.evidence_anchors.join(','))}">`
    + `<text x="20" y="${40 + index * 54}">`
    + `${escapeMarkup(change.change)} ${escapeMarkup(change.kind)} `
    + `${escapeMarkup(change.module ?? 'project')} ${escapeMarkup(change.fact_id)}`
    + '</text></g>'
  )).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}"`
    + ` viewBox="0 0 1280 ${height}" data-schema="${REVIEW_SCHEMA}"`
    + ` data-base-revision="${review.base_revision}"`
    + ` data-result-revision="${review.result_revision}"`
    + ` data-semantic-fact-digest="${review.semantic_fact_digest}"`
    + ` data-review-digest="${review.review_digest}"><title>RE Human Semantic Review</title>`
    + `${rows}</svg>\n`
}

function defaultTemplateRegistry() {
  const kinds = [...SUPPORTED_KINDS].sort(compareText)
  return Object.fromEntries(LOCALES.map((locale) => [locale, kinds]))
}

function evidenceStatus(value, status) {
  return {
    anchor: value.result_digest,
    graph_revision: value.graph_revision,
    status,
  }
}

function moduleFor(fact) {
  const index = fact.path.indexOf('module')
  return index >= 0 ? fact.path[index + 1] ?? null : fact.value?.module ?? null
}

function uniqueByIdentity(facts) {
  const output = new Map()
  for (const fact of facts) {
    if (output.has(fact.identity)) {
      fail('human-review-ambiguous-fact-identity', { identity: fact.identity })
    }
    output.set(fact.identity, fact)
  }
  return output
}

function valuesForKey(value, key) {
  const output = []
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child)
      return
    }
    if (!isObject(entry)) return
    for (const [field, child] of Object.entries(entry)) {
      if (field === key) {
        if (Array.isArray(child)) {
          for (const item of child) {
            output.push(typeof item === 'string' ? item : canonicalJson(item))
          }
        } else {
          output.push(typeof child === 'string' ? child : canonicalJson(child))
        }
      }
      visit(child)
    }
  }
  visit(value)
  return sortedUnique(output)
}

function hasKey(value, key) {
  return hasAnyKey(value, [key])
}

function hasAnyKey(value, keys) {
  const wanted = new Set(keys)
  let found = false
  const visit = (entry) => {
    if (found) return
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child)
      return
    }
    if (!isObject(entry)) return
    for (const [key, child] of Object.entries(entry)) {
      if (wanted.has(key)) {
        found = true
        return
      }
      visit(child)
    }
  }
  visit(value)
  return found
}

function allChanges(review) {
  return [
    ...review.changes.added,
    ...review.changes.removed,
    ...review.changes.modified,
  ]
}

function labelForCategory(category, locale) {
  const labels = {
    'en-US': { added: 'Added', modified: 'Modified', removed: 'Removed' },
    'zh-CN': { added: '新增', modified: '修改', removed: '删除' },
  }
  return labels[locale][category]
}

function dedupeRiskFlags(flags) {
  return [...new Map(flags.map((flag) => [
    `${flag.code}:${flag.fact_id}`,
    flag,
  ])).values()]
}

function difference(left, right) {
  const excluded = new Set(right)
  return left.filter((value) => !excluded.has(value))
}

function sortedUnique(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    fail('invalid-human-review-list')
  }
  return [...new Set(values)].sort(compareText)
}

function compareIdentity(left, right) {
  return compareText(left.identity, right.identity)
}

function compareChange(left, right) {
  return compareText(left.fact_id, right.fact_id)
}

function clone(value) {
  return structuredClone(value)
}

function requireLedger(project) {
  const ledger = buildFactLedger(project)
  if (!ledger.ok) fail(ledger.diagnostics[0].code)
  return ledger.value
}

function exactFields(value, fields, name) {
  if (!isObject(value)
    || canonicalJson(Object.keys(value).sort(compareText))
      !== canonicalJson([...fields].sort(compareText))) {
    fail(`invalid-${name}`)
  }
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

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function escapeMarkup(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
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
