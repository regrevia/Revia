import { createHash } from 'node:crypto'

import {
  applyAgentAuthoringProposal,
  createAgentAuthoringApproval,
  createAgentAuthoringProposal,
  dryRunAgentAuthoringProposal,
} from './agent-authoring-loop.js'
import { buildFactLedger } from './fact-ledger.js'
import { buildProjectReviewIndex } from './project-review-index.js'

const SCHEMA = 're.agent-authoring-loop-conformance@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const EXPECTED_CASES = [
  'approved-state-change',
  'stale-base',
  'wrong-node',
  'capability-escalation',
  'effect-escalation',
  'forged-digest',
  'unapproved',
  'mid-apply-failure',
]

export async function runAgentAuthoringLoopConformance({
  corpus,
  project,
  source_authority,
  toolchain_digest,
}) {
  validateInputs({ corpus, project, source_authority, toolchain_digest })
  const proposal = requireValue(createProposal(project, renameStateOperation()))
  const dryRun = requireValue(await dryRunAgentAuthoringProposal(
    project,
    proposal,
    tools(),
  ))
  const approval = requireValue(createAgentAuthoringApproval(dryRun, {
    decision: 'approved',
  }))
  const applied = await applyAgentAuthoringProposal(
    project,
    proposal,
    approval,
    tools(),
  )
  if (!applied.ok) fail(applied.diagnostics[0].code)

  const observations = new Map()
  observations.set('approved-state-change', {
    code: 'success',
    result_revision: applied.project.graph_revision,
  })

  const stale = structuredClone(proposal)
  stale.base_revision = fixedDigest('stale')
  observations.set('stale-base', await observedDryRun(project, stale))

  const wrongNode = createProposal(project, {
    ...renameStateOperation(),
    uid: 'zzzzzzzzzzzzzzzzzzzzzzzzze',
  })
  observations.set('wrong-node', observedResult(wrongNode))

  const capability = requireValue(createProposal(
    project,
    {
      expected_uid: 'aaaaaaaaaaaaaaaaaaaaaaaaae',
      kind: 'add-capability',
      module: 'api',
      value: {
        instance: '@secret',
        member: 'read',
        reference: 'secret.read@0.1.0',
      },
    },
    {
      ...emptyImpact(),
      capabilities_added: ['secret.read@0.1.0'],
    },
    ['fact:project/module/api'],
  ))
  observations.set(
    'capability-escalation',
    await observedDryRun(project, capability),
  )

  const effect = requireValue(createProposal(
    project,
    {
      expected_uid: 'aaaaaaaaaaaaaaaaaaaaaaaaae',
      kind: 'add-task',
      module: 'api',
      value: {
        effects: [{ id: 'secret.write' }],
        name: 'leak',
      },
    },
    {
      ...emptyImpact(),
      effects_added: ['secret.write'],
    },
    ['fact:project/module/api'],
  ))
  observations.set('effect-escalation', await observedDryRun(project, effect))

  const forged = structuredClone(proposal)
  forged.operations[0].new_name = 'forged'
  observations.set('forged-digest', await observedDryRun(project, forged))

  const rejected = requireValue(createAgentAuthoringApproval(dryRun, {
    decision: 'rejected',
  }))
  observations.set('unapproved', observedResult(await applyAgentAuthoringProposal(
    project,
    proposal,
    rejected,
    tools(),
  )))
  observations.set(
    'mid-apply-failure',
    observedResult(await applyAgentAuthoringProposal(
      project,
      proposal,
      approval,
      tools({ failRun: true }),
    )),
  )

  const cases = corpus.cases.map((entry) => {
    const observed = observations.get(entry.id)
    if (observed === undefined || observed.code !== entry.expect) {
      fail('agent-authoring-conformance-case-mismatch', {
        actual: observed?.code ?? null,
        expected: entry.expect,
        id: entry.id,
      })
    }
    return {
      expected: entry.expect,
      id: entry.id,
      observed: observed.code,
      status: 'pass',
    }
  })
  const content = {
    authority: {
      corpus_digest: digest(corpus),
      project_digest: digest(project),
      source_authority: structuredClone(source_authority),
      toolchain_digest,
    },
    cases,
    evidence: {
      approval_digest: approval.approval_digest,
      dry_run_digest: dryRun.dry_run_digest,
      proposal_digest: proposal.proposal_digest,
      receipt_digest: applied.receipt.receipt_digest,
      result_revision: applied.project.graph_revision,
      tool_revisions: Object.fromEntries(Object.entries(
        applied.receipt.toolchain,
      ).map(([name, value]) => [name, value.graph_revision])),
    },
    schema: SCHEMA,
    status: 'pass',
  }
  return {
    ...content,
    report_digest: digest(content),
  }
}

