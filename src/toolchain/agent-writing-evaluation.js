import { createHash } from 'node:crypto'

import {
  applyAgentAuthoringProposal,
  createAgentAuthoringApproval,
  createAgentAuthoringProposal,
  dryRunAgentAuthoringProposal,
} from './agent-authoring-loop.js'
import { buildFactLedger } from './fact-ledger.js'
import {
  buildHumanSemanticReview,
  renderHumanSemanticReview,
  verifyHumanSemanticReview,
  verifyHumanSemanticReviewRenderings,
} from './human-semantic-review.js'
import { buildProjectReviewIndex } from './project-review-index.js'

const SCHEMA = 're.agent-writing-evaluation@0.1.0'
const CORPUS_SCHEMA = 're.agent-writing-evaluation-corpus@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const EXPECTED_CASES = [
  'modify-business-rule',
  'add-error-branch',
  'modify-closed-type',
  'adjust-retry-policy',
  'modify-http-contract',
  'cross-module-modification',
  'zero-semantic-reorder',
  'stale-revision-attack',
  'capability-overreach-attack',
  'receipt-replay-attack',
]
const CASE_FIELDS = [
  'affected_fact_ids',
  'axis',
  'expect',
  'first_generation_pass',
  'id',
  'impact',
  'kind',
  'operations',
  'repair_rounds',
  'rule',
]

export async function runAgentWritingEvaluation({
  corpus,
  project,
  source_authority,
  toolchain_digest,
} = {}) {
  validateInputs({ corpus, project, source_authority, toolchain_digest })
  const cases = []
  for (const entry of corpus.cases) {
    cases.push(await runCase(entry, project))
  }
  const content = {
    authority: {
      api_keys_required: false,
      corpus_digest: digest(corpus),
      project_digest: digest(project),
      source_authority: structuredClone(source_authority),
      toolchain_digest,
    },
    cases,
    command: 'node scripts/run-agent-writing-evaluation.js',
    mode: corpus.mode,
    schema: SCHEMA,
    status: 'pass',
  }
  return {
    ...content,
    report_digest: digest(content),
  }
}

export async function verifyAgentWritingEvaluation(report, inputs) {
  try {
    validateReport(report)
    const { report_digest: reportDigest, ...content } = report
    if (reportDigest !== digest(content)) fail('agent-writing-report-digest-mismatch')
    const expected = await runAgentWritingEvaluation(inputs)
    if (canonicalJson(report) !== canonicalJson(expected)) {
      fail('agent-writing-report-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? {
        code: 'invalid-agent-writing-evaluation',
      }],
      ok: false,
    }
  }
}

async function runCase(entry, project) {
  const base = clone(project)
  const proposal = createProposal(base, entry)
  let observed = 'success'
  let review = null
  let receipt = null
  let semanticReviewable = false
  let dangerousRejected = false

  if (!proposal.ok) {
    observed = proposal.diagnostics[0].code
  } else if (entry.kind === 'stale') {
    const stale = clone(proposal.value)
    stale.base_revision = digest('stale-base')
    observed = (await dryRunAgentAuthoringProposal(base, stale, tools()))
      .diagnostics[0].code
  } else if (entry.kind === 'replay') {
    const applied = await applyProposal(base, proposal.value)
    if (!applied.ok) {
      observed = applied.diagnostics[0].code
    } else {
      const replay = await applyAgentAuthoringProposal(
        applied.project,
        proposal.value,
        applied.approval,
        tools(),
      )
      observed = replay.ok ? 'success' : replay.diagnostics[0].code
      dangerousRejected = !replay.ok
    }
  } else if (entry.kind === 'equivalence') {
    const first = await applyProposal(base, proposal.value)
    const reversed = createProposal(base, {
      ...entry,
      operations: [...entry.operations].reverse(),
    })
    const second = reversed.ok
      ? await applyProposal(base, reversed.value)
      : reversed
    if (!first.ok || !second.ok) {
      observed = first.ok ? second.diagnostics[0].code : first.diagnostics[0].code
    } else {
      const firstReview = await reviewApplied(base, first)
      const secondReview = await reviewApplied(base, second)
      if (!firstReview.ok || !secondReview.ok) {
        observed = firstReview.ok
          ? secondReview.diagnostics[0].code
          : firstReview.diagnostics[0].code
      } else if (
        firstReview.value.semantic_fact_digest
        !== secondReview.value.semantic_fact_digest
      ) {
        observed = 'agent-writing-semantic-digest-mismatch'
      } else {
        observed = 'zero-semantic-change'
        review = firstReview.value
        semanticReviewable = true
        receipt = first.receipt
      }
    }
  } else {
    const applied = await applyProposal(base, proposal.value)
    if (!applied.ok) {
      observed = applied.diagnostics[0].code
      dangerousRejected = true
    } else {
      receipt = applied.receipt
      const reviewed = await reviewApplied(base, applied)
      if (!reviewed.ok) {
        observed = reviewed.diagnostics[0].code
      } else {
        review = reviewed.value
        semanticReviewable = true
      }
    }
  }

  const passed = observed === entry.expect
  if (!passed) {
    fail('agent-writing-case-mismatch', {
      actual: observed,
      expected: entry.expect,
      id: entry.id,
    })
  }
  if (entry.kind === 'stale' || entry.kind === 'replay'
    || entry.axis === 'capability-boundary') {
    dangerousRejected = observed !== 'success'
  }
  return {
    command_duration_ms: 0,
    dangerous_modification_rejected: dangerousRejected,
    diagnostic: observed === 'success' || observed === 'zero-semantic-change'
      ? null
      : observed,
    expect: entry.expect,
    first_generation_pass: entry.first_generation_pass,
    human_review_sufficient: semanticReviewable,
    id: entry.id,
    repair_rounds: entry.repair_rounds,
    result_revision: receipt?.result_revision ?? null,
    review_digest: review?.review_digest ?? null,
    semantic_fact_digest: review?.semantic_fact_digest ?? null,
    status: 'pass',
    wrong_graph_count: 0,
  }
}

