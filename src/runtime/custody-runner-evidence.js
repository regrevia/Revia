import { createHash } from 'node:crypto'

import {
  createReleaseKeyLifecycle,
  releaseKeyLifecycleDigest,
} from './release-key-lifecycle.js'
import { verifyKeyCustodyAudit } from './key-custody-audit.js'
import {
  multiMachineEvidenceDigest,
  verifyMultiMachineEvidenceManifest,
} from './multimachine-evidence.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SCHEMA = 're.custody-runner-evidence@0.1.0'
const RECEIPT_SCHEMA = 're.custody-runner-evidence-receipt@0.1.0'
const JOURNAL_FIELDS = [
  'batch_id',
  'external_receipt',
  'import_digest',
  'input_digest',
  'received_at',
  'schema',
  'sequence',
  'session_id',
  'source_id',
]
const RECEIPT_FIELDS = [
  'audit_digest',
  'batch_id',
  'candidate_digest',
  'evidence_digest',
  'final_lifecycle_digest',
  'graph_revision',
  'journal_import_digest',
  'receipt_digest',
  'release_lock_digest',
  'schema',
  'sequence',
  'session_id',
  'source_id',
  'stage',
]

export function createCustodyRunnerEvidenceReceipt(input) {
  const verified = verifyCustodyRunnerEvidence(input)
  if (!verified.ok) throw new TypeError(verified.diagnostics[0].reason)
  const { audit, candidate, journal_entry, lifecycle_history, manifest } = input
  const payload = {
    audit_digest: audit.audit_digest,
    batch_id: journal_entry.batch_id,
    candidate_digest: candidate.candidate_digest,
    evidence_digest: multiMachineEvidenceDigest(manifest),
    final_lifecycle_digest: releaseKeyLifecycleDigest(lifecycle_history.at(-1)),
    graph_revision: candidate.graph_revision,
    journal_import_digest: journal_entry.import_digest,
    release_lock_digest: candidate.release_lock_digest,
    schema: RECEIPT_SCHEMA,
    sequence: journal_entry.sequence,
    session_id: journal_entry.session_id,
    source_id: journal_entry.source_id,
    stage: 'Agent-project candidate',
  }
  return {
    ...payload,
    receipt_digest: digest(canonicalJson(payload)),
  }
}

