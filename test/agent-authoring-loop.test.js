import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { RELEASE_TOOLCHAIN_PATHS } from '../src/runtime/release-toolchain-inventory.js'
import { digestTrackedFiles } from '../src/runtime/release-evidence.js'
import {
  applyAgentAuthoringProposal,
  createAgentAuthoringApproval,
  createAgentAuthoringProposal,
  dryRunAgentAuthoringProposal,
} from '../src/toolchain/agent-authoring-loop.js'
import {
  runAgentAuthoringLoopConformance,
  verifyAgentAuthoringLoopConformance,
} from '../src/toolchain/agent-authoring-loop-conformance.js'
import { buildProjectReviewIndex } from '../src/toolchain/project-review-index.js'

const digest = (value) => `sha256:${createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
  .digest('hex')}`
const uid = (letter) => `${letter.repeat(25)}e`

function project() {
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
    allowed_capabilities: ['db.read@0.1.0'],
    allowed_effects: ['audit.record'],
    graph_revision: digest('base'),
    modules: [{
      edges: [{ from: 'start', to: 'finish', uid: uid('c') }],
      name: 'api',
      source_sha256: digest('source'),
      states: [{ name: 'draft', uid: uid('b') }],
      surface: {
        capabilities: [{
          instance: '@db',
          member: 'read',
          reference: 'db.read@0.1.0',
          uid: uid('d'),
        }],
        errors: [{ name: 'invalid', uid: uid('e') }],
      },
      tasks: [{ name: 'review', task_id: digest('task') }],
      uid: uid('a'),
    }],
    package_digest: digest('package'),
    project_digest: digest('base'),
    resources: [{ alias: 'database', key: 'database', uid: uid('f') }],
  }
}

function proposalFor(input, operations, impact = emptyImpact()) {
  const index = buildProjectReviewIndex(input, { limit: 500 })
  assert.equal(index.ok, true)
  const affectedFactIds = operations.every(({ kind }) => kind === 'rename-state')
    ? ['fact:project/module/api/state/draft']
    : ['fact:project/module/api']
  return createAgentAuthoringProposal(input, {
    affected_fact_ids: affectedFactIds,
    impact,
    index_revision: index.value.index_revision,
    operations,
  })
}

function renameStateOperation() {
  return {
    kind: 'rename-state',
    module: 'api',
    new_name: 'approved',
    uid: uid('b'),
  }
}

function tools({ failRun = false } = {}) {
  return {
    check: (candidate) => ({
      ok: true,
      value: {
        graph_revision: candidate.graph_revision,
        schema: 're.agent-authoring-test-check@0.1.0',
      },
    }),
    run: async (candidate) => failRun
      ? { diagnostics: [{ code: 'test-run-failure' }], ok: false }
      : {
          ok: true,
          value: {
            graph_revision: candidate.graph_revision,
            receipt_digest: digest({
              graph_revision: candidate.graph_revision,
              schema: 're.agent-authoring-test-run@0.1.0',
            }),
            schema: 're.agent-authoring-test-run@0.1.0',
          },
        },
  }
}

test('agent authoring proposal binds revision, index, UID precondition, operations, and impact', () => {
  const input = project()
  const first = proposalFor(input, [renameStateOperation()])
  const second = proposalFor(input, [renameStateOperation()])
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.deepEqual(first, second)
  assert.equal(first.value.schema, 're.agent-authoring-proposal@0.1.0')
  assert.equal(first.value.base_revision, input.graph_revision)
  assert.deepEqual(first.value.affected, [{
    fact_id: 'fact:project/module/api/state/draft',
    uid: uid('b'),
    value_digest: digest({ name: 'draft', uid: uid('b') }),
  }])
  assert.match(first.value.proposal_digest, /^sha256:[0-9a-f]{64}$/u)
})

