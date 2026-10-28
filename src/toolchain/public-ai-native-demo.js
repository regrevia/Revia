import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const SCHEMA = 're.public-ai-native-demo@0.1.0'
const CORPUS_SCHEMA = 're.agent-writing-evaluation-corpus@0.1.0'
const REQUIRED_CASES = [
  'modify-business-rule',
  'stale-revision-attack',
  'capability-overreach-attack',
]
const SEQUENCE = [
  'proposal',
  'dry-run',
  'semantic-diff-review',
  'approval',
  'apply',
  'check',
  'manifest',
  'run',
  'translate',
  'receipt',
  'human-semantic-review',
]
const DIGEST = /^sha256:[0-9a-f]{64}$/u

export async function runPublicAiNativeDemo({
  corpus,
  project,
  expense_project_path: expenseProjectPath,
  expense_run_fixture_path: expenseRunFixturePath,
  root,
} = {}) {
  const started = Date.now()
  validateInputs({
    corpus,
    project,
    expenseProjectPath,
    expenseRunFixturePath,
    root,
  })
  const entries = new Map(corpus.cases.map((entry) => [entry.id, entry]))
  const base = clone(project)
  const success = await runSuccessCase(base, entries.get('modify-business-rule'))
  const stale = await runAttackCase(
    base,
    entries.get('stale-revision-attack'),
    'stale',
  )
  const capability = await runAttackCase(
    base,
    entries.get('capability-overreach-attack'),
    'capability',
  )
  const expenseProject = runExpenseProject({
    expenseProjectPath,
    expenseRunFixturePath,
    root: resolveRoot(root),
  })
  const content = {
    authority: {
      api_keys_required: false,
      corpus_digest: digest(corpus),
      project_digest: digest(project),
      scenario: 'expense-approval',
    },
    attacks: {
      capability_overreach: capability,
      stale,
    },
    command: 'node scripts/run-public-ai-native-demo.js',
    command_duration_ms: Date.now() - started,
    expense_project: expenseProject,
    mode: 'fixed-proposal',
    schema: SCHEMA,
    sequence: SEQUENCE,
    status: 'pass',
    success,
  }
  return {
    ...content,
    report_digest: digest(forDigest(content)),
  }
}

export async function verifyPublicAiNativeDemo(report, inputs) {
  try {
    validateReport(report)
    if (report.report_digest !== digest(forDigest(report))) {
      fail('public-ai-native-demo-report-digest-mismatch')
    }
    const expected = await runPublicAiNativeDemo(inputs)
    if (canonicalJson(forDigest(report)) !== canonicalJson(forDigest(expected))) {
      fail('public-ai-native-demo-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? {
        code: 'invalid-public-ai-native-demo',
      }],
      ok: false,
    }
  }
}

async function runSuccessCase(project, entry) {
  const proposal = createProposal(project, entry)
  if (!proposal.ok) return reject(proposal)
  const dryRun = await dryRunAgentAuthoringProposal(project, proposal.value, tools())
  if (!dryRun.ok) return reject(dryRun)
  const semanticDiffReview = {
    changes: clone(dryRun.value.semantic_diff),
    proposal_digest: proposal.value.proposal_digest,
    result_revision: dryRun.value.result_revision,
    schema: 're.public-ai-native-demo-semantic-diff@0.1.0',
    status: 'passed',
  }
  const approval = createAgentAuthoringApproval(dryRun.value, {
    decision: 'approved',
  })
  if (!approval.ok) return reject(approval)
  const appliedResult = await applyAgentAuthoringProposal(
    project,
    proposal.value,
    approval.value,
    tools(),
  )
  if (!appliedResult.ok) return reject(appliedResult)
  const applied = {
    ...appliedResult,
    approval: approval.value,
    dryRun: dryRun.value,
    proposal: proposal.value,
  }
  const review = buildHumanReview(project, applied)
  if (!review.ok) return reject(review)
  const toolchain = Object.fromEntries(
    ['check', 'manifest', 'run', 'translate'].map((name) => [
      name,
      {
        evidence: clone(applied.receipt.toolchain[name]),
        status: 'passed',
      },
    ]),
  )
  return {
    approval: {
      approval_digest: approval.value.approval_digest,
      decision: approval.value.decision,
      status: 'approved',
    },
    apply: {
      result_revision: applied.receipt.result_revision,
      status: 'applied',
    },
    dry_run: {
      dry_run_digest: dryRun.value.dry_run_digest,
      result_revision: dryRun.value.result_revision,
      status: 'passed',
    },
    human_semantic_review: {
      review_digest: review.value.review_digest,
      semantic_fact_digest: review.value.semantic_fact_digest,
      status: 'passed',
    },
    proposal: {
      proposal_digest: proposal.value.proposal_digest,
      status: 'created',
    },
    receipt: {
      receipt_digest: applied.receipt.receipt_digest,
      result_revision: applied.receipt.result_revision,
      status: 'issued',
    },
    semantic_diff_review: semanticDiffReview,
    status: 'pass',
    toolchain,
  }
}

