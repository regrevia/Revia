import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  runHumanSemanticReviewConformance,
  verifyHumanSemanticReviewConformance,
} from '../src/toolchain/human-semantic-review-conformance.js'
import {
  buildHumanSemanticReview,
  createHumanSemanticReviewDecision,
  renderHumanSemanticReview,
  verifyHumanSemanticReview,
  verifyHumanSemanticReviewDecision,
  verifyHumanSemanticReviewRenderings,
} from '../src/toolchain/human-semantic-review.js'
import { buildFactLedger } from '../src/toolchain/fact-ledger.js'
import { indexRevisionFor } from '../src/toolchain/project-review-index.js'

const digest = (value) => `sha256:${createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
  .digest('hex')}`
const uid = (letter) => `${letter.repeat(25)}e`

function project({
  error = 'invalid',
  revision = digest('before'),
  source = digest('source-before'),
  state = 'draft',
} = {}) {
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
      node_uid: uid('g'),
    }],
    graph_revision: revision,
    modules: [{
      edges: [{ from: 'start', to: 'finish', uid: uid('c') }],
      function_declarations: [{
        declaration_digest: digest('function'),
        inputs: [{ name: 'request', type: 'ExpenseRequest' }],
        name: 'review',
        outputs: [{ name: 'decision', type: 'Decision' }],
      }],
      name: 'api',
      source_sha256: source,
      states: [{ name: state, uid: uid('b') }],
      surface: {
        capabilities: [{
          instance: '@db',
          member: 'read',
          reference: 'db.read@0.1.0',
          uid: uid('d'),
        }],
        errors: [{ name: error, uid: uid('e') }],
      },
      tasks: [{
        effects: [{ id: 'audit.record' }],
        lifecycle: { retry: 'never', timeout_ms: 1000 },
        name: 'review',
        task_id: digest('task'),
      }],
      type_declarations: [{
        declaration_digest: digest('type'),
        name: 'Decision',
        variants: ['approved', 'rejected'],
      }],
      uid: uid('a'),
    }],
    resources: [{ alias: 'database', key: 'database', uid: uid('f') }],
  }
}

function evidence(before, after) {
  const beforeLedger = buildFactLedger(before).value
  const afterLedger = buildFactLedger(after).value
  const proposalContent = {
    affected: [{
      fact_id: 'fact:project/module/api/state/draft',
      uid: uid('b'),
      value_digest: digest({ name: 'draft', uid: uid('b') }),
    }],
    base_revision: before.graph_revision,
    impact: {
      capabilities_added: [],
      capabilities_removed: [],
      effects_added: [],
      effects_removed: [],
    },
    index_revision: indexRevisionFor(
      before.graph_revision,
      beforeLedger.fact_digest,
    ),
    operations: [{
      kind: 'rename-state',
      module: 'api',
      new_name: 'approved',
      uid: uid('b'),
    }],
    schema: 're.agent-authoring-proposal@0.1.0',
  }
  const proposal = {
    ...proposalContent,
    proposal_digest: digest(proposalContent),
  }
  const dryRunContent = {
    base_revision: before.graph_revision,
    check: {
      graph_revision: after.graph_revision,
      result_digest: digest('check'),
      schema: 're.agent-authoring-check-evidence@0.1.0',
    },
    index_revision: proposal.index_revision,
    patch_receipt: {
      base_revision: before.graph_revision,
      changed_fact_ids: [],
      operations: proposal.operations,
      patch_digest: digest('patch'),
      result_revision: after.graph_revision,
      schema: 're.project-patch-receipt@0.1.0',
    },
    proposal_digest: proposal.proposal_digest,
    result_revision: after.graph_revision,
    schema: 're.agent-authoring-dry-run@0.1.0',
    semantic_diff: {
      added: [],
      modified: [],
      removed: [],
      schema: 're.agent-authoring-semantic-diff@0.1.0',
    },
  }
  const dryRun = {
    ...dryRunContent,
    dry_run_digest: digest(dryRunContent),
  }
  const tool = (name) => ({
    graph_revision: after.graph_revision,
    result_digest: digest(name),
    schema: 're.agent-authoring-tool-evidence@0.1.0',
  })
  const receiptContent = {
    approval_digest: digest('approval'),
    base_revision: before.graph_revision,
    dry_run_digest: dryRun.dry_run_digest,
    patch_receipt: dryRun.patch_receipt,
    proposal_digest: proposal.proposal_digest,
    result_revision: after.graph_revision,
    schema: 're.agent-authoring-receipt@0.1.0',
    toolchain: {
      audit: { ...tool('audit'), fact_digest: afterLedger.fact_digest },
      check: dryRun.check,
      manifest: {
        ...tool('manifest'),
        fact_digest: afterLedger.fact_digest,
        index_revision: indexRevisionFor(
          after.graph_revision,
          afterLedger.fact_digest,
        ),
      },
      run: tool('run'),
      translate: {
        ...tool('translate'),
        semantic_fact_digest: digest('translated-facts'),
        translation_digest: digest('translation'),
      },
    },
  }
  return {
    dry_run: dryRun,
    proposal,
    receipt: {
      ...receiptContent,
      receipt_digest: digest(receiptContent),
    },
  }
}

