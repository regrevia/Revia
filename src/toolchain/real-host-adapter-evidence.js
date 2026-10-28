import { createHash } from 'node:crypto'
import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path'

const REPORT_SCHEMA = 're.real-host-adapter-evidence@0.1.0'
const FILE_AUTHORITY_SCHEMA = 're.real-host-adapter-evidence-file-authority@0.1.0'
const MEASURED_WORKLOADS = [
  'sqlite-cross-process-lock',
  'loopback-tls-bearer-auth',
  'deployment-secret-lifecycle',
]
const PENDING_WORKLOADS = [
  'external-secret-manager',
  'independent-physical-host',
]
export const REAL_HOST_ADAPTER_EVIDENCE_FILE_PATHS = Object.freeze([
  'scripts/run-real-host-adapter-evidence.js',
  'src/host/server-db-sqlite-connection-set.js',
  'src/host/server-db-sqlite-file.js',
  'src/host/server-http-client-node-tls-transport.js',
  'src/host/server-secret-deployment-adapter.js',
  'src/toolchain/real-host-adapter-evidence.js',
  'test-support/loopback-tls-fixture.js',
  'test/real-host-adapter-evidence.test.js',
  'test/server-db-sqlite-connection-set.test.js',
  'test/server-http-client-node-tls-transport.test.js',
  'test/server-secret-deployment.test.js',
])
const FILE_AUTHORITIES = new WeakMap()

export async function createRealHostAdapterEvidenceFileAuthority({
  root,
} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    fail('real-host-evidence-file-authority-path-invalid')
  }
  let canonicalRoot
  try {
    canonicalRoot = await realpath(root)
    if (!(await lstat(canonicalRoot)).isDirectory()) {
      fail('real-host-evidence-file-authority-path-invalid')
    }
  } catch (error) {
    rethrowFileAuthorityError(error)
  }

  const files = []
  for (const path of REAL_HOST_ADAPTER_EVIDENCE_FILE_PATHS) {
    try {
      const candidate = join(canonicalRoot, ...path.split('/'))
      const info = await lstat(candidate)
      if (!info.isFile()) fail('real-host-evidence-file-authority-path-invalid')
      const canonicalFile = await realpath(candidate)
      if (!isWithinRoot(canonicalRoot, canonicalFile)) {
        fail('real-host-evidence-file-authority-path-invalid')
      }
      files.push({
        digest: digest(await readFile(canonicalFile)),
        path,
      })
    } catch (error) {
      rethrowFileAuthorityError(error)
    }
  }

  const authority = Object.freeze({ schema: FILE_AUTHORITY_SCHEMA })
  FILE_AUTHORITIES.set(authority, Object.freeze(files.map(Object.freeze)))
  return authority
}

export function createRealHostAdapterEvidenceReport({
  environment,
  fileAuthority,
  results,
} = {}) {
  const files = snapshotFileAuthority(fileAuthority)
  const report = {
    environment: snapshotEnvironment(environment),
    files,
    measured: MEASURED_WORKLOADS.map((id) => {
      const result = results?.[id]
      if (!same(result, expectedResult(id))) fail('real-host-evidence-result-mismatch')
      return {
        id,
        result: structuredClone(result),
        status: 'measured',
      }
    }),
    pending: PENDING_WORKLOADS.map((id) => ({
      id,
      reason: pendingReason(id),
      status: 'pending',
    })),
    schema: REPORT_SCHEMA,
  }
  return Object.freeze({
    ...report,
    report_digest: realHostAdapterEvidenceDigest(report),
  })
}

