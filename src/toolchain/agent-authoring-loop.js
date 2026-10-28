import { createHash } from 'node:crypto'

import { buildFactLedger } from './fact-ledger.js'
import { applyProjectPatch } from './project-patch.js'
import {
  buildProjectReviewIndex,
  indexRevisionFor,
} from './project-review-index.js'
import { translateProject } from './project-translator.js'

const PROPOSAL_SCHEMA = 're.agent-authoring-proposal@0.1.0'
const DRY_RUN_SCHEMA = 're.agent-authoring-dry-run@0.1.0'
const APPROVAL_SCHEMA = 're.agent-authoring-approval@0.1.0'
const RECEIPT_SCHEMA = 're.agent-authoring-receipt@0.1.0'
const CHECK_EVIDENCE_SCHEMA = 're.agent-authoring-check-evidence@0.1.0'
const TOOL_EVIDENCE_SCHEMA = 're.agent-authoring-tool-evidence@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const IMPACT_FIELDS = [
  'capabilities_added',
  'capabilities_removed',
  'effects_added',
  'effects_removed',
]

export function createAgentAuthoringProposal(project, input) {
  try {
    exactFields(input, [
      'affected_fact_ids',
      'impact',
      'index_revision',
      'operations',
    ], 'agent-authoring-proposal-input')
    const ledger = requireLedger(project)
    const actualIndexRevision = indexRevisionFor(
      project.graph_revision,
      ledger.fact_digest,
    )
    if (input.index_revision !== actualIndexRevision) {
      fail('agent-authoring-index-revision-mismatch', {
        actual: actualIndexRevision,
        expected: input.index_revision,
      })
    }
    if (!Array.isArray(input.affected_fact_ids)
      || !Array.isArray(input.operations)
      || input.operations.length === 0) {
      fail('invalid-agent-authoring-proposal-input')
    }
    const facts = new Map(ledger.facts.map((fact) => [fact.fact_id, fact]))
    const affected = sortedUnique(input.affected_fact_ids, 'affected-fact-id')
      .map((factId) => {
        const fact = facts.get(factId)
        if (fact === undefined) {
          fail('agent-authoring-affected-fact-not-found', { fact_id: factId })
        }
        if (fact.uid_anchor === null || fact.uid_anchor === undefined) {
          fail('agent-authoring-affected-fact-uid-required', { fact_id: factId })
        }
        return {
          fact_id: fact.fact_id,
          uid: fact.uid_anchor,
          value_digest: digest(fact.value),
        }
      })
    const operations = clone(input.operations)
    requireAffectedUids(affected, operations)
    const impact = normalizeImpact(input.impact)
    const content = {
      affected,
      base_revision: project.graph_revision,
      impact,
      index_revision: actualIndexRevision,
      operations,
      schema: PROPOSAL_SCHEMA,
    }
    return {
      ok: true,
      value: {
        ...content,
        proposal_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-agent-authoring-proposal-input')
  }
}

export async function dryRunAgentAuthoringProposal(project, proposal, tools) {
  try {
    const beforeProject = canonicalJson(project)
    const validated = validateProposal(project, proposal)
    const patched = applyProjectPatch(project, {
      base_revision: validated.base_revision,
      operations: clone(validated.operations),
      schema: 're.project-patch@0.1.0',
    })
    if (!patched.ok) throwDiagnostic(patched.diagnostics[0])
    const candidate = patched.project
    const actualImpact = projectImpact(project, candidate)
    if (!same(actualImpact, validated.impact)) {
      fail('agent-authoring-impact-mismatch', {
        actual: actualImpact,
        expected: validated.impact,
      })
    }
    validateEffectAuthority(project, actualImpact)
    const check = await runTrustedTool(
      tools?.check,
      candidate,
      'check',
      CHECK_EVIDENCE_SCHEMA,
    )
    const beforeLedger = requireLedger(project)
    const afterLedger = requireLedger(candidate)
    const semanticDiff = factDelta(beforeLedger.facts, afterLedger.facts)
    if (canonicalJson(project) !== beforeProject) {
      fail('agent-authoring-dry-run-mutated-project')
    }
    const content = {
      base_revision: project.graph_revision,
      check,
      index_revision: validated.index_revision,
      patch_receipt: clone(patched.receipt),
      proposal_digest: validated.proposal_digest,
      result_revision: candidate.graph_revision,
      schema: DRY_RUN_SCHEMA,
      semantic_diff: semanticDiff,
    }
    return {
      ok: true,
      value: {
        ...content,
        dry_run_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-agent-authoring-dry-run')
  }
}

export function createAgentAuthoringApproval(dryRun, { decision } = {}) {
  try {
    validateDryRun(dryRun)
    if (!['approved', 'rejected'].includes(decision)) {
      fail('invalid-agent-authoring-decision')
    }
    const content = {
      base_revision: dryRun.base_revision,
      decision,
      dry_run_digest: dryRun.dry_run_digest,
      proposal_digest: dryRun.proposal_digest,
      result_revision: dryRun.result_revision,
      schema: APPROVAL_SCHEMA,
    }
    return {
      ok: true,
      value: {
        ...content,
        approval_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-agent-authoring-approval')
  }
}

export async function applyAgentAuthoringProposal(project, proposal, approval, tools) {
  try {
    validateApproval(approval)
    if (approval.decision !== 'approved') fail('agent-authoring-not-approved')
    const dryRun = await dryRunAgentAuthoringProposal(project, proposal, tools)
    if (!dryRun.ok) throwDiagnostic(dryRun.diagnostics[0])
    const expectedApproval = createAgentAuthoringApproval(dryRun.value, {
      decision: 'approved',
    })
    if (!expectedApproval.ok || !same(expectedApproval.value, approval)) {
      fail('agent-authoring-approval-authority-mismatch')
    }
    const patched = applyProjectPatch(project, {
      base_revision: proposal.base_revision,
      operations: clone(proposal.operations),
      schema: 're.project-patch@0.1.0',
    })
    if (!patched.ok) throwDiagnostic(patched.diagnostics[0])
    const candidate = patched.project
    if (!same(patched.receipt, dryRun.value.patch_receipt)
      || candidate.graph_revision !== dryRun.value.result_revision) {
      fail('agent-authoring-dry-run-replay-mismatch')
    }

    const manifest = buildProjectReviewIndex(candidate, { limit: 500 })
    if (!manifest.ok) fail('agent-authoring-manifest-failed', {
      diagnostics: manifest.diagnostics,
    })
    const audit = buildFactLedger(candidate)
    if (!audit.ok) fail('agent-authoring-audit-failed', {
      diagnostics: audit.diagnostics,
    })
    const translated = translateProject(candidate, { locale: 'zh-CN', media: 'all' })
    if (!translated.ok) fail('agent-authoring-translate-failed', {
      diagnostics: translated.diagnostics,
    })
    const run = await runTrustedTool(
      tools?.run,
      candidate,
      'run',
      TOOL_EVIDENCE_SCHEMA,
    )
    const revision = candidate.graph_revision
    const toolchain = {
      audit: internalEvidence(
        audit.value,
        revision,
        TOOL_EVIDENCE_SCHEMA,
        { fact_digest: audit.value.fact_digest },
      ),
      check: dryRun.value.check,
      manifest: internalEvidence(
        manifest.value,
        revision,
        TOOL_EVIDENCE_SCHEMA,
        {
          fact_digest: manifest.value.fact_digest,
          index_revision: manifest.value.index_revision,
        },
      ),
      run,
      translate: internalEvidence(
        translated.value,
        revision,
        TOOL_EVIDENCE_SCHEMA,
        {
          semantic_fact_digest: translated.value.semantic_fact_digest,
          translation_digest: translated.value.receipt.translation_digest,
        },
      ),
    }
    for (const [tool, evidence] of Object.entries(toolchain)) {
      if (evidence.graph_revision !== revision) {
        fail('agent-authoring-tool-revision-mismatch', {
          actual: evidence.graph_revision,
          expected: revision,
          tool,
        })
      }
    }
    const content = {
      approval_digest: approval.approval_digest,
      base_revision: project.graph_revision,
      dry_run_digest: dryRun.value.dry_run_digest,
      patch_receipt: clone(patched.receipt),
      proposal_digest: proposal.proposal_digest,
      result_revision: revision,
      schema: RECEIPT_SCHEMA,
      toolchain,
    }
    return {
      ok: true,
      project: candidate,
      receipt: {
        ...content,
        receipt_digest: digest(content),
      },
    }
  } catch (error) {
    return rejected(error, 'invalid-agent-authoring-apply')
  }
}

function validateProposal(project, proposal) {
  exactFields(proposal, [
    'affected',
    'base_revision',
    'impact',
    'index_revision',
    'operations',
    'proposal_digest',
    'schema',
  ], 'agent-authoring-proposal')
  if (proposal.schema !== PROPOSAL_SCHEMA
    || !DIGEST.test(proposal.base_revision)
    || !DIGEST.test(proposal.index_revision)
    || !DIGEST.test(proposal.proposal_digest)
    || !Array.isArray(proposal.affected)
    || !Array.isArray(proposal.operations)
    || proposal.operations.length === 0) {
    fail('invalid-agent-authoring-proposal')
  }
  const { proposal_digest: proposalDigest, ...content } = proposal
  if (proposalDigest !== digest(content)) {
    fail('agent-authoring-proposal-digest-mismatch')
  }
  if (proposal.base_revision !== project.graph_revision) {
    fail('agent-authoring-base-revision-mismatch', {
      actual: project.graph_revision,
      expected: proposal.base_revision,
    })
  }
  const ledger = requireLedger(project)
  const actualIndexRevision = indexRevisionFor(
    project.graph_revision,
    ledger.fact_digest,
  )
  if (proposal.index_revision !== actualIndexRevision) {
    fail('agent-authoring-index-revision-mismatch', {
      actual: actualIndexRevision,
      expected: proposal.index_revision,
    })
  }
  const facts = new Map(ledger.facts.map((fact) => [fact.fact_id, fact]))
  let previousFactId = null
  for (const affected of proposal.affected) {
    exactFields(affected, ['fact_id', 'uid', 'value_digest'], 'agent-authoring-affected')
    if (typeof affected.fact_id !== 'string'
      || typeof affected.uid !== 'string'
      || !DIGEST.test(affected.value_digest)
      || (previousFactId !== null && compareText(previousFactId, affected.fact_id) >= 0)) {
      fail('invalid-agent-authoring-affected')
    }
    previousFactId = affected.fact_id
    const fact = facts.get(affected.fact_id)
    if (fact === undefined
      || fact.uid_anchor !== affected.uid
      || digest(fact.value) !== affected.value_digest) {
      fail('agent-authoring-precondition-mismatch', { fact_id: affected.fact_id })
    }
  }
  requireAffectedUids(proposal.affected, proposal.operations)
  normalizeImpact(proposal.impact, { requireCanonical: true })
  return clone(proposal)
}

function validateDryRun(dryRun) {
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
  ], 'agent-authoring-dry-run')
  if (dryRun.schema !== DRY_RUN_SCHEMA
    || ![
      dryRun.base_revision,
      dryRun.dry_run_digest,
      dryRun.index_revision,
      dryRun.proposal_digest,
      dryRun.result_revision,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-agent-authoring-dry-run')
  }
  const { dry_run_digest: dryRunDigest, ...content } = dryRun
  if (dryRunDigest !== digest(content)) fail('agent-authoring-dry-run-digest-mismatch')
}

function validateApproval(approval) {
  exactFields(approval, [
    'approval_digest',
    'base_revision',
    'decision',
    'dry_run_digest',
    'proposal_digest',
    'result_revision',
    'schema',
  ], 'agent-authoring-approval')
  if (approval.schema !== APPROVAL_SCHEMA
    || !['approved', 'rejected'].includes(approval.decision)
    || ![
      approval.approval_digest,
      approval.base_revision,
      approval.dry_run_digest,
      approval.proposal_digest,
      approval.result_revision,
    ].every((value) => DIGEST.test(value))) {
    fail('invalid-agent-authoring-approval')
  }
  const { approval_digest: approvalDigest, ...content } = approval
  if (approvalDigest !== digest(content)) {
    fail('agent-authoring-approval-digest-mismatch')
  }
}

async function runTrustedTool(tool, project, name, schema) {
  if (typeof tool !== 'function') fail(`agent-authoring-${name}-required`)
  let result
  try {
    result = await tool(clone(project))
  } catch (error) {
    fail(`agent-authoring-${name}-failed`, {
      diagnostics: [error?.diagnostic ?? { code: `${name}-exception` }],
    })
  }
  if (!result?.ok) {
    fail(`agent-authoring-${name}-failed`, {
      diagnostics: result?.diagnostics ?? [],
    })
  }
  const value = result.value
  if (!isObject(value) || value.graph_revision !== project.graph_revision) {
    fail('agent-authoring-tool-revision-mismatch', {
      actual: value?.graph_revision ?? null,
      expected: project.graph_revision,
      tool: name,
    })
  }
  return {
    graph_revision: project.graph_revision,
    result_digest: digest(value),
    schema,
  }
}

function internalEvidence(value, revision, schema, extra) {
  if (value.graph_revision !== revision) {
    fail('agent-authoring-tool-revision-mismatch')
  }
  return {
    ...extra,
    graph_revision: revision,
    result_digest: digest(value),
    schema,
  }
}

function factDelta(beforeFacts, afterFacts) {
  const before = new Map(beforeFacts.map((fact) => [fact.fact_id, fact]))
  const after = new Map(afterFacts.map((fact) => [fact.fact_id, fact]))
  const added = []
  const modified = []
  const removed = []
  for (const [factId, fact] of before) {
    const next = after.get(factId)
    if (next === undefined) {
      removed.push(deltaEntry(factId, fact.kind, digest(fact.value), null))
    } else if (!same(fact.value, next.value)) {
      modified.push(deltaEntry(
        factId,
        next.kind,
        digest(fact.value),
        digest(next.value),
      ))
    }
    after.delete(factId)
  }
  for (const [factId, fact] of after) {
    added.push(deltaEntry(factId, fact.kind, null, digest(fact.value)))
  }
  return {
    added: added.sort(compareFactId),
    modified: modified.sort(compareFactId),
    removed: removed.sort(compareFactId),
    schema: 're.agent-authoring-semantic-diff@0.1.0',
  }
}

function deltaEntry(factId, kind, beforeDigest, afterDigest) {
  return {
    after_digest: afterDigest,
    before_digest: beforeDigest,
    fact_id: factId,
    kind,
  }
}

function projectImpact(before, after) {
  const beforeCapabilities = capabilityReferences(before)
  const afterCapabilities = capabilityReferences(after)
  const beforeEffects = effectIds(before)
  const afterEffects = effectIds(after)
  return {
    capabilities_added: difference(afterCapabilities, beforeCapabilities),
    capabilities_removed: difference(beforeCapabilities, afterCapabilities),
    effects_added: difference(afterEffects, beforeEffects),
    effects_removed: difference(beforeEffects, afterEffects),
  }
}

function capabilityReferences(project) {
  const references = new Set()
  for (const module of project.modules ?? []) {
    for (const capability of [
      ...(module.capabilities ?? []),
      ...(module.surface?.capabilities ?? []),
      ...(module.surface?.bindings ?? []),
    ]) {
      if (typeof capability?.reference === 'string') references.add(capability.reference)
    }
  }
  return references
}

function effectIds(project) {
  const effects = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (!isObject(value)) return
    if (Array.isArray(value.effects)) {
      for (const effect of value.effects) {
        const id = typeof effect === 'string'
          ? effect
          : effect?.id ?? effect?.operation_digest
        if (typeof id === 'string') effects.add(id)
      }
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(project)
  return effects
}

function validateEffectAuthority(project, impact) {
  const allowed = new Set(project.allowed_effects ?? [])
  const unauthorized = impact.effects_added.find((effect) => !allowed.has(effect))
  if (unauthorized !== undefined) {
    fail('agent-authoring-effect-escalation', { effect: unauthorized })
  }
}

function requireAffectedUids(affected, operations) {
  const available = new Set(affected.map(({ uid }) => uid))
  for (const operation of operations) {
    if (!isObject(operation) || typeof operation.kind !== 'string') {
      fail('invalid-agent-authoring-operation')
    }
    const uid = operation.uid ?? operation.expected_uid
    if (uid !== undefined && !available.has(uid)) {
      fail('agent-authoring-affected-uid-missing', { uid })
    }
  }
}

function normalizeImpact(impact, { requireCanonical = false } = {}) {
  exactFields(impact, IMPACT_FIELDS, 'agent-authoring-impact')
  const normalized = Object.fromEntries(IMPACT_FIELDS.map((field) => [
    field,
    sortedUnique(impact[field], field),
  ]))
  if (requireCanonical && !same(impact, normalized)) {
    fail('invalid-agent-authoring-impact')
  }
  return normalized
}

function requireLedger(project) {
  const result = buildFactLedger(project)
  if (!result.ok) throwDiagnostic(result.diagnostics[0])
  return result.value
}

function sortedUnique(values, field) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    fail('invalid-agent-authoring-list', { field })
  }
  return [...new Set(values)].sort(compareText)
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort(compareText)
}

function exactFields(value, fields, subject) {
  if (!isObject(value)
    || !same(Object.keys(value).sort(compareText), [...fields].sort(compareText))) {
    fail(`invalid-${subject}`)
  }
}

function clone(value) {
  try {
    return structuredClone(value)
  } catch {
    fail('invalid-agent-authoring-value')
  }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value, visiting = new Set()) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, visiting)).join(',')}]`
  if (isObject(value)) {
    if (visiting.has(value)) fail('cyclic-agent-authoring-value')
    visiting.add(value)
    const output = `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key], visiting)}`,
    ).join(',')}}`
    visiting.delete(value)
    return output
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  fail('invalid-agent-authoring-value')
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function compareFactId(left, right) {
  return compareText(left.fact_id, right.fact_id)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function throwDiagnostic(diagnostic) {
  throw Object.assign(new Error(diagnostic?.code ?? 'agent-authoring-failure'), {
    diagnostic: diagnostic ?? { code: 'agent-authoring-failure' },
  })
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}

function rejected(error, fallback) {
  return {
    diagnostics: [error?.diagnostic ?? { code: fallback }],
    ok: false,
  }
}