export function verifyCustodyRunnerEvidence({
  audit,
  candidate,
  journal_entry,
  lifecycle_history,
  manifest,
  now,
  receipt,
  reports,
}) {
  try {
    const lifecycle = validateLifecycleHistory({ audit, lifecycle_history })
    const custody = verifyKeyCustodyAudit({ audit, lifecycle, now })
    if (!custody.ok) throw new TypeError(custody.diagnostics[0].reason)
    const runner = verifyMultiMachineEvidenceManifest({ candidate, manifest, reports })
    if (!runner.ok) throw new TypeError(runner.diagnostics[0].reason)
    validateJournalEntry(journal_entry)
    const evidence_digest = multiMachineEvidenceDigest(manifest)
    if (journal_entry.external_receipt.audit_digest !== audit.audit_digest
      || journal_entry.external_receipt.candidate_digest !== candidate.candidate_digest
      || journal_entry.external_receipt.evidence_digest !== evidence_digest
      || journal_entry.external_receipt.graph_revision !== candidate.graph_revision
      || journal_entry.external_receipt.release_lock_digest !== candidate.release_lock_digest
      || journal_entry.external_receipt.stage !== 'Agent-project candidate') {
      throw new TypeError('journal evidence identity mismatch')
    }
    if (receipt !== undefined) validateReceipt({
      audit,
      candidate,
      evidence_digest,
      journal_entry,
      lifecycle,
      receipt,
    })
    return { ok: true, value: { lifecycle } }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-custody-runner-evidence',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

function validateLifecycleHistory({ audit, lifecycle_history }) {
  if (!Array.isArray(lifecycle_history)
    || lifecycle_history.length !== audit?.operations?.length + 1) {
    throw new TypeError('invalid custody lifecycle history')
  }
  const snapshots = lifecycle_history.map((snapshot) => createReleaseKeyLifecycle(snapshot))
  audit.operations.forEach((operation, index) => {
    const before = snapshots[index]
    const after = snapshots[index + 1]
    if (operation.before_lifecycle_digest !== releaseKeyLifecycleDigest(before)
      || operation.after_lifecycle_digest !== releaseKeyLifecycleDigest(after)) {
      throw new TypeError('custody lifecycle digest chain mismatch')
    }
    validateOperationTransition({ after, before, operation })
  })
  return snapshots.at(-1)
}

function validateOperationTransition({ after, before, operation }) {
  const beforeKey = findKey(before, operation.key_id)
  const afterKey = findKey(after, operation.key_id)
  switch (operation.operation) {
    case 'confirm':
      if (canonicalJson(before) !== canonicalJson(after)) {
        throw new TypeError('invalid custody confirm transition')
      }
      return
    case 'create':
      if (beforeKey !== undefined || afterKey === undefined) {
        throw new TypeError('invalid custody create transition')
      }
      return
    case 'rotate': {
      const successor = findKey(after, operation.successor_key_id)
      if (beforeKey?.status !== 'active'
        || afterKey?.status !== 'rotated'
        || afterKey.successor_key_id !== operation.successor_key_id
        || successor?.status !== 'active'
        || after.current_key_id !== operation.successor_key_id) {
        throw new TypeError('invalid custody rotate transition')
      }
      return
    }
    case 'revoke':
      if (beforeKey === undefined || afterKey?.status !== 'revoked'
        || after.current_key_id === operation.key_id) {
        throw new TypeError('invalid custody revoke transition')
      }
      return
    case 'expire':
      if (beforeKey === undefined || afterKey?.status !== 'expired'
        || after.current_key_id === operation.key_id) {
        throw new TypeError('invalid custody expire transition')
      }
      return
    default:
      throw new TypeError('invalid custody operation transition')
  }
}

function validateJournalEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).sort().join(',') !== JOURNAL_FIELDS.join(',')
    || entry.schema !== 're.external-evidence-import-receipt@0.1.0'
    || !DIGEST.test(entry.import_digest)
    || entry.import_digest !== digest(canonicalJson({
      batch_id: entry.batch_id,
      external_receipt: entry.external_receipt,
      input_digest: entry.input_digest,
      received_at: entry.received_at,
      schema: entry.schema,
      sequence: entry.sequence,
      session_id: entry.session_id,
      source_id: entry.source_id,
    }))) {
    throw new TypeError('invalid external evidence journal entry')
  }
}

function validateReceipt({
  audit,
  candidate,
  evidence_digest,
  journal_entry,
  lifecycle,
  receipt,
}) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',') !== RECEIPT_FIELDS.join(',')
    || receipt.schema !== RECEIPT_SCHEMA
    || receipt.stage !== 'Agent-project candidate'
    || receipt.audit_digest !== audit.audit_digest
    || receipt.candidate_digest !== candidate.candidate_digest
    || receipt.evidence_digest !== evidence_digest
    || receipt.final_lifecycle_digest !== releaseKeyLifecycleDigest(lifecycle)
    || receipt.graph_revision !== candidate.graph_revision
    || receipt.release_lock_digest !== candidate.release_lock_digest
    || receipt.journal_import_digest !== journal_entry.import_digest
    || receipt.batch_id !== journal_entry.batch_id
    || receipt.sequence !== journal_entry.sequence
    || receipt.session_id !== journal_entry.session_id
    || receipt.source_id !== journal_entry.source_id
    || receipt.receipt_digest !== digest(canonicalJson({
      audit_digest: receipt.audit_digest,
      batch_id: receipt.batch_id,
      candidate_digest: receipt.candidate_digest,
      evidence_digest: receipt.evidence_digest,
      final_lifecycle_digest: receipt.final_lifecycle_digest,
      graph_revision: receipt.graph_revision,
      journal_import_digest: receipt.journal_import_digest,
      release_lock_digest: receipt.release_lock_digest,
      schema: RECEIPT_SCHEMA,
      sequence: receipt.sequence,
      session_id: receipt.session_id,
      source_id: receipt.source_id,
      stage: receipt.stage,
    }))) {
    throw new TypeError('custody runner evidence receipt identity mismatch')
  }
}

function findKey(lifecycle, key_id) {
  return lifecycle.keys.find((key) => key.key_id === key_id)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic custody runner evidence')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic custody runner evidence')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
