import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import {
  arch,
  platform,
  release,
} from 'node:os'

import {
  PORTABLE_RUNTIME_PACKAGE_SCHEMA,
  portableRuntimePackageDigest,
  portableRuntimePackageManifestDigest,
  portableRuntimePackageTreeDigest,
} from './portable-runtime-package.js'
import {
  runStandalonePortableVmConformance,
  standalonePortableVmReportDigest,
} from './standalone-portable-vm.js'
import {
  runStandaloneMinimalStdConformance,
  standaloneMinimalStdReportDigest,
} from './standalone-minimal-std.js'
import {
  runStandaloneFaultHostConformance,
  standaloneFaultHostReportDigest,
} from './standalone-fault-host-boundary.js'
import {
  runStandaloneTaskLifecycleConformance,
  standaloneTaskLifecycleReportDigest,
} from './standalone-task-lifecycle-core.js'

export const STANDALONE_CROSS_PLATFORM_PROFILE =
  're.standalone-cross-platform-runner@0.1.0'
export const STANDALONE_CROSS_PLATFORM_REQUEST_SCHEMA =
  're.standalone-cross-platform-request@0.1.0'
export const STANDALONE_CROSS_PLATFORM_RECEIPT_SCHEMA =
  're.standalone-cross-platform-receipt@0.1.0'
export const STANDALONE_CROSS_PLATFORM_MATRIX_SCHEMA =
  're.standalone-cross-platform-matrix@0.1.0'
export const STANDALONE_CROSS_PLATFORM_EVIDENCE_SCHEMA =
  're.standalone-cross-platform-evidence@0.1.0'
export const STANDALONE_CROSS_PLATFORM_CI_CLAIM_SCHEMA =
  're.standalone-cross-platform-ci-claim@0.1.0'

export const STANDALONE_CROSS_PLATFORM_TARGETS = Object.freeze([
  Object.freeze({
    architecture: 'x64',
    id: 'linux-x64-standalone-c11',
    node_major: 24,
    platform: 'linux',
    runtime: 'native-c11',
    target_triple: 'x86_64-unknown-linux-gnu',
  }),
  Object.freeze({
    architecture: 'x64',
    id: 'windows-x64-standalone-c11',
    node_major: 24,
    platform: 'win32',
    runtime: 'native-c11',
    target_triple: 'x86_64-pc-windows-msvc',
  }),
])

const SUITES = Object.freeze({
  fault_host: Object.freeze({
    package_path: 'runtime/standalone_fault_host.c',
    report_digest: standaloneFaultHostReportDigest,
    schema: 're.standalone-fault-host-report@0.1.0',
  }),
  minimal_std: Object.freeze({
    package_path: 'runtime/standalone_minimal_std.c',
    report_digest: standaloneMinimalStdReportDigest,
    schema: 're.standalone-minimal-std-report@0.1.0',
  }),
  portable_vm: Object.freeze({
    package_path: 'runtime/standalone_portable_vm.c',
    report_digest: standalonePortableVmReportDigest,
    schema: 're.standalone-portable-vm-report@0.1.0',
  }),
  task_lifecycle: Object.freeze({
    package_path: 'runtime/standalone_task_lifecycle.c',
    report_digest: standaloneTaskLifecycleReportDigest,
    schema: 're.standalone-task-lifecycle-report@0.1.0',
  }),
})
const SUITE_NAMES = Object.freeze(Object.keys(SUITES))
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CHALLENGE = /^[0-9a-f]{64}$/u
const COMMIT = /^[0-9a-f]{40}$/u
const NODE_VERSION = /^v([0-9]+)\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u
const TARGET_FIELDS = [
  'architecture',
  'id',
  'node_major',
  'platform',
  'runtime',
  'target_triple',
]
const AUTHORITY_FIELDS = [
  'report_digest',
  'schema',
  'source_digest',
  'workload_count',
]
const REQUEST_FIELDS = [
  'authorities',
  'challenge',
  'package_digest',
  'package_manifest_digest',
  'profile',
  'release_lock_digest',
  'request_digest',
  'schema',
  'target',
  'toolchain_digest',
]
const PROVENANCE_FIELDS = [
  'architecture',
  'compiler_digest',
  'compiler_path',
  'compiler_version_digest',
  'host_identity_digest',
  'node_version',
  'operating_system',
  'target_triple',
]
const RECEIPT_FIELDS = [
  'challenge_digest',
  'package_digest',
  'profile',
  'provenance',
  'receipt_digest',
  'reports',
  'request_digest',
  'schema',
  'status',
  'target',
]
const MATRIX_FIELDS = [
  'authorities',
  'matrix_digest',
  'package_digest',
  'profile',
  'release_lock_digest',
  'schema',
  'status',
  'targets',
  'toolchain_digest',
]
const CLAIM_FIELDS = ['receipt', 'request', 'target_id']
const EVIDENCE_FIELDS = [
  'claims',
  'evidence_digest',
  'matrix_digest',
  'measured_targets',
  'pending_targets',
  'schema',
  'status',
]
const GITHUB_FIELDS = [
  'event_name',
  'job',
  'ref',
  'repository',
  'runner_arch',
  'runner_environment',
  'runner_os',
  'sha',
  'workflow_ref',
  'workflow_sha',
]
const CI_CLAIM_FIELDS = [
  'claim_digest',
  'github',
  'profile',
  'receipt',
  'request',
  'schema',
  'status',
  'workflow_digest',
]