test('agent authoring dry-run produces a checked semantic diff without mutating the project', async () => {
  const input = project()
  const before = canonicalJson(input)
  const proposal = proposalFor(input, [renameStateOperation()])
  const result = await dryRunAgentAuthoringProposal(input, proposal.value, tools())
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(canonicalJson(input), before)
  assert.equal(result.value.schema, 're.agent-authoring-dry-run@0.1.0')
  assert.equal(result.value.base_revision, input.graph_revision)
  assert.notEqual(result.value.result_revision, input.graph_revision)
  assert.equal(result.value.semantic_diff.modified.some(
    ({ fact_id }) => fact_id === 'fact:project/module/api/state/draft',
  ), false)
  assert.equal(result.value.semantic_diff.removed.some(
    ({ fact_id }) => fact_id === 'fact:project/module/api/state/draft',
  ), true)
  assert.equal(result.value.semantic_diff.added.some(
    ({ fact_id }) => fact_id === 'fact:project/module/api/state/approved',
  ), true)
  assert.equal(result.value.check.graph_revision, result.value.result_revision)
})

test('approved apply returns one revision across patch, manifest, audit, run, and translation', async () => {
  const input = project()
  const proposal = proposalFor(input, [renameStateOperation()])
  const dryRun = await dryRunAgentAuthoringProposal(input, proposal.value, tools())
  const approval = createAgentAuthoringApproval(dryRun.value, { decision: 'approved' })
  assert.equal(approval.ok, true)

  const applied = await applyAgentAuthoringProposal(
    input,
    proposal.value,
    approval.value,
    tools(),
  )
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(input.modules[0].states[0].name, 'draft')
  assert.equal(applied.project.modules[0].states[0].name, 'approved')
  const revision = applied.project.graph_revision
  assert.deepEqual([
    applied.receipt.result_revision,
    applied.receipt.patch_receipt.result_revision,
    applied.receipt.toolchain.check.graph_revision,
    applied.receipt.toolchain.manifest.graph_revision,
    applied.receipt.toolchain.audit.graph_revision,
    applied.receipt.toolchain.run.graph_revision,
    applied.receipt.toolchain.translate.graph_revision,
  ], Array(7).fill(revision))
  assert.equal(applied.receipt.schema, 're.agent-authoring-receipt@0.1.0')
  assert.match(applied.receipt.receipt_digest, /^sha256:[0-9a-f]{64}$/u)
})

test('agent authoring rejects stale, wrong-UID, forged, and unapproved proposals', async () => {
  const input = project()
  const proposal = proposalFor(input, [renameStateOperation()])
  const dryRun = await dryRunAgentAuthoringProposal(input, proposal.value, tools())
  const approval = createAgentAuthoringApproval(dryRun.value, { decision: 'approved' })

  const stale = structuredClone(proposal.value)
  stale.base_revision = digest('stale')
  assert.equal((await dryRunAgentAuthoringProposal(input, stale, tools()))
    .diagnostics[0].code, 'agent-authoring-proposal-digest-mismatch')

  const wrongUid = proposalFor(input, [{
    ...renameStateOperation(),
    uid: uid('z'),
  }])
  assert.equal(wrongUid.diagnostics[0].code, 'agent-authoring-affected-uid-missing')

  const forged = structuredClone(proposal.value)
  forged.operations[0].new_name = 'forged'
  assert.equal((await dryRunAgentAuthoringProposal(input, forged, tools()))
    .diagnostics[0].code, 'agent-authoring-proposal-digest-mismatch')

  const rejected = createAgentAuthoringApproval(dryRun.value, { decision: 'rejected' })
  assert.equal(rejected.ok, true)
  assert.equal((await applyAgentAuthoringProposal(
    input,
    proposal.value,
    rejected.value,
    tools(),
  )).diagnostics[0].code, 'agent-authoring-not-approved')

  const forgedApproval = structuredClone(approval.value)
  forgedApproval.result_revision = digest('forged')
  assert.equal((await applyAgentAuthoringProposal(
    input,
    proposal.value,
    forgedApproval,
    tools(),
  )).diagnostics[0].code, 'agent-authoring-approval-digest-mismatch')
})

