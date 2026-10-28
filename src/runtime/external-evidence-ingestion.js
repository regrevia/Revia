import { createHash } from 'node:crypto'

import { snapshotUint8Array } from '../host/uint8-array.js'
import { createEvidenceAcceptanceReceipt } from './external-evidence-adapters.js'

const IMPORT_SCHEMA = 're.external-evidence-import@0.1.0'
const IMPORT_RECEIPT_SCHEMA = 're.external-evidence-import-receipt@0.1.0'
const EXTERNAL_RECEIPT_SCHEMA = 're.external-evidence-receipt@0.1.0'
const INGEST_OUTCOME_SCHEMA = 're.external-evidence-ingest-outcome@0.1.0'
const JOURNAL_SCHEMA = 're.external-evidence-journal@0.1.0'
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_BYTES = 1024 * 1024
const MAX_RECORDS = 128
const IMPORT_FIELDS = [
  'audit',
  'batch_id',
  'candidate',
  'lifecycle',
  'manifest',
  'received_at',
  'reports',
  'schema',
  'sequence',
  'session_id',
  'source_id',
]
const RECEIPT_FIELDS = [
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
const EXTERNAL_RECEIPT_FIELDS = [
  'audit_digest',
  'candidate_digest',
  'evidence_digest',
  'graph_revision',
  'receipt_digest',
  'release_lock_digest',
  'schema',
  'stage',
]

export function createExternalEvidenceJournal({
  journal = {
    entries: [],
    schema: JOURNAL_SCHEMA,
  },
} = {}) {
  const entries = validateJournal(journal)
  const index = new Map(entries.map((entry) => [entryKey(entry), entry]))

  return Object.freeze({
    ingest({ input, now }) {
      try {
        const records = parseJsonLines(input)
        const pending = []
        const receipts = []
        const batchSessions = new Set()
        let sourceId = null
        let batchId = null
        let replayedCount = 0

        records.forEach(({ line, value }, index_) => {
          validateImport(value, index_ + 1)
          if (sourceId === null) {
            sourceId = value.source_id
            batchId = value.batch_id
          } else if (value.source_id !== sourceId || value.batch_id !== batchId) {
            throw diagnostic('external-evidence-batch-identity-mismatch')
          }
          const key = `${value.source_id}\0${value.session_id}`
          if (batchSessions.has(key)) {
            throw diagnostic('duplicate-external-evidence-session')
          }
          batchSessions.add(key)
          const receipt = createImportReceipt(value, line, now)
          const existing = index.get(key)
          if (existing !== undefined) {
            if (existing.input_digest !== receipt.input_digest
              || canonicalJson(existing) !== canonicalJson(receipt)) {
              throw diagnostic('external-evidence-session-replay-mismatch')
            }
            replayedCount += 1
            receipts.push(structuredClone(existing))
          } else {
            pending.push(receipt)
            receipts.push(structuredClone(receipt))
          }
        })

        pending.forEach((entry) => {
          entries.push(entry)
          index.set(entryKey(entry), entry)
        })
        const batchPayload = {
          batch_id: batchId,
          receipts,
          schema: INGEST_OUTCOME_SCHEMA,
          source_id: sourceId,
        }
        return {
          ok: true,
          value: {
            ...batchPayload,
            added_count: pending.length,
            batch_digest: digest(canonicalJson(batchPayload)),
            replayed_count: replayedCount,
          },
        }
      } catch (error) {
        return {
          diagnostics: [{
            code: error?.code ?? 'invalid-external-evidence-import',
          }],
          ok: false,
        }
      }
    },
    snapshot() {
      return {
        entries: entries
          .map((entry) => structuredClone(entry))
          .sort(compareEntries),
        schema: JOURNAL_SCHEMA,
      }
    },
  })
}

function parseJsonLines(input) {
  const bytes = snapshotUint8Array(input)
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw diagnostic('invalid-external-evidence-bytes')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw diagnostic('invalid-external-evidence-utf8')
  }
  if (!text.endsWith('\n')) {
    throw diagnostic('unterminated-external-evidence-jsonl')
  }
  const lines = text.slice(0, -1).split('\n')
  if (lines.length === 0 || lines.length > MAX_RECORDS || lines.some((line) => line.length === 0)) {
    throw diagnostic('invalid-external-evidence-jsonl')
  }
  return lines.map((line) => {
    try {
      return {
        line: Buffer.from(line),
        value: JSON.parse(line),
      }
    } catch {
      throw diagnostic('invalid-external-evidence-json')
    }
  })
}