async function runAttackCase(project, entry, attack) {
  const before = canonicalJson(project)
  const proposal = createProposal(project, entry)
  if (!proposal.ok) return attackResult(attack, proposal, before, project)
  let result
  if (attack === 'stale') {
    const stale = clone(proposal.value)
    stale.base_revision = digest('stale-base')
    result = await dryRunAgentAuthoringProposal(project, stale, tools())
  } else {
    result = await dryRunAgentAuthoringProposal(
      project,
      proposal.value,
      tools(),
    )
  }
  return attackResult(attack, result, before, project)
}

function attackResult(attack, result, before, project) {
  const diagnostic = result.ok ? 'unexpected-success' : diagnosticCode(result)
  return {
    dangerous_modification_rejected: !result.ok,
    diagnostic,
    graph_unchanged: before === canonicalJson(project),
    status: result.ok ? 'unexpected-success' : 'rejected',
    type: attack,
  }
}

function buildHumanReview(before, applied) {
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

function runExpenseProject({
  expenseProjectPath,
  expenseRunFixturePath,
  root,
}) {
  const check = runCli(root, [
    'project-check',
    '--format',
    'json',
    expenseProjectPath,
  ])
  const run = runCli(root, [
    'project-run',
    '--fixture',
    expenseRunFixturePath,
    expenseProjectPath,
  ])
  const translate = runCli(root, [
    'project-translate',
    '--locale',
    'en-US',
    '--format',
    'json',
    expenseProjectPath,
  ])
  if (!check.ok || !run.ok || !translate.ok) {
    fail('public-ai-native-demo-expense-project-failed', {
      check: check.ok,
      run: run.ok,
      translate: translate.ok,
    })
  }
  return {
    graph_revision: check.value.graph.revision,
    module_count: check.value.graph.modules.length,
    project_run_receipt_digest: run.value.receipt.receipt_digest,
    project_translation_schema: translate.value.schema,
    status: 'passed',
  }
}

function runCli(root, arguments_) {
  const result = spawnSync(process.execPath, ['src/cli/re.js', ...arguments_], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if (result.status !== 0) {
    return {
      diagnostics: result.stderr.trim(),
      ok: false,
    }
  }
  try {
    return {
      ok: true,
      value: JSON.parse(result.stdout),
    }
  } catch {
    return {
      diagnostics: 'invalid-json',
      ok: false,
    }
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

function validateInputs({
  corpus,
  project,
  expenseProjectPath,
  expenseRunFixturePath,
  root,
}) {
  if (corpus?.schema !== CORPUS_SCHEMA
    || !Array.isArray(corpus.cases)
    || REQUIRED_CASES.some((id) => !corpus.cases.some((entry) => entry.id === id))
    || !project
    || !DIGEST.test(project.graph_revision)
    || typeof expenseProjectPath !== 'string'
    || typeof expenseRunFixturePath !== 'string'
    || !root) {
    fail('invalid-public-ai-native-demo-input')
  }
}

function validateReport(report) {
  if (!isObject(report)
    || report.schema !== SCHEMA
    || report.status !== 'pass'
    || report.mode !== 'fixed-proposal'
    || report.command !== 'node scripts/run-public-ai-native-demo.js'
    || !Array.isArray(report.sequence)
    || canonicalJson(report.sequence) !== canonicalJson(SEQUENCE)
    || !DIGEST.test(report.report_digest)
    || !isObject(report.authority)
    || report.authority.api_keys_required !== false
    || report.expense_project?.status !== 'passed'
    || report.success?.status !== 'pass') {
    fail('invalid-public-ai-native-demo-report')
  }
}

function resolveRoot(root) {
  return root instanceof URL ? fileURLToPath(root) : root
}

function forDigest(value) {
  const content = clone(value)
  delete content.report_digest
  content.command_duration_ms = 0
  return content
}

function reject(result) {
  fail('public-ai-native-demo-step-failed', {
    diagnostic: diagnosticCode(result),
  })
}

function attackResultCode(result) {
  return result.ok ? 'unexpected-success' : diagnosticCode(result)
}

function diagnosticCode(result) {
  return result?.diagnostics?.[0]?.code
    ?? result?.diagnostic?.code
    ?? 'unknown-public-ai-native-demo-error'
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')}`
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { diagnostic: { code, ...details } })
}