test('agent authoring rejects capability/effect escalation and preserves atomic rollback', async () => {
  const input = project()
  const before = canonicalJson(input)
  const capability = proposalFor(input, [{
    expected_uid: uid('a'),
    kind: 'add-capability',
    module: 'api',
    value: {
      instance: '@secret',
      member: 'read',
      reference: 'secret.read@0.1.0',
    },
  }], {
    ...emptyImpact(),
    capabilities_added: ['secret.read@0.1.0'],
  })
  assert.equal(capability.ok, true)
  assert.equal((await dryRunAgentAuthoringProposal(input, capability.value, tools()))
    .diagnostics[0].code, 'project-patch-capability-escalation')

  const effect = proposalFor(input, [{
    expected_uid: uid('a'),
    kind: 'add-task',
    module: 'api',
    value: {
      effects: [{ id: 'secret.write' }],
      name: 'leak',
    },
  }], {
    ...emptyImpact(),
    effects_added: ['secret.write'],
  })
  assert.equal(effect.ok, true)
  assert.equal((await dryRunAgentAuthoringProposal(input, effect.value, tools()))
    .diagnostics[0].code, 'agent-authoring-effect-escalation')

  const proposal = proposalFor(input, [renameStateOperation()])
  const dryRun = await dryRunAgentAuthoringProposal(input, proposal.value, tools())
  const approval = createAgentAuthoringApproval(dryRun.value, { decision: 'approved' })
  const failed = await applyAgentAuthoringProposal(
    input,
    proposal.value,
    approval.value,
    tools({ failRun: true }),
  )
  assert.equal(failed.diagnostics[0].code, 'agent-authoring-run-failed')
  assert.equal(canonicalJson(input), before)
})

test('agent authoring rejects unknown fields and mismatched declared impact', async () => {
  const input = project()
  const proposal = proposalFor(input, [renameStateOperation()])
  const unknown = { ...proposal.value, extra: true }
  assert.equal((await dryRunAgentAuthoringProposal(input, unknown, tools()))
    .diagnostics[0].code, 'invalid-agent-authoring-proposal')

  const mismatched = proposalFor(input, [renameStateOperation()], {
    ...emptyImpact(),
    effects_added: ['audit.record'],
  })
  assert.equal((await dryRunAgentAuthoringProposal(input, mismatched.value, tools()))
    .diagnostics[0].code, 'agent-authoring-impact-mismatch')
})

test('agent authoring conformance report rebuilds trusted success and attack cases', async () => {
  const root = new URL('../', import.meta.url)
  const readJson = async (path) => JSON.parse(await readFile(
    new URL(path, root),
    'utf8',
  ))
  const sourcePaths = [
    'src/toolchain/agent-authoring-loop.js',
    'src/toolchain/agent-authoring-loop-conformance.js',
    'src/toolchain/fact-ledger.js',
    'src/toolchain/project-patch.js',
    'src/toolchain/project-review-index.js',
    'src/toolchain/project-translator.js',
  ]
  const inputs = {
    corpus: await readJson('test/fixtures/agent-authoring-loop-corpus.json'),
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
  const report = await runAgentAuthoringLoopConformance(inputs)
  assert.deepEqual(
    await verifyAgentAuthoringLoopConformance(report, inputs),
    { ok: true },
  )
  assert.deepEqual(report.cases.map(({ id }) => id), [
    'approved-state-change',
    'stale-base',
    'wrong-node',
    'capability-escalation',
    'effect-escalation',
    'forged-digest',
    'unapproved',
    'mid-apply-failure',
  ])
  assert.deepEqual(
    [...new Set(Object.values(report.evidence.tool_revisions))],
    [report.evidence.result_revision],
  )

  const resigned = structuredClone(report)
  resigned.evidence.result_revision = digest('forged-result')
  const { report_digest: ignored, ...content } = resigned
  resigned.report_digest = digest(content)
  assert.equal(
    (await verifyAgentAuthoringLoopConformance(resigned, inputs)).ok,
    false,
  )
})

function emptyImpact() {
  return {
    capabilities_added: [],
    capabilities_removed: [],
    effects_added: [],
    effects_removed: [],
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