function validateImport(value, expectedSequence) {
  if (!plainObject(value)
    || Object.keys(value).sort().join(',') !== IMPORT_FIELDS.join(',')
    || value.schema !== IMPORT_SCHEMA
    || !ID.test(value.source_id)
    || !ID.test(value.batch_id)
    || !ID.test(value.session_id)
    || value.sequence !== expectedSequence
    || !TIME.test(value.received_at)
    || containsSecretField(value)) {
    throw diagnostic('invalid-external-evidence-record')
  }
}

function createImportReceipt(record, line, now) {
  const externalReceipt = createEvidenceAcceptanceReceipt({
    audit: record.audit,
    candidate: record.candidate,
    lifecycle: record.lifecycle,
    manifest: record.manifest,
    now,
    reports: record.reports,
  })
  const payload = {
    batch_id: record.batch_id,
    external_receipt: externalReceipt,
    input_digest: digest(line),
    received_at: record.received_at,
    schema: IMPORT_RECEIPT_SCHEMA,
    sequence: record.sequence,
    session_id: record.session_id,
    source_id: record.source_id,
  }
  return {
    ...payload,
    import_digest: digest(canonicalJson(payload)),
  }
}

function validateJournal(journal) {
  if (!plainObject(journal)
    || Object.keys(journal).sort().join(',') !== 'entries,schema'
    || journal.schema !== JOURNAL_SCHEMA
    || !Array.isArray(journal.entries)) {
    throw new TypeError('invalid external evidence journal')
  }
  const keys = new Set()
  return journal.entries.map((entry) => {
    if (!plainObject(entry)
      || Object.keys(entry).sort().join(',') !== RECEIPT_FIELDS.join(',')
      || entry.schema !== IMPORT_RECEIPT_SCHEMA
      || !ID.test(entry.source_id)
      || !ID.test(entry.batch_id)
      || !ID.test(entry.session_id)
      || !Number.isSafeInteger(entry.sequence)
      || entry.sequence < 1
      || !TIME.test(entry.received_at)
      || !DIGEST.test(entry.input_digest)
      || !DIGEST.test(entry.import_digest)
      || !validExternalReceipt(entry.external_receipt)
      || entry.import_digest !== digest(canonicalJson({
        batch_id: entry.batch_id,
        external_receipt: entry.external_receipt,
        input_digest: entry.input_digest,
        received_at: entry.received_at,
        schema: IMPORT_RECEIPT_SCHEMA,
        sequence: entry.sequence,
        session_id: entry.session_id,
        source_id: entry.source_id,
      }))
      || keys.has(entryKey(entry))) {
      throw new TypeError('invalid external evidence journal entry')
    }
    keys.add(entryKey(entry))
    return structuredClone(entry)
  })
}

function validExternalReceipt(receipt) {
  if (!plainObject(receipt)
    || Object.keys(receipt).sort().join(',') !== EXTERNAL_RECEIPT_FIELDS.join(',')
    || receipt.schema !== EXTERNAL_RECEIPT_SCHEMA
    || receipt.stage !== 'Agent-project candidate'
    || !DIGEST.test(receipt.audit_digest)
    || !DIGEST.test(receipt.candidate_digest)
    || !DIGEST.test(receipt.evidence_digest)
    || !DIGEST.test(receipt.graph_revision)
    || !DIGEST.test(receipt.release_lock_digest)
    || !DIGEST.test(receipt.receipt_digest)) {
    return false
  }
  return receipt.receipt_digest === digest(canonicalJson({
    audit_digest: receipt.audit_digest,
    candidate_digest: receipt.candidate_digest,
    evidence_digest: receipt.evidence_digest,
    graph_revision: receipt.graph_revision,
    release_lock_digest: receipt.release_lock_digest,
    schema: EXTERNAL_RECEIPT_SCHEMA,
    stage: 'Agent-project candidate',
  }))
}

function containsSecretField(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  const keys = Object.keys(value)
  const secret = keys.some((key) =>
    /(?:credential|password|private[_-]?key|secret|token)/iu.test(key))
  const nested = secret || keys.some((key) => containsSecretField(value[key], seen))
  seen.delete(value)
  return nested
}

function entryKey(entry) {
  return `${entry.source_id}\0${entry.session_id}`
}

function compareEntries(left, right) {
  return left.source_id.localeCompare(right.source_id)
    || left.session_id.localeCompare(right.session_id)
}

function diagnostic(code) {
  const error = new TypeError(code)
  error.code = code
  return error
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic external evidence import')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic external evidence import')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
