import { createHash } from 'node:crypto'
import { arch, platform } from 'node:os'

import {
  MINIMAL_STD_NATIVE_PROFILE,
  MINIMAL_STD_NATIVE_REPORT_SCHEMA,
  runMinimalStdNativeConformance,
  verifyMinimalStdNativeReportAuthority,
} from './minimal-std-native.js'
import {
  PORTABLE_RUNTIME_PACKAGE_SCHEMA,
  portableRuntimePackageDigest,
} from './portable-runtime-package.js'

export const MINIMAL_STD_NATIVE_RUNNER_PROFILE =
  're.minimal-std-native-runner@0.1.0'
export const MINIMAL_STD_NATIVE_REQUEST_SCHEMA =
  're.minimal-std-native-runner-request@0.1.0'
export const MINIMAL_STD_NATIVE_RECEIPT_SCHEMA =
  're.minimal-std-native-runner-receipt@0.1.0'
export const MINIMAL_STD_NATIVE_MATRIX_SCHEMA =
  're.minimal-std-native-runner-matrix@0.1.0'
export const MINIMAL_STD_NATIVE_EVIDENCE_SCHEMA =
  're.minimal-std-native-runner-evidence@0.1.0'

export const MINIMAL_STD_NATIVE_RUNNER_TARGETS = Object.freeze([
  Object.freeze({
    architecture: 'arm64',
    compiler_path: '/usr/bin/clang',
    id: 'darwin-arm64-native-c11-minimal-std',
    platform: 'darwin',
    runtime: 'native-c11',
    target_triple: 'arm64-apple-darwin',
  }),
  Object.freeze({
    architecture: 'x64',
    compiler_path: '/usr/bin/clang',
    id: 'linux-x64-native-c11-minimal-std',
    platform: 'linux',
    runtime: 'native-c11',
    target_triple: 'x86_64-unknown-linux-gnu',
  }),
])

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CHALLENGE = /^[0-9a-f]{64}$/u
const TARGET_FIELDS = [
  'architecture',
  'compiler_path',
  'id',
  'platform',
  'runtime',
  'target_triple',
]
const REQUEST_FIELDS = [
  'bundle_digest',
  'challenge',
  'package_digest',
  'profile',
  'request_digest',
  'schema',
  'target',
]
const RECEIPT_FIELDS = [
  'bundle_digest',
  'challenge_digest',
  'package_digest',
  'profile',
  'provenance',
  'receipt_digest',
  'report_digest',
  'request_digest',
  'schema',
  'status',
  'target',
  'workloads',
]
const MATRIX_FIELDS = [
  'bundle_digest',
  'matrix_digest',
  'package_digest',
  'profile',
  'schema',
  'status',
  'targets',
]
const CLAIM_FIELDS = ['receipt', 'request', 'target_id']
const EVIDENCE_FIELDS = [
  'bundle_digest',
  'claims',
  'evidence_digest',
  'matrix_digest',
  'measured_targets',
  'pending_targets',
  'schema',
  'status',
]

export function createMinimalStdNativeRunnerRequest({
  bundle,
  challenge,
  package: archive,
  target,
} = {}) {
  try {
    validatePackageAndBundle(archive, bundle)
    validateTarget(target)
    if (!CHALLENGE.test(challenge)) fail('minimal-std-native-runner-challenge-invalid')
    const request = {
      bundle_digest: bundle.bundle_digest,
      challenge,
      package_digest: archive.package_digest,
      profile: MINIMAL_STD_NATIVE_RUNNER_PROFILE,
      schema: MINIMAL_STD_NATIVE_REQUEST_SCHEMA,
      target,
    }
    request.request_digest = requestDigest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-request-invalid')
  }
}

