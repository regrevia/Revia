import { createHash } from 'node:crypto'

import { snapshotUint8Array } from '../host/uint8-array.js'
import {
  releaseKeyLifecycleDigest,
} from './release-key-lifecycle.js'
import {
  createKeyCustodyAudit,
  verifyKeyCustodyAudit,
} from './key-custody-audit.js'
import {
  multiMachineEvidenceDigest,
  verifyMultiMachineEvidenceManifest,
} from './multimachine-evidence.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const RECEIPT_SCHEMA = 're.external-evidence-receipt@0.1.0'

export function createKeyCustodySignerAdapter({
  lifecycle,
  signer,
}) {
  const lifecycleDigest = releaseKeyLifecycleDigest(lifecycle)
  if (signer === null || typeof signer !== 'object'
    || typeof signer.key_id !== 'string'
    || typeof signer.sign !== 'function'
    || lifecycle.keys.find(({ key_id }) => key_id === signer.key_id) === undefined) {
    throw new TypeError('unknown key custody signer key')
  }
  const key_id = signer.key_id
  const sign = signer.sign.bind(signer)
  return Object.freeze({
    createAudit(operations) {
      return createKeyCustodyAudit({
        lifecycle,
        operations,
        signer: { key_id, sign },
      })
    },
    lifecycle_digest: lifecycleDigest,
    key_id,
  })
}

export function createRunnerEvidenceAdapter({
  reader,
}) {
  if (reader === null || typeof reader !== 'object'
    || typeof reader.read !== 'function') {
    throw new TypeError('invalid runner evidence reader')
  }
  const read = reader.read.bind(reader)
  return Object.freeze({
    ingest({ candidate, input } = {}) {
      try {
        const raw = input === undefined ? read() : input
        const bytes = snapshotUint8Array(raw)
        if (bytes === null) throw new TypeError('invalid runner evidence bytes')
        const document = JSON.parse(Buffer.from(bytes).toString('utf8'))
        if (document === null || typeof document !== 'object'
          || Array.isArray(document)
          || Object.keys(document).sort().join(',') !== 'manifest,reports') {
          throw new TypeError('invalid runner evidence document')
        }
        const verified = verifyMultiMachineEvidenceManifest({
          candidate,
          manifest: document.manifest,
          reports: document.reports,
        })
        if (!verified.ok) return verified
        return {
          ok: true,
          value: {
            manifest: document.manifest,
            reports: document.reports,
          },
        }
      } catch (error) {
        return {
          diagnostics: [{
            code: 'invalid-runner-evidence-input',
            reason: error.message,
          }],
          ok: false,
        }
      }
    },
  })
}

export function createEvidenceAcceptanceReceipt({
  audit,
  candidate,
  lifecycle,
  manifest,
  now,
  reports,
}) {
  const verified = verifyEvidence({
    audit,
    candidate,
    lifecycle,
    manifest,
    now,
    reports,
  })
  if (!verified.ok) throw new TypeError(verified.diagnostics[0].reason)
  const payload = {
    audit_digest: audit.audit_digest,
    candidate_digest: candidate.candidate_digest,
    evidence_digest: multiMachineEvidenceDigest(manifest),
    graph_revision: candidate.graph_revision,
    release_lock_digest: candidate.release_lock_digest,
    schema: RECEIPT_SCHEMA,
    stage: 'Agent-project candidate',
  }
  return {
    ...payload,
    receipt_digest: digest(canonicalJson(payload)),
  }
}

export function verifyEvidenceAcceptanceReceipt({
  audit,
  candidate,
  lifecycle,
  manifest,
  now,
  receipt,
  reports,
}) {
  try {
    const verified = verifyEvidence({
      audit,
      candidate,
      lifecycle,
      manifest,
      now,
      reports,
    })
    if (!verified.ok) return verified
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).sort().join(',') !== [
        'audit_digest',
        'candidate_digest',
        'evidence_digest',
        'graph_revision',
        'receipt_digest',
        'release_lock_digest',
        'schema',
        'stage',
      ].join(',')
      || receipt.schema !== RECEIPT_SCHEMA
      || receipt.stage !== 'Agent-project candidate'
      || receipt.audit_digest !== audit.audit_digest
      || receipt.candidate_digest !== candidate.candidate_digest
      || receipt.evidence_digest !== multiMachineEvidenceDigest(manifest)
      || receipt.graph_revision !== candidate.graph_revision
      || receipt.release_lock_digest !== candidate.release_lock_digest
      || receipt.receipt_digest !== digest(canonicalJson({
        audit_digest: receipt.audit_digest,
        candidate_digest: receipt.candidate_digest,
        evidence_digest: receipt.evidence_digest,
        graph_revision: receipt.graph_revision,
        release_lock_digest: receipt.release_lock_digest,
        schema: RECEIPT_SCHEMA,
        stage: 'Agent-project candidate',
      }))) {
      throw new TypeError('external evidence receipt identity mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: 'invalid-external-evidence-receipt',
        reason: error.message,
      }],
      ok: false,
    }
  }
}

function verifyEvidence({
  audit,
  candidate,
  lifecycle,
  manifest,
  now,
  reports,
}) {
  const custody = verifyKeyCustodyAudit({ audit, lifecycle, now })
  if (!custody.ok) return custody
  const evidence = verifyMultiMachineEvidenceManifest({
    candidate,
    manifest,
    reports,
  })
  if (!evidence.ok) return evidence
  if (!DIGEST.test(candidate.graph_revision)
    || !DIGEST.test(candidate.release_lock_digest)) {
    return {
      diagnostics: [{ code: 'invalid-external-evidence-candidate' }],
      ok: false,
    }
  }
  return { ok: true }
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('cyclic external evidence')
    seen.add(value)
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic external evidence')
    seen.add(value)
    const result = `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}