test('human review classifies a UID-stable rename as one modified fact', () => {
  const before = project()
  const after = project({
    revision: digest('after'),
    source: digest('source-after'),
    state: 'approved',
  })
  const result = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.schema, 're.human-semantic-review@0.1.0')
  assert.equal(result.value.changes.added.length, 0)
  assert.equal(result.value.changes.removed.length, 0)
  assert.equal(result.value.changes.modified.length, 1)
  assert.equal(result.value.changes.modified[0].uid_anchor, uid('b'))
  assert.deepEqual(result.value.risk_flags, [])
  assert.equal(result.value.evidence.check.status, 'passed')
  assert.equal(result.value.evidence.run.status, 'passed')
  assert.equal(result.value.evidence.receipt.status, 'bound')
})

test('human review marks added capability, effect, and error facts high risk', () => {
  const before = project()
  const after = project({ revision: digest('high-risk-after') })
  after.modules[0].surface.capabilities.push({
    instance: '@secret',
    member: 'read',
    reference: 'secret.read@0.1.0',
    uid: uid('h'),
  })
  after.modules[0].surface.errors.push({ name: 'denied', uid: uid('i') })
  after.modules[0].tasks.push({
    effects: [{ id: 'secret.read' }],
    lifecycle: { retry: 'never' },
    name: 'load-secret',
    task_id: digest('secret-task'),
  })
  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  })
  assert.equal(review.ok, true, JSON.stringify(review))
  assert.deepEqual(review.value.risk_flags.map(({ code }) => code), [
    'capability-added',
    'effect-added',
    'error-added',
  ])
  assert.ok(review.value.risk_flags.every(({ severity }) => severity === 'high'))
})

test('carrier-only source and declaration order changes produce zero semantic change', () => {
  const before = project()
  const after = project({
    revision: digest('carrier-after'),
    source: digest('carrier-source-after'),
  })
  after.modules[0].surface.capabilities.reverse()
  after.modules[0].surface.errors.reverse()
  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  })
  assert.equal(review.ok, true, JSON.stringify(review))
  assert.deepEqual(review.value.changes, {
    added: [],
    modified: [],
    removed: [],
    unchanged_count: review.value.changes.unchanged_count,
  })
})