export function verifyMinimalStdNativeRunnerRequest(request, {
  bundle,
  package: archive,
} = {}) {
  try {
    validatePackageAndBundle(archive, bundle)
    validateRequest(request)
    if (request.package_digest !== archive.package_digest
      || request.bundle_digest !== bundle.bundle_digest
      || request.request_digest !== requestDigest(request)) {
      fail('minimal-std-native-runner-request-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-request-invalid')
  }
}

export async function runMinimalStdNativeRunner({
  abi,
  bundle,
  compiler_path,
  corpus,
  package: archive,
  request,
} = {}) {
  try {
    const verified = verifyMinimalStdNativeRunnerRequest(request, {
      bundle,
      package: archive,
    })
    if (!verified.ok) return verified
    if (compiler_path !== request.target.compiler_path) {
      fail('minimal-std-native-runner-compiler-mismatch')
    }
    if (request.target.platform !== platform()
      || request.target.architecture !== arch()) {
      fail('minimal-std-native-runner-environment-mismatch')
    }
    const result = await runMinimalStdNativeConformance({
      abi,
      bundle,
      compiler_path,
      corpus,
      target_triple: request.target.target_triple,
    })
    if (!result.ok) return result
    const receipt = {
      bundle_digest: bundle.bundle_digest,
      challenge_digest: digestValue(request.challenge),
      package_digest: archive.package_digest,
      profile: MINIMAL_STD_NATIVE_RUNNER_PROFILE,
      provenance: result.value.provenance,
      report_digest: result.value.report_digest,
      request_digest: request.request_digest,
      schema: MINIMAL_STD_NATIVE_RECEIPT_SCHEMA,
      status: 'measured',
      target: request.target,
      workloads: result.value.workloads,
    }
    receipt.receipt_digest = receiptDigest(receipt)
    validateReceipt(receipt)
    return { ok: true, value: receipt }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-failed')
  }
}

export async function verifyMinimalStdNativeRunnerReceipt(receipt, {
  abi,
  bundle,
  corpus,
  package: archive,
  request,
} = {}) {
  try {
    const verified = verifyMinimalStdNativeRunnerRequest(request, {
      bundle,
      package: archive,
    })
    if (!verified.ok) return verified
    validateReceipt(receipt)
    if (receipt.package_digest !== archive.package_digest
      || receipt.bundle_digest !== bundle.bundle_digest
      || receipt.request_digest !== request.request_digest
      || receipt.challenge_digest !== digestValue(request.challenge)
      || !canonicalEqual(receipt.target, request.target)
      || receipt.receipt_digest !== receiptDigest(receipt)) {
      fail('minimal-std-native-runner-receipt-authority-mismatch')
    }
    const report = {
      bundle_digest: receipt.bundle_digest,
      profile: MINIMAL_STD_NATIVE_PROFILE,
      provenance: receipt.provenance,
      report_digest: receipt.report_digest,
      schema: MINIMAL_STD_NATIVE_REPORT_SCHEMA,
      status: 'measured',
      target_triple: receipt.target.target_triple,
      workloads: receipt.workloads,
    }
    const authority = verifyMinimalStdNativeReportAuthority(report, {
      abi,
      bundle,
      corpus,
      target_triple: receipt.target.target_triple,
    })
    if (!authority.ok) return authority
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-receipt-invalid')
  }
}

export function createMinimalStdNativeRunnerMatrix({
  bundle,
  package: archive,
} = {}) {
  try {
    validatePackageAndBundle(archive, bundle)
    const matrix = {
      bundle_digest: bundle.bundle_digest,
      package_digest: archive.package_digest,
      profile: MINIMAL_STD_NATIVE_RUNNER_PROFILE,
      schema: MINIMAL_STD_NATIVE_MATRIX_SCHEMA,
      status: 'minimal-std-native-runner-conformance-pending',
      targets: MINIMAL_STD_NATIVE_RUNNER_TARGETS,
    }
    matrix.matrix_digest = matrixDigest(matrix)
    return { ok: true, value: matrix }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-matrix-invalid')
  }
}

export function verifyMinimalStdNativeRunnerMatrix(matrix, {
  bundle,
  package: archive,
} = {}) {
  try {
    validatePackageAndBundle(archive, bundle)
    validateMatrix(matrix)
    if (matrix.package_digest !== archive.package_digest
      || matrix.bundle_digest !== bundle.bundle_digest
      || !canonicalEqual(matrix.targets, MINIMAL_STD_NATIVE_RUNNER_TARGETS)
      || matrix.matrix_digest !== matrixDigest(matrix)) {
      fail('minimal-std-native-runner-matrix-authority-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-matrix-invalid')
  }
}

export async function createMinimalStdNativeRunnerEvidence({
  claims,
  matrix,
  ...inputs
} = {}) {
  try {
    const verified = verifyMinimalStdNativeRunnerMatrix(matrix, inputs)
    if (!verified.ok) return verified
    if (!Array.isArray(claims)) {
      fail('minimal-std-native-runner-evidence-claims-invalid')
    }
    const normalized = claims.map(({ receipt, request }) => ({
      receipt,
      request,
      target_id: request?.target?.id,
    })).sort(compareClaims)
    const measured = normalized.map(({ target_id }) => target_id)
    const pending = matrix.targets
      .map(({ id }) => id)
      .filter((id) => !measured.includes(id))
    const evidence = {
      bundle_digest: matrix.bundle_digest,
      claims: normalized,
      matrix_digest: matrix.matrix_digest,
      measured_targets: measured,
      pending_targets: pending,
      schema: MINIMAL_STD_NATIVE_EVIDENCE_SCHEMA,
      status: pending.length === 0 ? 'complete' : 'partial',
    }
    evidence.evidence_digest = evidenceDigest(evidence)
    const checked = await verifyMinimalStdNativeRunnerEvidence(evidence, {
      matrix,
      ...inputs,
    })
    return checked.ok ? { ok: true, value: evidence } : checked
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-evidence-invalid')
  }
}

export async function verifyMinimalStdNativeRunnerEvidence(evidence, {
  matrix,
  ...inputs
} = {}) {
  try {
    const verified = verifyMinimalStdNativeRunnerMatrix(matrix, inputs)
    if (!verified.ok) return verified
    validateEvidence(evidence)
    const targetIds = matrix.targets.map(({ id }) => id)
    const claimIds = []
    for (const claim of evidence.claims) {
      if (claim.target_id !== claim.request?.target?.id
        || claim.target_id !== claim.receipt?.target?.id) {
        fail('minimal-std-native-runner-evidence-claim-mismatch')
      }
      if (claimIds.includes(claim.target_id)) {
        fail('minimal-std-native-runner-evidence-duplicate-claim')
      }
      claimIds.push(claim.target_id)
      const receipt = await verifyMinimalStdNativeRunnerReceipt(
        claim.receipt,
        { ...inputs, request: claim.request },
      )
      if (!receipt.ok) return receipt
    }
    const pending = targetIds.filter((id) => !claimIds.includes(id))
    if (evidence.bundle_digest !== matrix.bundle_digest
      || evidence.matrix_digest !== matrix.matrix_digest
      || !canonicalEqual(claimIds.sort(), evidence.measured_targets)
      || !canonicalEqual(pending, evidence.pending_targets)
      || evidence.status !== (pending.length === 0 ? 'complete' : 'partial')
      || evidence.evidence_digest !== evidenceDigest(evidence)) {
      fail('minimal-std-native-runner-evidence-partition-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'minimal-std-native-runner-evidence-invalid')
  }
}

export function requestDigest(request) {
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function receiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function matrixDigest(matrix) {
  const { matrix_digest: ignored, ...content } = matrix
  return digestValue(content)
}

export function evidenceDigest(evidence) {
  const { evidence_digest: ignored, ...content } = evidence
  return digestValue(content)
}

function validatePackageAndBundle(archive, bundle) {
  if (!archive || archive.schema !== PORTABLE_RUNTIME_PACKAGE_SCHEMA
    || !DIGEST.test(archive.package_digest)
    || archive.package_digest !== portableRuntimePackageDigest(archive)
    || !bundle || !DIGEST.test(bundle.bundle_digest)
    || !plainObject(archive.manifest)
    || archive.manifest.authorities?.minimal_std_native_bundle_digest
      !== bundle.bundle_digest) {
    fail('minimal-std-native-runner-authority-invalid')
  }
}

function validateTarget(target) {
  const expected = MINIMAL_STD_NATIVE_RUNNER_TARGETS.find(
    ({ id }) => id === target?.id,
  )
  if (!plainObject(target) || !exactShape(target, TARGET_FIELDS)
    || expected === undefined || !canonicalEqual(target, expected)) {
    fail('minimal-std-native-runner-target-invalid')
  }
}

function validateRequest(request) {
  if (!plainObject(request) || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== MINIMAL_STD_NATIVE_REQUEST_SCHEMA
    || request.profile !== MINIMAL_STD_NATIVE_RUNNER_PROFILE
    || !DIGEST.test(request.bundle_digest)
    || !CHALLENGE.test(request.challenge)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.request_digest)) {
    fail('minimal-std-native-runner-request-invalid')
  }
  validateTarget(request.target)
}

function validateReceipt(receipt) {
  if (!plainObject(receipt) || !exactShape(receipt, RECEIPT_FIELDS)
    || receipt.schema !== MINIMAL_STD_NATIVE_RECEIPT_SCHEMA
    || receipt.profile !== MINIMAL_STD_NATIVE_RUNNER_PROFILE
    || receipt.status !== 'measured'
    || !DIGEST.test(receipt.bundle_digest)
    || !DIGEST.test(receipt.challenge_digest)
    || !DIGEST.test(receipt.package_digest)
    || !DIGEST.test(receipt.receipt_digest)
    || !DIGEST.test(receipt.report_digest)
    || !DIGEST.test(receipt.request_digest)
    || !Array.isArray(receipt.workloads)) {
    fail('minimal-std-native-runner-receipt-invalid')
  }
  validateTarget(receipt.target)
  if (!plainObject(receipt.provenance)
    || receipt.provenance.compiler_path !== receipt.target.compiler_path
    || receipt.provenance.target_triple !== receipt.target.target_triple
    || receipt.provenance.operating_system !== receipt.target.platform
    || receipt.provenance.architecture !== receipt.target.architecture
    || receipt.provenance.synthetic !== false) {
    fail('minimal-std-native-runner-provenance-invalid')
  }
}

function validateMatrix(matrix) {
  if (!plainObject(matrix) || !exactShape(matrix, MATRIX_FIELDS)
    || matrix.schema !== MINIMAL_STD_NATIVE_MATRIX_SCHEMA
    || matrix.profile !== MINIMAL_STD_NATIVE_RUNNER_PROFILE
    || matrix.status !== 'minimal-std-native-runner-conformance-pending'
    || !DIGEST.test(matrix.bundle_digest)
    || !DIGEST.test(matrix.matrix_digest)
    || !DIGEST.test(matrix.package_digest)) {
    fail('minimal-std-native-runner-matrix-invalid')
  }
  matrix.targets.forEach(validateTarget)
}

function validateEvidence(evidence) {
  if (!plainObject(evidence) || !exactShape(evidence, EVIDENCE_FIELDS)
    || evidence.schema !== MINIMAL_STD_NATIVE_EVIDENCE_SCHEMA
    || !DIGEST.test(evidence.bundle_digest)
    || !DIGEST.test(evidence.evidence_digest)
    || !DIGEST.test(evidence.matrix_digest)
    || !Array.isArray(evidence.claims)
    || !sortedUniqueText(evidence.measured_targets)
    || !sortedUniqueText(evidence.pending_targets)) {
    fail('minimal-std-native-runner-evidence-invalid')
  }
  for (const claim of evidence.claims) {
    if (!plainObject(claim) || !exactShape(claim, CLAIM_FIELDS)) {
      fail('minimal-std-native-runner-evidence-claim-invalid')
    }
  }
}

function compareClaims(left, right) {
  return left.target_id.localeCompare(right.target_id)
}

function sortedUniqueText(values) {
  return Array.isArray(values)
    && values.every((value, index) => (
      typeof value === 'string'
      && value.length > 0
      && (index === 0 || values[index - 1] < value)
    ))
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestValue(value) {
  return `sha256:${createHash('sha256')
    .update(Buffer.from(canonicalJson(value), 'utf8')).digest('hex')}`
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