export async function verifyAgentAuthoringLoopConformance(report, inputs) {
  try {
    exactFields(report, [
      'authority',
      'cases',
      'evidence',
      'report_digest',
      'schema',
      'status',
    ])
    if (report.schema !== SCHEMA || report.status !== 'pass'
      || !DIGEST.test(report.report_digest)) {
      fail('invalid-agent-authoring-conformance-report')
    }
    const { report_digest: reportDigest, ...content } = report
    if (reportDigest !== digest(content)) {
      fail('agent-authoring-conformance-report-digest-mismatch')
    }
    const expected = await runAgentAuthoringLoopConformance(inputs)
    if (canonicalJson(report) !== canonicalJson(expected)) {
      fail('agent-authoring-conformance-report-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [error?.diagnostic ?? {
        code: 'invalid-agent-authoring-conformance-report',
      }],
      ok: false,
    }
  }
}

function createProposal(
  project,
  operation,
  impact = emptyImpact(),
  affectedFactIds = ['fact:project/module/api/state/draft'],
) {
  const index = buildProjectReviewIndex(project, { limit: 500 })
  if (!index.ok) return index
  return createAgentAuthoringProposal(project, {
    affected_fact_ids: affectedFactIds,
    impact,
    index_revision: index.value.index_revision,
    operations: [operation],
  })
}

function renameStateOperation() {
  return {
    kind: 'rename-state',
    module: 'api',
    new_name: 'approved',
    uid: 'bbbbbbbbbbbbbbbbbbbbbbbbbe',
  }
}

function tools({ failRun = false } = {}) {
  return {
    check: (candidate) => {
      const ledger = buildFactLedger(candidate)
      return ledger.ok
        ? {
            ok: true,
            value: {
              fact_digest: ledger.value.fact_digest,
              graph_revision: candidate.graph_revision,
              schema: 're.agent-authoring-conformance-check@0.1.0',
            },
          }
        : ledger
    },
    run: (candidate) => failRun
      ? {
          diagnostics: [{ code: 'conformance-run-failure' }],
          ok: false,
        }
      : {
          ok: true,
          value: {
            graph_revision: candidate.graph_revision,
            outcome: 'succeeded',
            receipt_digest: digest({
              graph_revision: candidate.graph_revision,
              outcome: 'succeeded',
              schema: 're.agent-authoring-conformance-run@0.1.0',
            }),
            schema: 're.agent-authoring-conformance-run@0.1.0',
          },
        },
  }
}

async function observedDryRun(project, proposal) {
  return observedResult(await dryRunAgentAuthoringProposal(
    project,
    proposal,
    tools(),
  ))
}

function observedResult(result) {
  return {
    code: result.ok ? 'success' : result.diagnostics[0].code,
  }
}

function requireValue(result) {
  if (!result.ok) fail(result.diagnostics[0].code)
  return result.value
}

function validateInputs({ corpus, project, source_authority, toolchain_digest }) {
  if (!isObject(corpus)
    || corpus.schema !== 're.agent-authoring-loop-corpus@0.1.0'
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
    fail('invalid-agent-authoring-conformance-input')
  }
}

function emptyImpact() {
  return {
    capabilities_added: [],
    capabilities_removed: [],
    effects_added: [],
    effects_removed: [],
  }
}

function fixedDigest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactFields(value, fields) {
  if (!isObject(value)
    || canonicalJson(Object.keys(value).sort(compareText))
      !== canonicalJson([...fields].sort(compareText))) {
    fail('invalid-agent-authoring-conformance-report')
  }
}

function compareText(left, right) {
  return Buffer.from(String(left), 'utf8').compare(Buffer.from(String(right), 'utf8'))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code, details = {}) {
  throw Object.assign(new TypeError(code), { diagnostic: { code, ...details } })
}