export function verifyRealHostAdapterEvidenceReport(report, options) {
  try {
    const authorityFiles = snapshotVerifierFileAuthority(options)
    validateExactFields(report, [
      'environment',
      'files',
      'measured',
      'pending',
      'report_digest',
      'schema',
    ])
    if (report.schema !== REPORT_SCHEMA) fail('real-host-evidence-schema-mismatch')
    const environment = snapshotEnvironment(report.environment)
    if (!same(environment, report.environment)) {
      fail('real-host-evidence-environment-invalid')
    }
    const files = snapshotFileDigests(report.files)
    if (
      !same(files, report.files)
      || !same(files.map(({ path }) => path), REAL_HOST_ADAPTER_EVIDENCE_FILE_PATHS)
    ) {
      fail('real-host-evidence-file-inventory-mismatch')
    }
    if (!same(files, authorityFiles)) {
      fail('real-host-evidence-file-digest-mismatch')
    }
    if (
      !Array.isArray(report.measured)
      || report.measured.length !== MEASURED_WORKLOADS.length
      || !Array.isArray(report.pending)
      || report.pending.length !== PENDING_WORKLOADS.length
    ) {
      fail('real-host-evidence-workload-set-mismatch')
    }
    for (let index = 0; index < MEASURED_WORKLOADS.length; index += 1) {
      const entry = report.measured[index]
      validateExactFields(entry, ['id', 'result', 'status'])
      if (
        entry.id !== MEASURED_WORKLOADS[index]
        || entry.status !== 'measured'
        || !same(entry.result, expectedResult(entry.id))
      ) {
        fail('real-host-evidence-measured-invalid')
      }
    }
    for (let index = 0; index < PENDING_WORKLOADS.length; index += 1) {
      const entry = report.pending[index]
      validateExactFields(entry, ['id', 'reason', 'status'])
      if (
        entry.id !== PENDING_WORKLOADS[index]
        || entry.reason !== pendingReason(entry.id)
        || entry.status !== 'pending'
      ) {
        fail('real-host-evidence-pending-invalid')
      }
    }
    if (report.report_digest !== realHostAdapterEvidenceDigest(report)) {
      fail('real-host-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return {
      diagnostics: [{
        code: error?.code ?? 'invalid-real-host-adapter-evidence',
      }],
      ok: false,
    }
  }
}

export function realHostAdapterEvidenceDigest(report) {
  const stable = structuredClone(report)
  delete stable.report_digest
  return digest(canonicalJson(stable))
}

function expectedResult(id) {
  if (id === 'sqlite-cross-process-lock') {
    return {
      cleanup: 'child-rollback-close-exit-0',
      fault: 'declared-transient',
      recovery: 'typed-result',
      topology: 'same-host-two-node-processes',
    }
  }
  if (id === 'loopback-tls-bearer-auth') {
    return {
      auth_failure: 'http-401',
      deadline_failure: 'deadline_exceeded',
      success: 'trusted-ca-http-200',
      trust_failure: 'unavailable',
      transport: 'tls-loopback',
    }
  }
  if (id === 'deployment-secret-lifecycle') {
    return {
      after_close: 'unavailable',
      close: 'ok',
      repeated_close: 'closed',
      snapshot: 'copied',
    }
  }
  fail('real-host-evidence-workload-set-mismatch')
}

function pendingReason(id) {
  if (id === 'external-secret-manager') {
    return 'no external secret manager endpoint or deployment credentials available'
  }
  if (id === 'independent-physical-host') {
    return 'no second physical host custody available'
  }
  fail('real-host-evidence-workload-set-mismatch')
}

function snapshotEnvironment(value) {
  validateExactFields(value, [
    'architecture',
    'node_version',
    'platform',
  ])
  if (
    typeof value.architecture !== 'string'
    || typeof value.node_version !== 'string'
    || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.node_version)
    || typeof value.platform !== 'string'
  ) {
    fail('real-host-evidence-environment-invalid')
  }
  return {
    architecture: value.architecture,
    node_version: value.node_version,
    platform: value.platform,
  }
}

function snapshotFileDigests(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('real-host-evidence-file-digest-mismatch')
  }
  const output = value.map((entry) => {
    validateExactFields(entry, ['digest', 'path'])
    if (
      typeof entry.path !== 'string'
      || !/^[A-Za-z0-9._/-]+$/u.test(entry.path)
      || !/^sha256:[0-9a-f]{64}$/u.test(entry.digest)
    ) {
      fail('real-host-evidence-file-digest-mismatch')
    }
    return { digest: entry.digest, path: entry.path }
  })
  output.sort((left, right) => left.path.localeCompare(right.path))
  if (
    output.some((entry, index) => (
      index > 0 && entry.path === output[index - 1].path
    ))
  ) {
    fail('real-host-evidence-file-digest-mismatch')
  }
  return output
}

function snapshotFileAuthority(value) {
  const files = FILE_AUTHORITIES.get(value)
  if (files === undefined) fail('real-host-evidence-file-authority-required')
  return files.map((entry) => ({ ...entry }))
}

function snapshotVerifierFileAuthority(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).join(',') !== 'fileAuthority'
  ) {
    fail('real-host-evidence-file-authority-required')
  }
  return snapshotFileAuthority(options.fileAuthority)
}

function isWithinRoot(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot !== ''
    && pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
}

function rethrowFileAuthorityError(error) {
  if (error?.code === 'real-host-evidence-file-authority-path-invalid') {
    throw error
  }
  fail('real-host-evidence-file-authority-path-invalid')
}

function validateExactFields(value, fields) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
  ) {
    fail('invalid-real-host-adapter-evidence')
  }
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
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

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