test('all renderers bind the same semantic fact and review digests', () => {
  const before = project()
  const after = project({ revision: digest('render-after'), state: 'approved' })
  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  }).value
  const renderings = renderHumanSemanticReview(review)
  assert.equal(renderings.ok, true, JSON.stringify(renderings))
  assert.deepEqual(
    Object.values(renderings.value).map((entry) => entry.semantic_fact_digest),
    Array(5).fill(review.semantic_fact_digest),
  )
  assert.deepEqual(
    Object.values(renderings.value).map((entry) => entry.review_digest),
    Array(5).fill(review.review_digest),
  )
  assert.deepEqual(
    verifyHumanSemanticReviewRenderings(review, renderings.value),
    { ok: true },
  )

  const drifted = structuredClone(renderings.value)
  drifted.html.content = `${drifted.html.content}drift`
  assert.equal(
    verifyHumanSemanticReviewRenderings(review, drifted).diagnostics[0].code,
    'human-review-renderer-drift',
  )
})

test('approve, reject, and stale decisions bind review authority without graph writes', () => {
  const before = project()
  const after = project({ revision: digest('decision-after'), state: 'approved' })
  const beforeBytes = canonicalJson(before)
  const afterBytes = canonicalJson(after)
  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  }).value
  const approved = createHumanSemanticReviewDecision(review, {
    current_base_revision: before.graph_revision,
    current_result_revision: after.graph_revision,
    decision: 'approve',
  })
  const rejected = createHumanSemanticReviewDecision(review, {
    current_base_revision: before.graph_revision,
    current_result_revision: after.graph_revision,
    decision: 'reject',
  })
  const stale = createHumanSemanticReviewDecision(review, {
    current_base_revision: digest('new-base'),
    current_result_revision: after.graph_revision,
    decision: 'stale',
  })
  assert.equal(approved.ok, true)
  assert.equal(rejected.ok, true)
  assert.equal(stale.ok, true)
  assert.equal(approved.value.review_digest, review.review_digest)
  assert.equal(stale.value.decision, 'stale')
  assert.equal(canonicalJson(before), beforeBytes)
  assert.equal(canonicalJson(after), afterBytes)

  const forged = structuredClone(review)
  forged.result_revision = digest('forged')
  assert.equal(
    createHumanSemanticReviewDecision(forged, {
      current_base_revision: before.graph_revision,
      current_result_revision: after.graph_revision,
      decision: 'approve',
    }).diagnostics[0].code,
    'human-review-digest-mismatch',
  )
})

test('human review fails closed on stale evidence and unsupported templates', () => {
  const before = project()
  const after = project({ revision: digest('invalid-after'), state: 'approved' })
  const trusted = evidence(before, after)
  trusted.receipt.result_revision = digest('stale')
  assert.equal(buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...trusted,
  }).diagnostics[0].code, 'human-review-revision-mismatch')

  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  }).value
  assert.equal(renderHumanSemanticReview(review, {
    template_registry: { 'en-US': [], 'zh-CN': [] },
  }).diagnostics[0].code, 'human-review-template-missing')
})

test('human review rejects forged or unknown authoring evidence', () => {
  const before = project()
  const after = project({ revision: digest('forged-evidence-after'), state: 'approved' })
  const forged = evidence(before, after)
  forged.proposal.operations[0].new_name = 'forged'
  assert.equal(buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...forged,
  }).diagnostics[0].code, 'human-review-proposal-digest-mismatch')

  const unknown = evidence(before, after)
  unknown.receipt.extra = true
  assert.equal(buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...unknown,
  }).diagnostics[0].code, 'invalid-human-review-receipt')
})

test('human review rejects forged dry-run and receipt authority digests', () => {
  const before = project()
  const after = project({ revision: digest('forged-authority-after'), state: 'approved' })

  const dryRunForged = evidence(before, after)
  dryRunForged.dry_run.result_revision = digest('forged-dry-run-result')
  assert.equal(buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...dryRunForged,
  }).diagnostics[0].code, 'human-review-dry-run-digest-mismatch')

  const receiptForged = evidence(before, after)
  receiptForged.receipt.approval_digest = digest('forged-approval')
  assert.equal(buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...receiptForged,
  }).diagnostics[0].code, 'human-review-receipt-digest-mismatch')
})