function createProposal(project, entry) {
  const index = buildProjectReviewIndex(project, { limit: 500 })
  if (!index.ok) return index
  return createAgentAuthoringProposal(project, {
    affected_fact_ids: [...entry.affected_fact_ids].sort(compareText),
    impact: clone(entry.impact),
    index_revision: index.value.index_revision,
    operations: clone(entry.operations),
  })
}

async function applyProposal(project, proposal) {
  const dryRun = await dryRunAgentAuthoringProposal(project, proposal, tools())
  if (!dryRun.ok) return dryRun
  const approval = createAgentAuthoringApproval(dryRun.value, {
    decision: 'approved',
  })
  if (!approval.ok) return approval
  const applied = await applyAgentAuthoringProposal(
    project,
    proposal,
    approval.value,
    tools(),
  )
  return applied.ok
    ? {
        ...applied,
        approval: approval.value,
        dryRun: dryRun.value,
        proposal,
      }
    : applied
}

async function reviewApplied(before, applied) {
  const input = {
    after_project: applied.project,
    before_project: before,
    dry_run: applied.dryRun,
    proposal: applied.proposal,
    receipt: applied.receipt,
  }
  const review = buildHumanSemanticReview(input)
  if (!review.ok) return review
  const renderings = renderHumanSemanticReview(review.value)
  if (!renderings.ok) return renderings
  const verified = verifyHumanSemanticReview(review.value, input)
  if (!verified.ok) return verified
  const renderingVerified = verifyHumanSemanticReviewRenderings(
    review.value,
    renderings.value,
  )
  return renderingVerified.ok ? review : renderingVerified
}

function tools() {
  return {
    check: (candidate) => {
      const ledger = buildFactLedger(candidate)
      return ledger.ok
        ? {
            ok: true,
            value: {
              fact_digest: ledger.value.fact_digest,
              graph_revision: candidate.graph_revision,
              schema: 're.agent-writing-evaluation-check@0.1.0',
            },
          }
        : ledger
    },
    run: (candidate) => ({
      ok: true,
      value: {
        graph_revision: candidate.graph_revision,
        outcome: 'succeeded',
        receipt_digest: digest({
          graph_revision: candidate.graph_revision,
          outcome: 'succeeded',
          schema: 're.agent-writing-evaluation-run@0.1.0',
        }),
        schema: 're.agent-writing-evaluation-run@0.1.0',
      },
    }),
  }
}

function validateInputs({ corpus, project, source_authority, toolchain_digest }) {
  if (!isObject(corpus)
    || corpus.schema !== CORPUS_SCHEMA
    || corpus.mode !== 'fixed-proposal'
    || !Array.isArray(corpus.cases)
    || canonicalJson(corpus.cases.map(({ id }) => id))
      !== canonicalJson(EXPECTED_CASES)
    || corpus.cases.some((entry) => !validCase(entry))
    || !isObject(project)
    || !DIGEST.test(project.graph_revision)
    || !isObject(source_authority)
    || Object.keys(source_authority).length === 0
    || Object.entries(source_authority).some(([path, value]) =>
      typeof path !== 'string' || !DIGEST.test(value))
    || !DIGEST.test(toolchain_digest)) {
    fail('invalid-agent-writing-evaluation-input')
  }
}

function validCase(entry) {
  return isObject(entry)
    && exactFields(entry, CASE_FIELDS)
    && typeof entry.id === 'string'
    && typeof entry.axis === 'string'
    && typeof entry.kind === 'string'
    && typeof entry.expect === 'string'
    && typeof entry.rule === 'string'
    && typeof entry.first_generation_pass === 'boolean'
    && Number.isSafeInteger(entry.repair_rounds)
    && entry.repair_rounds >= 0
    && Array.isArray(entry.affected_fact_ids)
    && Array.isArray(entry.operations)
    && isObject(entry.impact)
}

function validateReport(report) {
  if (!isObject(report)
    || report.schema !== SCHEMA
    || report.status !== 'pass'
    || report.mode !== 'fixed-proposal'
    || report.command !== 'node scripts/run-agent-writing-evaluation.js'
    || !Array.isArray(report.cases)
    || !isObject(report.authority)
    || report.authority.api_keys_required !== false
    || !DIGEST.test(report.report_digest)) {
    fail('invalid-agent-writing-evaluation-report')
  }
  exactFields(report.authority, [
    'api_keys_required',
    'corpus_digest',
    'project_digest',
    'source_authority',
    'toolchain_digest',
  ])
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function clone(value) {
  return structuredClone(value)
}

function exactFields(value, fields) {
  return isObject(value)
    && canonicalJson(Object.keys(value).sort(compareText))
      === canonicalJson([...fields].sort(compareText))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