export function createStandaloneCrossPlatformRequest({
  challenge,
  package: archive,
  release_lock_digest,
  reports,
  target,
  toolchain_digest,
} = {}) {
  try {
    const authority = packageAndReportAuthority(archive, reports)
    validateTarget(target)
    if (!CHALLENGE.test(challenge)
      || !DIGEST.test(release_lock_digest)
      || !DIGEST.test(toolchain_digest)) {
      fail('standalone-cross-platform-request-input-invalid')
    }
    const request = {
      authorities: authority.authorities,
      challenge,
      package_digest: archive.package_digest,
      package_manifest_digest: archive.manifest.manifest_digest,
      profile: STANDALONE_CROSS_PLATFORM_PROFILE,
      release_lock_digest,
      schema: STANDALONE_CROSS_PLATFORM_REQUEST_SCHEMA,
      target,
      toolchain_digest,
    }
    request.request_digest = standaloneCrossPlatformRequestDigest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-request-invalid')
  }
}

export function verifyStandaloneCrossPlatformRequest(request, {
  package: archive,
  reports,
} = {}) {
  try {
    const authority = packageAndReportAuthority(archive, reports)
    validateRequest(request)
    if (request.package_digest !== archive.package_digest
      || request.package_manifest_digest !== archive.manifest.manifest_digest
      || !canonicalEqual(request.authorities, authority.authorities)) {
      fail('standalone-cross-platform-request-authority-mismatch')
    }
    if (request.request_digest !== standaloneCrossPlatformRequestDigest(
      request,
    )) {
      fail('standalone-cross-platform-request-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-request-invalid')
  }
}

export function createStandaloneCrossPlatformReceipt({
  provenance,
  reports,
  request,
} = {}) {
  try {
    validateRequest(request)
    validateProvenance(provenance, request.target)
    validateReportSet(reports)
    validateMeasuredReports(reports, provenance, request.target)
    const receipt = {
      challenge_digest: digestValue(request.challenge),
      package_digest: request.package_digest,
      profile: STANDALONE_CROSS_PLATFORM_PROFILE,
      provenance,
      reports,
      request_digest: request.request_digest,
      schema: STANDALONE_CROSS_PLATFORM_RECEIPT_SCHEMA,
      status: 'measured',
      target: request.target,
    }
    receipt.receipt_digest = standaloneCrossPlatformReceiptDigest(receipt)
    return { ok: true, value: receipt }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-receipt-invalid')
  }
}

export async function runStandaloneCrossPlatformRequest({
  compiler_path,
  fault,
  lifecycle,
  minimal_std,
  package: archive,
  portable_vm,
  reports,
  request,
} = {}) {
  try {
    const verified = verifyStandaloneCrossPlatformRequest(request, {
      package: archive,
      reports,
    })
    if (!verified.ok) return verified
    if (request.target.platform !== platform()
      || request.target.architecture !== arch()
      || !validCompilerPath(compiler_path, request.target.platform)) {
      fail('standalone-cross-platform-environment-mismatch')
    }
    const provenance = await probeCompiler({
      compiler_path,
      target: request.target,
    })
    const common = {
      compiler_path,
      package_digest: archive.package_digest,
      target_triple: request.target.target_triple,
    }
    const generated = {}
    generated.portable_vm = await runStandalonePortableVmConformance({
      ...portable_vm,
      compiler_path,
      release_lock_digest: request.release_lock_digest,
      target_triple: request.target.target_triple,
      toolchain_digest: request.toolchain_digest,
    })
    generated.minimal_std = await runStandaloneMinimalStdConformance({
      ...minimal_std,
      ...common,
    })
    generated.fault_host = await runStandaloneFaultHostConformance({
      ...fault,
      ...common,
      release_lock_digest: request.release_lock_digest,
      toolchain_digest: request.toolchain_digest,
    })
    generated.task_lifecycle = await runStandaloneTaskLifecycleConformance({
      ...lifecycle,
      ...common,
      release_lock_digest: request.release_lock_digest,
      toolchain_digest: request.toolchain_digest,
    })
    for (const suite of SUITE_NAMES) {
      if (!generated[suite]?.ok) {
        return generated[suite] ?? rejected(
          'standalone-cross-platform-suite-failed',
        )
      }
      generated[suite] = generated[suite].value
    }
    return createStandaloneCrossPlatformReceipt({
      provenance,
      reports: generated,
      request,
    })
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-runner-failed')
  }
}

export async function verifyStandaloneCrossPlatformReceipt(receipt, {
  package: archive,
  reports,
  request,
} = {}) {
  try {
    const verified = verifyStandaloneCrossPlatformRequest(request, {
      package: archive,
      reports,
    })
    if (!verified.ok) return verified
    validateReceipt(receipt)
    if (receipt.request_digest !== request.request_digest
      || receipt.package_digest !== request.package_digest
      || receipt.challenge_digest !== digestValue(request.challenge)) {
      fail('standalone-cross-platform-receipt-request-mismatch')
    }
    if (!canonicalEqual(receipt.target, request.target)) {
      fail('standalone-cross-platform-receipt-target-mismatch')
    }
    validateProvenance(receipt.provenance, request.target)
    validateMeasuredReports(
      receipt.reports,
      receipt.provenance,
      request.target,
    )
    for (const suite of SUITE_NAMES) {
      if (!canonicalEqual(
        semanticReport(receipt.reports[suite]),
        semanticReport(reports[suite]),
      )) {
        fail('standalone-cross-platform-receipt-semantic-mismatch')
      }
    }
    if (receipt.receipt_digest
      !== standaloneCrossPlatformReceiptDigest(receipt)) {
      fail('standalone-cross-platform-receipt-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-receipt-invalid')
  }
}

export function createStandaloneCrossPlatformMatrix({
  package: archive,
  release_lock_digest,
  reports,
  toolchain_digest,
} = {}) {
  try {
    const authority = packageAndReportAuthority(archive, reports)
    if (!DIGEST.test(release_lock_digest) || !DIGEST.test(toolchain_digest)) {
      fail('standalone-cross-platform-matrix-input-invalid')
    }
    const matrix = {
      authorities: authority.authorities,
      package_digest: archive.package_digest,
      profile: STANDALONE_CROSS_PLATFORM_PROFILE,
      release_lock_digest,
      schema: STANDALONE_CROSS_PLATFORM_MATRIX_SCHEMA,
      status: 'standalone-cross-platform-pending',
      targets: STANDALONE_CROSS_PLATFORM_TARGETS,
      toolchain_digest,
    }
    matrix.matrix_digest = standaloneCrossPlatformMatrixDigest(matrix)
    return { ok: true, value: matrix }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-matrix-invalid')
  }
}

export async function createStandaloneCrossPlatformEvidence({
  claims,
  matrix,
  package: archive,
  reports,
} = {}) {
  try {
    verifyMatrix(matrix, { package: archive, reports })
    if (!Array.isArray(claims)) {
      fail('standalone-cross-platform-evidence-claims-invalid')
    }
    const normalized = claims.map(({ receipt, request }) => ({
      receipt,
      request,
      target_id: request?.target?.id,
    })).sort((left, right) => left.target_id.localeCompare(right.target_id))
    const measured = normalized.map(({ target_id }) => target_id)
    const pending = matrix.targets.map(({ id }) => id)
      .filter((id) => !measured.includes(id))
    const evidence = {
      claims: normalized,
      matrix_digest: matrix.matrix_digest,
      measured_targets: measured,
      pending_targets: pending,
      schema: STANDALONE_CROSS_PLATFORM_EVIDENCE_SCHEMA,
      status: pending.length === 0 ? 'complete' : 'partial',
    }
    evidence.evidence_digest = standaloneCrossPlatformEvidenceDigest(evidence)
    const verified = await verifyStandaloneCrossPlatformEvidence(evidence, {
      matrix,
      package: archive,
      reports,
    })
    return verified.ok ? { ok: true, value: evidence } : verified
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-evidence-invalid')
  }
}

export async function verifyStandaloneCrossPlatformEvidence(evidence, {
  matrix,
  package: archive,
  reports,
} = {}) {
  try {
    verifyMatrix(matrix, { package: archive, reports })
    if (!plainObject(evidence)
      || !exactShape(evidence, EVIDENCE_FIELDS)
      || evidence.schema !== STANDALONE_CROSS_PLATFORM_EVIDENCE_SCHEMA
      || evidence.matrix_digest !== matrix.matrix_digest
      || !Array.isArray(evidence.claims)
      || !sortedUniqueText(evidence.measured_targets)
      || !sortedUniqueText(evidence.pending_targets)) {
      fail('standalone-cross-platform-evidence-invalid')
    }
    const targetIds = matrix.targets.map(({ id }) => id)
    const claimIds = []
    for (const claim of evidence.claims) {
      if (!plainObject(claim)
        || !exactShape(claim, CLAIM_FIELDS)
        || claim.target_id !== claim.request?.target?.id
        || claim.target_id !== claim.receipt?.target?.id) {
        fail('standalone-cross-platform-evidence-claim-mismatch')
      }
      claimIds.push(claim.target_id)
      const verified = await verifyStandaloneCrossPlatformReceipt(
        claim.receipt,
        {
          package: archive,
          reports,
          request: claim.request,
        },
      )
      if (!verified.ok) return verified
    }
    const pending = targetIds.filter((id) => !claimIds.includes(id))
    if (!canonicalEqual(claimIds, evidence.measured_targets)
      || !canonicalEqual(pending, evidence.pending_targets)
      || !sameSet([...claimIds, ...pending], targetIds)
      || evidence.status !== (pending.length === 0 ? 'complete' : 'partial')) {
      fail('standalone-cross-platform-evidence-partition-mismatch')
    }
    if (evidence.evidence_digest
      !== standaloneCrossPlatformEvidenceDigest(evidence)) {
      fail('standalone-cross-platform-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-evidence-invalid')
  }
}

export function createStandaloneCrossPlatformCiClaim({
  github,
  receipt,
  request,
  workflow_source,
} = {}) {
  try {
    validateGithub(github)
    validateWorkflowSource(workflow_source)
    validateReceipt(receipt)
    validateRequest(request)
    if (!canonicalEqual(receipt.target, request.target)
      || receipt.request_digest !== request.request_digest) {
      fail('standalone-cross-platform-ci-claim-invalid')
    }
    const claim = {
      github,
      profile: STANDALONE_CROSS_PLATFORM_PROFILE,
      receipt,
      request,
      schema: STANDALONE_CROSS_PLATFORM_CI_CLAIM_SCHEMA,
      status: 'measured',
      workflow_digest: digestBytes(Buffer.from(workflow_source, 'utf8')),
    }
    claim.claim_digest = standaloneCrossPlatformCiClaimDigest(claim)
    return { ok: true, value: claim }
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-ci-claim-invalid')
  }
}

export async function verifyStandaloneCrossPlatformCiClaim(claim, {
  challenge,
  commit,
  package: archive,
  ref,
  reports,
  repository,
  workflow_path,
  workflow_source,
} = {}) {
  try {
    validateCiClaim(claim)
    validateWorkflowSource(workflow_source)
    if (!CHALLENGE.test(challenge)
      || !COMMIT.test(commit)
      || !validText(ref)
      || !validText(repository)
      || !validWorkflowPath(workflow_path)) {
      fail('standalone-cross-platform-ci-authority-invalid')
    }
    const target = claim.request.target
    const expectedRunnerOs = target.platform === 'linux' ? 'Linux' : 'Windows'
    if (claim.request.challenge !== challenge
      || claim.github.event_name !== 'workflow_dispatch'
      || claim.github.repository !== repository
      || claim.github.ref !== ref
      || claim.github.sha !== commit
      || claim.github.workflow_sha !== commit
      || claim.github.workflow_ref !== `${repository}/${workflow_path}@${ref}`
      || claim.github.job !== 'measure'
      || claim.github.runner_os !== expectedRunnerOs
      || claim.github.runner_arch !== 'X64'
      || claim.github.runner_environment !== 'github-hosted'
      || claim.workflow_digest !== digestBytes(
        Buffer.from(workflow_source, 'utf8'),
      )
      || claim.claim_digest !== standaloneCrossPlatformCiClaimDigest(claim)) {
      fail('standalone-cross-platform-ci-authority-mismatch')
    }
    return verifyStandaloneCrossPlatformReceipt(claim.receipt, {
      package: archive,
      reports,
      request: claim.request,
    })
  } catch (error) {
    return rejected(error?.code ?? 'standalone-cross-platform-ci-claim-invalid')
  }
}

export function standaloneCrossPlatformRequestDigest(request) {
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function standaloneCrossPlatformReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function standaloneCrossPlatformMatrixDigest(matrix) {
  const { matrix_digest: ignored, ...content } = matrix
  return digestValue(content)
}

export function standaloneCrossPlatformEvidenceDigest(evidence) {
  const { evidence_digest: ignored, ...content } = evidence
  return digestValue(content)
}

export function standaloneCrossPlatformCiClaimDigest(claim) {
  const { claim_digest: ignored, ...content } = claim
  return digestValue(content)
}

function packageAndReportAuthority(archive, reports) {
  validatePackage(archive)
  validateReportSet(reports)
  const entries = new Map(archive.entries.map((entry) => [
    entry.path,
    Buffer.from(entry.content_base64, 'base64'),
  ]))
  const authorities = {}
  for (const suite of SUITE_NAMES) {
    const definition = SUITES[suite]
    const report = reports[suite]
    const source = entries.get(definition.package_path)
    if (source === undefined
      || report.schema !== definition.schema
      || report.report_digest !== definition.report_digest(report)
      || report.source_digest !== digestBytes(source)) {
      fail('standalone-cross-platform-report-authority-mismatch')
    }
    authorities[suite] = {
      report_digest: report.report_digest,
      schema: report.schema,
      source_digest: report.source_digest,
      workload_count: report.workloads.length,
    }
  }
  return { authorities }
}

function validatePackage(archive) {
  if (!plainObject(archive)
    || archive.schema !== PORTABLE_RUNTIME_PACKAGE_SCHEMA
    || archive.package_digest !== portableRuntimePackageDigest(archive)
    || !plainObject(archive.manifest)
    || archive.manifest.manifest_digest
      !== portableRuntimePackageManifestDigest(archive.manifest)
    || archive.manifest.tree_digest
      !== portableRuntimePackageTreeDigest(archive.manifest.entries)
    || !Array.isArray(archive.entries)
    || archive.entries.length !== archive.manifest.entries.length) {
    fail('standalone-cross-platform-package-invalid')
  }
}

function validateReportSet(reports) {
  if (!plainObject(reports)
    || !canonicalEqual(Object.keys(reports).sort(), SUITE_NAMES)
    || !SUITE_NAMES.every((suite) => (
      plainObject(reports[suite])
      && reports[suite].schema === SUITES[suite].schema
      && Array.isArray(reports[suite].workloads)
      && DIGEST.test(reports[suite].report_digest)
      && DIGEST.test(reports[suite].source_digest)
      && reports[suite].report_digest
        === SUITES[suite].report_digest(reports[suite])
    ))) {
    fail('standalone-cross-platform-report-set-invalid')
  }
}

function validateMeasuredReports(reports, provenance, target) {
  validateReportSet(reports)
  for (const suite of SUITE_NAMES) {
    const report = reports[suite]
    if (report.status !== 'measured'
      || report.target_triple !== target.target_triple
      || report.provenance?.architecture !== target.architecture
      || report.provenance?.operating_system !== target.platform
      || report.provenance?.target_triple !== target.target_triple
      || report.provenance?.compiler_digest !== provenance.compiler_digest
      || report.provenance?.compiler_version_digest
        !== provenance.compiler_version_digest
      || report.provenance?.compiler_path !== provenance.compiler_path
      || !DIGEST.test(report.executable_digest)
      || report.workloads.length === 0
      || !report.workloads.every(({ executable_digest }) => (
        executable_digest === report.executable_digest
      ))) {
      fail('standalone-cross-platform-receipt-report-invalid')
    }
  }
}

function semanticReport(report) {
  const {
    executable_digest: ignoredExecutable,
    provenance: ignoredProvenance,
    report_digest: ignoredReport,
    target_triple: ignoredTarget,
    ...stable
  } = report
  return {
    ...stable,
    workloads: stable.workloads.map((workload) => {
      const {
        executable_digest: ignoredWorkloadExecutable,
        workload_digest: ignoredWorkloadDigest,
        ...semantic
      } = workload
      return semantic
    }),
  }
}

function verifyMatrix(matrix, { package: archive, reports }) {
  const authority = packageAndReportAuthority(archive, reports)
  if (!plainObject(matrix)
    || !exactShape(matrix, MATRIX_FIELDS)
    || matrix.schema !== STANDALONE_CROSS_PLATFORM_MATRIX_SCHEMA
    || matrix.profile !== STANDALONE_CROSS_PLATFORM_PROFILE
    || matrix.status !== 'standalone-cross-platform-pending'
    || matrix.package_digest !== archive.package_digest
    || !canonicalEqual(matrix.authorities, authority.authorities)
    || !canonicalEqual(matrix.targets, STANDALONE_CROSS_PLATFORM_TARGETS)
    || matrix.matrix_digest !== standaloneCrossPlatformMatrixDigest(matrix)) {
    fail('standalone-cross-platform-matrix-invalid')
  }
}

function validateRequest(request) {
  if (!plainObject(request)
    || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== STANDALONE_CROSS_PLATFORM_REQUEST_SCHEMA
    || request.profile !== STANDALONE_CROSS_PLATFORM_PROFILE
    || !CHALLENGE.test(request.challenge)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.package_manifest_digest)
    || !DIGEST.test(request.release_lock_digest)
    || !DIGEST.test(request.request_digest)
    || !DIGEST.test(request.toolchain_digest)
    || !plainObject(request.authorities)
    || !canonicalEqual(Object.keys(request.authorities).sort(), SUITE_NAMES)) {
    fail('standalone-cross-platform-request-invalid')
  }
  for (const suite of SUITE_NAMES) {
    const authority = request.authorities[suite]
    if (!plainObject(authority)
      || !exactShape(authority, AUTHORITY_FIELDS)
      || !DIGEST.test(authority.report_digest)
      || !DIGEST.test(authority.source_digest)
      || authority.schema !== SUITES[suite].schema
      || !Number.isSafeInteger(authority.workload_count)
      || authority.workload_count < 1) {
      fail('standalone-cross-platform-request-invalid')
    }
  }
  validateTarget(request.target)
}

function validateReceipt(receipt) {
  if (!plainObject(receipt)
    || !exactShape(receipt, RECEIPT_FIELDS)
    || receipt.schema !== STANDALONE_CROSS_PLATFORM_RECEIPT_SCHEMA
    || receipt.profile !== STANDALONE_CROSS_PLATFORM_PROFILE
    || receipt.status !== 'measured'
    || !DIGEST.test(receipt.challenge_digest)
    || !DIGEST.test(receipt.package_digest)
    || !DIGEST.test(receipt.receipt_digest)
    || !DIGEST.test(receipt.request_digest)) {
    fail('standalone-cross-platform-receipt-invalid')
  }
  validateTarget(receipt.target)
  validateProvenance(receipt.provenance, receipt.target)
  validateReportSet(receipt.reports)
}

function validateTarget(target) {
  const expected = STANDALONE_CROSS_PLATFORM_TARGETS.find(
    ({ id }) => id === target?.id,
  )
  if (!plainObject(target)
    || !exactShape(target, TARGET_FIELDS)
    || expected === undefined
    || !canonicalEqual(target, expected)) {
    fail('standalone-cross-platform-target-invalid')
  }
}

function validateProvenance(provenance, target) {
  const version = typeof provenance?.node_version === 'string'
    ? NODE_VERSION.exec(provenance.node_version)
    : null
  if (!plainObject(provenance)
    || !exactShape(provenance, PROVENANCE_FIELDS)
    || provenance.architecture !== target.architecture
    || provenance.operating_system !== target.platform
    || provenance.target_triple !== target.target_triple
    || !DIGEST.test(provenance.compiler_digest)
    || !DIGEST.test(provenance.compiler_version_digest)
    || !DIGEST.test(provenance.host_identity_digest)
    || !validCompilerPath(provenance.compiler_path, target.platform)
    || version === null
    || Number(version[1]) !== target.node_major) {
    fail('standalone-cross-platform-provenance-invalid')
  }
}

function validateGithub(github) {
  if (!plainObject(github)
    || !exactShape(github, GITHUB_FIELDS)
    || github.event_name !== 'workflow_dispatch'
    || github.job !== 'measure'
    || !validText(github.ref)
    || !validText(github.repository)
    || github.runner_arch !== 'X64'
    || github.runner_environment !== 'github-hosted'
    || !['Linux', 'Windows'].includes(github.runner_os)
    || !COMMIT.test(github.sha)
    || !validText(github.workflow_ref)
    || !COMMIT.test(github.workflow_sha)) {
    fail('standalone-cross-platform-ci-github-invalid')
  }
}

function validateCiClaim(claim) {
  if (!plainObject(claim)
    || !exactShape(claim, CI_CLAIM_FIELDS)
    || claim.schema !== STANDALONE_CROSS_PLATFORM_CI_CLAIM_SCHEMA
    || claim.profile !== STANDALONE_CROSS_PLATFORM_PROFILE
    || claim.status !== 'measured'
    || !DIGEST.test(claim.workflow_digest)
    || !DIGEST.test(claim.claim_digest)) {
    fail('standalone-cross-platform-ci-claim-invalid')
  }
  validateGithub(claim.github)
  validateRequest(claim.request)
  validateReceipt(claim.receipt)
}

function validateWorkflowSource(source) {
  if (typeof source !== 'string'
    || source.length === 0
    || Buffer.byteLength(source, 'utf8') > 65_535) {
    fail('standalone-cross-platform-ci-workflow-invalid')
  }
}

async function probeCompiler({ compiler_path, target }) {
  const metadata = await stat(compiler_path)
  if (!metadata.isFile()) fail('standalone-cross-platform-compiler-invalid')
  const compilerBytes = await readFile(compiler_path)
  const version = spawnSync(
    compiler_path,
    ['--version'],
    { encoding: 'utf8', shell: false },
  )
  if (version.error || version.status !== 0 || version.stdout.length === 0) {
    fail('standalone-cross-platform-compiler-version-failed')
  }
  const identity = {
    architecture: arch(),
    compiler_digest: digestBytes(compilerBytes),
    compiler_path,
    compiler_version_digest: digestBytes(
      Buffer.from(version.stdout, 'utf8'),
    ),
    node_version: process.version,
    operating_system: platform(),
    target_triple: target.target_triple,
  }
  return {
    ...identity,
    host_identity_digest: digestValue({
      ...identity,
      operating_system_release: release(),
    }),
  }
}

function validCompilerPath(value, targetPlatform) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (targetPlatform === 'win32') {
    return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value)
  }
  return value.startsWith('/')
}

function validWorkflowPath(value) {
  return typeof value === 'string'
    && value.startsWith('.github/workflows/')
    && value.endsWith('.yml')
    && !value.includes('..')
}

function validText(value) {
  return typeof value === 'string' && value.length > 0
}

function sortedUniqueText(values) {
  return Array.isArray(values)
    && values.every((value, index) => (
      typeof value === 'string'
      && value.length > 0
      && (index === 0 || values[index - 1] < value)
    ))
}

function sameSet(actual, expected) {
  return canonicalEqual([...actual].sort(), [...expected].sort())
}

function exactShape(value, expected) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), expected)
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestValue(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