test('human review verifier rebuilds omitted facts and rejects synchronized resigning', () => {
  const before = project()
  const after = project({ revision: digest('verify-after'), state: 'approved' })
  const inputs = {
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  }
  const review = buildHumanSemanticReview(inputs).value
  assert.deepEqual(verifyHumanSemanticReview(review, inputs), { ok: true })

  const omitted = structuredClone(review)
  omitted.semantic_facts.after.pop()
  omitted.semantic_fact_digest = digest(omitted.semantic_facts)
  omitted.changes.unchanged_count -= 1
  const { review_digest: ignored, ...content } = omitted
  omitted.review_digest = digest(content)
  assert.equal(
    verifyHumanSemanticReview(omitted, inputs).diagnostics[0].code,
    'human-review-authority-mismatch',
  )
})

test('decision verifier rejects digest-exact records against the wrong review', () => {
  const before = project()
  const after = project({ revision: digest('decision-verify-after'), state: 'approved' })
  const review = buildHumanSemanticReview({
    after_project: after,
    before_project: before,
    ...evidence(before, after),
  }).value
  const decision = createHumanSemanticReviewDecision(review, {
    current_base_revision: before.graph_revision,
    current_result_revision: after.graph_revision,
    decision: 'approve',
  }).value
  assert.deepEqual(verifyHumanSemanticReviewDecision(decision, review, {
    current_base_revision: before.graph_revision,
    current_result_revision: after.graph_revision,
  }), { ok: true })

  const forged = structuredClone(decision)
  forged.review_digest = digest('other-review')
  const { decision_digest: ignored, ...content } = forged
  forged.decision_digest = digest(content)
  assert.equal(
    verifyHumanSemanticReviewDecision(forged, review, {
      current_base_revision: before.graph_revision,
      current_result_revision: after.graph_revision,
    }).diagnostics[0].code,
    'human-review-decision-authority-mismatch',
  )
})

test('human semantic review conformance rebuilds review and attack evidence', async () => {
  const root = new URL('../', import.meta.url)
  const readJson = async (path) => JSON.parse(await readFile(
    new URL(path, root),
    'utf8',
  ))
  const sourcePaths = [
    'src/toolchain/fact-ledger.js',
    'src/toolchain/human-semantic-review.js',
    'src/toolchain/human-semantic-review-conformance.js',
    'src/toolchain/project-review-index.js',
  ]
  const inputs = {
    corpus: await readJson('test/fixtures/human-semantic-review-corpus.json'),
    project: await readJson('test/fixtures/agent-authoring-loop-project.json'),
    source_authority: Object.fromEntries(await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        `sha256:${createHash('sha256')
          .update(await readFile(new URL(path, root)))
          .digest('hex')}`,
      ]),
    )),
    toolchain_digest: digestTrackedFiles(await Promise.all(
      RELEASE_TOOLCHAIN_PATHS.map(async (path) => ({
        bytes: await readFile(new URL(path, root)),
        path,
      })),
    )),
  }
  const report = runHumanSemanticReviewConformance(inputs)
  assert.deepEqual(
    verifyHumanSemanticReviewConformance(report, inputs),
    { ok: true },
  )
  assert.equal(report.cases.length, 10)
  assert.equal(report.evidence.graph_unchanged, true)
  assert.deepEqual(report.evidence.risk_codes, [
    'capability-added',
    'effect-added',
    'error-added',
  ])

  const resigned = structuredClone(report)
  resigned.evidence.review_digest = digest('forged-review')
  const { report_digest: ignored, ...content } = resigned
  resigned.report_digest = digest(content)
  assert.equal(
    verifyHumanSemanticReviewConformance(resigned, inputs).diagnostics[0].code,
    'human-review-conformance-authority-mismatch',
  )
})

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
