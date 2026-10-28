import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  arch,
  platform,
  release,
  tmpdir,
} from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  PORTABLE_RUNTIME_PACKAGE_SCHEMA,
  portableRuntimePackageDigest,
  portableRuntimePackageManifestDigest,
  portableRuntimePackageTreeDigest,
} from './portable-runtime-package.js'

export const EXTERNAL_RUNNER_MATRIX_SCHEMA =
  're.external-runner-matrix@0.1.0'
export const EXTERNAL_RUNNER_MATRIX_EVIDENCE_SCHEMA =
  're.external-runner-matrix-evidence@0.1.0'
export const EXTERNAL_RUNNER_REQUEST_SCHEMA =
  're.external-runner-request@0.1.0'
export const EXTERNAL_RUNNER_RECEIPT_SCHEMA =
  're.external-runner-receipt@0.1.0'
export const EXTERNAL_RUNNER_PROFILE =
  're.external-runner@0.1.0'

export const EXTERNAL_RUNNER_TARGETS = Object.freeze([
  Object.freeze({
    architecture: 'arm64',
    backend: 'cranelift',
    id: 'darwin-arm64-cranelift',
    node_major: 24,
    platform: 'darwin',
    runtime: 'native-cranelift',
    suites: Object.freeze(['portable-four-opcode']),
    target_triple: 'arm64-apple-darwin',
  }),
  Object.freeze({
    architecture: 'arm64',
    backend: 'aot-llvm',
    id: 'darwin-arm64-native-c11',
    node_major: 24,
    platform: 'darwin',
    runtime: 'native-c11',
    suites: Object.freeze([
      'native-lifecycle',
      'portable-four-opcode',
    ]),
    target_triple: 'arm64-apple-darwin',
  }),
  Object.freeze({
    architecture: 'arm64',
    backend: 'wasm',
    id: 'darwin-arm64-wasm-node-24',
    node_major: 24,
    platform: 'darwin',
    runtime: 'node-webassembly',
    suites: Object.freeze(['portable-four-opcode']),
    target_triple: 'wasm32-wasi',
  }),
  Object.freeze({
    architecture: 'x64',
    backend: 'aot-llvm',
    id: 'linux-x64-native-c11',
    node_major: 24,
    platform: 'linux',
    runtime: 'native-c11',
    suites: Object.freeze([
      'native-lifecycle',
      'portable-four-opcode',
    ]),
    target_triple: 'x86_64-unknown-linux-gnu',
  }),
])

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CHALLENGE = /^[0-9a-f]{64}$/u
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u
const NODE_VERSION = /^v([0-9]+)\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u
const TARGET_FIELDS = [
  'architecture',
  'backend',
  'id',
  'node_major',
  'platform',
  'runtime',
  'suites',
  'target_triple',
]
const PROBE_FIELDS = [
  'architecture',
  'compiler_digest',
  'compiler_path',
  'compiler_version_digest',
  'environment_id',
  'host_identity_digest',
  'measurement_source',
  'node_version',
  'operating_system',
  'runner_id',
  'synthetic',
  'target_id',
  'target_triple',
]
const REQUEST_AUTHORITY_FIELDS = [
  'native_reference_report_digest',
  'portable_conformance_digest',
]
const REQUEST_FIELDS = [
  'authorities',
  'challenge',
  'package_digest',
  'package_manifest_digest',
  'profile',
  'release_lock_digest',
  'request_digest',
  'runner',
  'schema',
  'target',
  'toolchain_digest',
]
const WORKLOAD_FIELDS = [
  'build',
  'executable_digest',
  'execution',
  'id',
  'request_digest',
  'run',
  'source_digest',
  'stdout_digest',
  'suite',
  'workload_digest',
]
const METRIC_FIELDS = ['samples_ns']
const RECEIPT_FIELDS = [
  'challenge_digest',
  'evidence_digest',
  'package_digest',
  'profile',
  'provenance',
  'request_digest',
  'schema',
  'stable_digest',
  'status',
  'target',
  'workloads',
]
const MATRIX_AUTHORITY_FIELDS = [
  'native_reference_report_digest',
  'package_manifest_digest',
  'portable_conformance_digest',
]
const MATRIX_FIELDS = [
  'authorities',
  'matrix_digest',
  'package_digest',
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

export async function probeExternalRunner({
  compiler_path,
  target,
} = {}) {
  try {
    validateTarget(target)
    if (target.runtime !== 'native-c11') {
      fail('external-runner-target-unsupported')
    }
    if (target.platform !== platform() || target.architecture !== arch()) {
      fail('external-runner-environment-mismatch')
    }
    if (!isAbsolute(compiler_path)) {
      fail('external-runner-compiler-path-invalid')
    }
    const compilerMetadata = await stat(compiler_path)
    if (!compilerMetadata.isFile()) fail('external-runner-compiler-invalid')
    const compilerBytes = await readFile(compiler_path)
    const compilerVersion = spawnSync(
      compiler_path,
      ['--version'],
      { encoding: 'utf8', shell: false },
    )
    if (compilerVersion.error || compilerVersion.status !== 0
      || compilerVersion.stdout.length === 0) {
      fail('external-runner-compiler-version-failed')
    }
    const compilerDigest = digestBytes(compilerBytes)
    const compilerVersionDigest = digestBytes(
      Buffer.from(compilerVersion.stdout, 'utf8'),
    )
    const nodeVersion = process.version
    if (!validNodeVersion(nodeVersion, target.node_major)) {
      fail('external-runner-node-version-mismatch')
    }
    const identity = {
      architecture: arch(),
      compiler_digest: compilerDigest,
      compiler_path,
      compiler_version_digest: compilerVersionDigest,
      environment_id: target.id,
      node_version: nodeVersion,
      operating_system: platform(),
      target_id: target.id,
      target_triple: target.target_triple,
    }
    return {
      ok: true,
      value: {
        ...identity,
        host_identity_digest: digestValue({
          ...identity,
          operating_system_release: release(),
        }),
        measurement_source: 'runner',
        runner_id: EXTERNAL_RUNNER_PROFILE,
        synthetic: false,
      },
    }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-probe-failed')
  }
}

export function createExternalRunnerRequest({
  challenge,
  package: archive,
  release_lock_digest,
  runner,
  target,
  toolchain_digest,
} = {}) {
  try {
    const authority = packageAuthority(archive)
    validateTarget(target)
    validateProbe(runner)
    if (!CHALLENGE.test(challenge)
      || !DIGEST.test(release_lock_digest)
      || !DIGEST.test(toolchain_digest)
      || !canonicalEqual(runnerTarget(runner), target)) {
      fail('external-runner-request-input-invalid')
    }
    const request = {
      authorities: authority.authorities,
      challenge,
      package_digest: archive.package_digest,
      package_manifest_digest: archive.manifest.manifest_digest,
      profile: EXTERNAL_RUNNER_PROFILE,
      release_lock_digest,
      runner,
      schema: EXTERNAL_RUNNER_REQUEST_SCHEMA,
      target,
      toolchain_digest,
    }
    request.request_digest = externalRunnerRequestDigest(request)
    return { ok: true, value: request }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-request-invalid')
  }
}

export function verifyExternalRunnerRequest(request, {
  package: archive,
} = {}) {
  try {
    const authority = packageAuthority(archive)
    validateRequest(request)
    if (request.package_digest !== archive.package_digest
      || request.package_manifest_digest !== archive.manifest.manifest_digest
      || !canonicalEqual(request.authorities, authority.authorities)) {
      fail('external-runner-request-authority-mismatch')
    }
    if (request.request_digest !== externalRunnerRequestDigest(request)) {
      fail('external-runner-request-digest-mismatch')
    }
    if (!canonicalEqual(runnerTarget(request.runner), request.target)) {
      fail('external-runner-request-runner-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-request-invalid')
  }
}

export async function runExternalRunnerRequest({
  compiler_path,
  package: archive,
  request,
  samples = 2,
} = {}) {
  let root = null
  try {
    const verified = verifyExternalRunnerRequest(request, { package: archive })
    if (!verified.ok) return verified
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 8) {
      fail('external-runner-sample-count-invalid')
    }
    if (request.target.runtime !== 'native-c11') {
      fail('external-runner-target-unsupported')
    }
    const probed = await probeExternalRunner({
      compiler_path,
      target: request.target,
    })
    if (!probed.ok) return probed
    if (!canonicalEqual(probed.value, request.runner)) {
      fail('external-runner-probe-drift')
    }

    const authority = packageAuthority(archive)
    root = await mkdtemp(join(tmpdir(), 're-external-runner-'))
    await materializePackage(authority.entries, root)
    const buildDirectory = join(root, '.build')
    await mkdir(buildDirectory)
    const workloads = []
    const suites = [
      {
        core: 'runtime/native_runtime_abi.c',
        index: authority.nativeIndex,
        name: 'native-lifecycle',
      },
      {
        core: 'runtime/portable_runtime.c',
        index: authority.portableIndex,
        name: 'portable-four-opcode',
      },
    ]
    for (const suite of suites) {
      for (const expected of suite.index.workloads) {
        const workload = await compileAndRun({
          compiler_path,
          expected,
          root,
          samples,
          suite,
          target: request.target,
        })
        workloads.push(workload)
      }
    }
    workloads.sort(compareWorkloads)
    const receipt = {
      challenge_digest: digestValue(request.challenge),
      package_digest: archive.package_digest,
      profile: EXTERNAL_RUNNER_PROFILE,
      provenance: probed.value,
      request_digest: request.request_digest,
      schema: EXTERNAL_RUNNER_RECEIPT_SCHEMA,
      status: 'measured',
      target: request.target,
      workloads,
    }
    receipt.stable_digest = externalRunnerReceiptStableDigest(receipt)
    receipt.evidence_digest = externalRunnerReceiptEvidenceDigest(receipt)
    return { ok: true, value: receipt }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-execution-failed')
  } finally {
    if (root !== null) await rm(root, { force: true, recursive: true })
  }
}

export async function verifyExternalRunnerReceipt(receipt, {
  package: archive,
  request,
  task_reference,
} = {}) {
  try {
    const verified = verifyExternalRunnerRequest(request, { package: archive })
    if (!verified.ok) return verified
    validateReceipt(receipt)
    if (receipt.request_digest !== request.request_digest
      || receipt.package_digest !== request.package_digest
      || receipt.challenge_digest !== digestValue(request.challenge)) {
      fail('external-runner-receipt-request-mismatch')
    }
    if (!canonicalEqual(receipt.target, request.target)) {
      fail('external-runner-receipt-target-mismatch')
    }
    if (!canonicalEqual(receipt.provenance, request.runner)) {
      fail('external-runner-receipt-runner-mismatch')
    }
    const authority = packageAuthority(archive)
    const expected = expectedWorkloads(authority)
    if (receipt.workloads.length !== expected.length
      || !canonicalEqual(
        receipt.workloads.map(workloadIdentity),
        expected.map(workloadIdentity),
      )) {
      fail('external-runner-receipt-workload-set-mismatch')
    }
    const nativeReference = taskReferenceMap(task_reference)
    for (let index = 0; index < expected.length; index += 1) {
      const actual = receipt.workloads[index]
      const source = expected[index]
      validateWorkload(actual)
      if (actual.request_digest !== source.request_digest
        || actual.source_digest !== source.source_digest) {
        fail('external-runner-receipt-workload-authority-mismatch')
      }
      const expectedExecution = source.suite === 'portable-four-opcode'
        ? source.expected_execution
        : nativeReference.get(source.id)
      if (expectedExecution === undefined
        || !canonicalEqual(actual.execution, expectedExecution)
        || actual.stdout_digest !== digestBytes(
          Buffer.from(`${JSON.stringify(expectedExecution)}\n`, 'utf8'),
        )) {
        fail('external-runner-receipt-semantic-mismatch')
      }
      if (actual.workload_digest !== externalRunnerWorkloadDigest(actual)) {
        fail('external-runner-receipt-workload-digest-mismatch')
      }
    }
    if (receipt.stable_digest !== externalRunnerReceiptStableDigest(receipt)) {
      fail('external-runner-receipt-stable-digest-mismatch')
    }
    if (receipt.evidence_digest
      !== externalRunnerReceiptEvidenceDigest(receipt)) {
      fail('external-runner-receipt-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-receipt-invalid')
  }
}

export function createExternalRunnerMatrix({
  package: archive,
  release_lock_digest,
  toolchain_digest,
} = {}) {
  try {
    const authority = packageAuthority(archive)
    if (!DIGEST.test(release_lock_digest) || !DIGEST.test(toolchain_digest)) {
      fail('external-runner-matrix-input-invalid')
    }
    const matrix = {
      authorities: {
        native_reference_report_digest:
          authority.authorities.native_reference_report_digest,
        package_manifest_digest: archive.manifest.manifest_digest,
        portable_conformance_digest:
          authority.authorities.portable_conformance_digest,
      },
      package_digest: archive.package_digest,
      release_lock_digest,
      schema: EXTERNAL_RUNNER_MATRIX_SCHEMA,
      status: 'external-runner-conformance-pending',
      targets: EXTERNAL_RUNNER_TARGETS,
      toolchain_digest,
    }
    matrix.matrix_digest = externalRunnerMatrixDigest(matrix)
    return { ok: true, value: matrix }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-matrix-invalid')
  }
}

export async function createExternalRunnerMatrixEvidence({
  claims,
  matrix,
  package: archive,
  task_reference,
} = {}) {
  try {
    validateMatrix(matrix, archive)
    if (!Array.isArray(claims)) {
      fail('external-runner-evidence-claims-invalid')
    }
    const normalized = claims
      .map(({ receipt, request }) => ({
        receipt,
        request,
        target_id: request?.target?.id,
      }))
      .sort((left, right) => left.target_id.localeCompare(right.target_id))
    const measured = normalized.map(({ target_id }) => target_id)
    const pending = matrix.targets
      .map(({ id }) => id)
      .filter((id) => !measured.includes(id))
    const evidence = {
      claims: normalized,
      matrix_digest: matrix.matrix_digest,
      measured_targets: measured,
      pending_targets: pending,
      schema: EXTERNAL_RUNNER_MATRIX_EVIDENCE_SCHEMA,
      status: pending.length === 0 ? 'complete' : 'partial',
    }
    evidence.evidence_digest = externalRunnerMatrixEvidenceDigest(evidence)
    const verified = await verifyExternalRunnerMatrixEvidence(evidence, {
      matrix,
      package: archive,
      task_reference,
    })
    return verified.ok ? { ok: true, value: evidence } : verified
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-evidence-invalid')
  }
}

export async function verifyExternalRunnerMatrixEvidence(evidence, {
  matrix,
  package: archive,
  task_reference,
} = {}) {
  try {
    validateMatrix(matrix, archive)
    if (!plainObject(evidence)
      || !exactShape(evidence, EVIDENCE_FIELDS)
      || evidence.schema !== EXTERNAL_RUNNER_MATRIX_EVIDENCE_SCHEMA
      || evidence.matrix_digest !== matrix.matrix_digest
      || !Array.isArray(evidence.claims)
      || !sortedUniqueText(evidence.measured_targets)
      || !sortedUniqueText(evidence.pending_targets)) {
      fail('external-runner-evidence-invalid')
    }
    const targetIds = matrix.targets.map(({ id }) => id)
    const claimIds = []
    for (const claim of evidence.claims) {
      if (!plainObject(claim)
        || !exactShape(claim, CLAIM_FIELDS)
        || claim.target_id !== claim.request?.target?.id
        || claim.target_id !== claim.receipt?.target?.id) {
        fail('external-runner-evidence-claim-mismatch')
      }
      claimIds.push(claim.target_id)
      const verified = await verifyExternalRunnerReceipt(claim.receipt, {
        package: archive,
        request: claim.request,
        task_reference,
      })
      if (!verified.ok) return verified
    }
    const pending = targetIds.filter((id) => !claimIds.includes(id))
    if (!canonicalEqual(claimIds, evidence.measured_targets)
      || !canonicalEqual(pending, evidence.pending_targets)
      || !sameSet([...claimIds, ...pending], targetIds)
      || evidence.status !== (pending.length === 0 ? 'complete' : 'partial')) {
      fail('external-runner-evidence-partition-mismatch')
    }
    if (evidence.evidence_digest
      !== externalRunnerMatrixEvidenceDigest(evidence)) {
      fail('external-runner-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch (error) {
    return rejected(error?.code ?? 'external-runner-evidence-invalid')
  }
}

export function externalRunnerRequestDigest(request) {
  if (!plainObject(request)) throw new TypeError('invalid external runner request')
  const { request_digest: ignored, ...content } = request
  return digestValue(content)
}

export function externalRunnerWorkloadDigest(workload) {
  if (!plainObject(workload)) {
    throw new TypeError('invalid external runner workload')
  }
  const {
    build: ignoredBuild,
    run: ignoredRun,
    workload_digest: ignored,
    ...content
  } = workload
  return digestValue(content)
}

export function externalRunnerReceiptStableDigest(receipt) {
  if (!plainObject(receipt)) throw new TypeError('invalid external runner receipt')
  const {
    evidence_digest: ignoredEvidence,
    stable_digest: ignoredStable,
    ...content
  } = receipt
  return digestValue({
    ...content,
    workloads: content.workloads.map((workload) => {
      const { build: ignoredBuild, run: ignoredRun, ...stable } = workload
      return stable
    }),
  })
}

export function externalRunnerReceiptEvidenceDigest(receipt) {
  if (!plainObject(receipt)) throw new TypeError('invalid external runner receipt')
  const { evidence_digest: ignored, ...content } = receipt
  return digestValue(content)
}

export function externalRunnerMatrixDigest(matrix) {
  if (!plainObject(matrix)) throw new TypeError('invalid external runner matrix')
  const { matrix_digest: ignored, ...content } = matrix
  return digestValue(content)
}

export function externalRunnerMatrixEvidenceDigest(evidence) {
  if (!plainObject(evidence)) {
    throw new TypeError('invalid external runner matrix evidence')
  }
  const { evidence_digest: ignored, ...content } = evidence
  return digestValue(content)
}

async function compileAndRun({
  compiler_path,
  expected,
  root,
  samples,
  suite,
  target,
}) {
  const executablePath = join(
    root,
    '.build',
    `${suite.name}-${expected.id}.bin`,
  )
  const buildSamples = []
  let executableDigest = null
  for (let sample = 0; sample < samples; sample += 1) {
    const started = process.hrtime.bigint()
    const built = spawnSync(
      compiler_path,
      [
        '-O2',
        '-std=c11',
        '-target',
        target.target_triple,
        '-I',
        join(root, 'runtime'),
        join(root, suite.core),
        join(root, expected.source_path),
        '-o',
        executablePath,
      ],
      { cwd: root, encoding: 'utf8', shell: false },
    )
    buildSamples.push(elapsed(started))
    if (built.error || built.status !== 0) {
      fail('external-runner-compile-failed')
    }
    const currentDigest = digestBytes(await readFile(executablePath))
    if (executableDigest !== null && executableDigest !== currentDigest) {
      fail('external-runner-build-nondeterministic')
    }
    executableDigest = currentDigest
  }
  const runSamples = []
  let stdout = null
  for (let sample = 0; sample < samples; sample += 1) {
    const started = process.hrtime.bigint()
    const executed = spawnSync(
      executablePath,
      [],
      { cwd: root, encoding: 'utf8', shell: false },
    )
    runSamples.push(elapsed(started))
    if (executed.error || executed.status !== 0 || executed.stderr !== '') {
      fail('external-runner-execution-failed')
    }
    if (stdout !== null && stdout !== executed.stdout) {
      fail('external-runner-output-nondeterministic')
    }
    stdout = executed.stdout
  }
  let execution
  try {
    execution = JSON.parse(stdout)
  } catch {
    fail('external-runner-output-invalid')
  }
  const workload = {
    build: { samples_ns: buildSamples },
    executable_digest: executableDigest,
    execution,
    id: expected.id,
    request_digest: expected.request_digest,
    run: { samples_ns: runSamples },
    source_digest: expected.source_digest,
    stdout_digest: digestBytes(Buffer.from(stdout, 'utf8')),
    suite: suite.name,
  }
  workload.workload_digest = externalRunnerWorkloadDigest(workload)
  return workload
}

function validateRequest(request) {
  if (!plainObject(request)
    || !exactShape(request, REQUEST_FIELDS)
    || request.schema !== EXTERNAL_RUNNER_REQUEST_SCHEMA
    || request.profile !== EXTERNAL_RUNNER_PROFILE
    || !CHALLENGE.test(request.challenge)
    || !DIGEST.test(request.package_digest)
    || !DIGEST.test(request.package_manifest_digest)
    || !DIGEST.test(request.release_lock_digest)
    || !DIGEST.test(request.request_digest)
    || !DIGEST.test(request.toolchain_digest)
    || !plainObject(request.authorities)
    || !exactShape(request.authorities, REQUEST_AUTHORITY_FIELDS)
    || !Object.values(request.authorities).every((value) => DIGEST.test(value))) {
    fail('external-runner-request-invalid')
  }
  validateTarget(request.target)
  validateProbe(request.runner)
}

function validateReceipt(receipt) {
  if (!plainObject(receipt)
    || !exactShape(receipt, RECEIPT_FIELDS)
    || receipt.schema !== EXTERNAL_RUNNER_RECEIPT_SCHEMA
    || receipt.profile !== EXTERNAL_RUNNER_PROFILE
    || receipt.status !== 'measured'
    || !DIGEST.test(receipt.challenge_digest)
    || !DIGEST.test(receipt.package_digest)
    || !DIGEST.test(receipt.request_digest)
    || !DIGEST.test(receipt.stable_digest)
    || !DIGEST.test(receipt.evidence_digest)
    || !Array.isArray(receipt.workloads)) {
    fail('external-runner-receipt-invalid')
  }
  validateTarget(receipt.target)
  validateProbe(receipt.provenance)
}

function validateMatrix(matrix, archive) {
  const authority = packageAuthority(archive)
  if (!plainObject(matrix)
    || !exactShape(matrix, MATRIX_FIELDS)
    || matrix.schema !== EXTERNAL_RUNNER_MATRIX_SCHEMA
    || matrix.status !== 'external-runner-conformance-pending'
    || !DIGEST.test(matrix.matrix_digest)
    || !DIGEST.test(matrix.package_digest)
    || !DIGEST.test(matrix.release_lock_digest)
    || !DIGEST.test(matrix.toolchain_digest)
    || matrix.package_digest !== archive.package_digest
    || !plainObject(matrix.authorities)
    || !exactShape(matrix.authorities, MATRIX_AUTHORITY_FIELDS)
    || !canonicalEqual(matrix.targets, EXTERNAL_RUNNER_TARGETS)
    || !canonicalEqual(matrix.authorities, {
      native_reference_report_digest:
        authority.authorities.native_reference_report_digest,
      package_manifest_digest: archive.manifest.manifest_digest,
      portable_conformance_digest:
        authority.authorities.portable_conformance_digest,
    })
    || matrix.matrix_digest !== externalRunnerMatrixDigest(matrix)) {
    fail('external-runner-matrix-invalid')
  }
}

function validateTarget(target) {
  const expected = EXTERNAL_RUNNER_TARGETS.find(({ id }) => id === target?.id)
  if (!plainObject(target)
    || !exactShape(target, TARGET_FIELDS)
    || expected === undefined
    || !canonicalEqual(target, expected)) {
    fail('external-runner-target-invalid')
  }
}

function validateProbe(probe) {
  if (!plainObject(probe)
    || !exactShape(probe, PROBE_FIELDS)
    || !DIGEST.test(probe.compiler_digest)
    || !DIGEST.test(probe.compiler_version_digest)
    || !DIGEST.test(probe.host_identity_digest)
    || !isAbsolute(probe.compiler_path)
    || probe.environment_id !== probe.target_id
    || probe.measurement_source !== 'runner'
    || probe.runner_id !== EXTERNAL_RUNNER_PROFILE
    || probe.synthetic !== false) {
    fail('external-runner-probe-invalid')
  }
  const target = EXTERNAL_RUNNER_TARGETS.find(({ id }) => id === probe.target_id)
  if (target === undefined
    || probe.operating_system !== target.platform
    || probe.architecture !== target.architecture
    || probe.target_triple !== target.target_triple
    || !validNodeVersion(probe.node_version, target.node_major)) {
    fail('external-runner-probe-target-mismatch')
  }
}

function validateWorkload(workload) {
  if (!plainObject(workload)
    || !exactShape(workload, WORKLOAD_FIELDS)
    || !['native-lifecycle', 'portable-four-opcode'].includes(workload.suite)
    || typeof workload.id !== 'string'
    || workload.id.length === 0
    || !DIGEST.test(workload.executable_digest)
    || !DIGEST.test(workload.request_digest)
    || !DIGEST.test(workload.source_digest)
    || !DIGEST.test(workload.stdout_digest)
    || !DIGEST.test(workload.workload_digest)) {
    fail('external-runner-receipt-workload-invalid')
  }
  validateMetric(workload.build)
  validateMetric(workload.run)
}

function validateMetric(metric) {
  if (!plainObject(metric)
    || !exactShape(metric, METRIC_FIELDS)
    || !Array.isArray(metric.samples_ns)
    || metric.samples_ns.length < 1
    || metric.samples_ns.length > 8
    || !metric.samples_ns.every((sample) => (
      typeof sample === 'string' && POSITIVE_INTEGER.test(sample)
    ))) {
    fail('external-runner-receipt-metric-invalid')
  }
}

function packageAuthority(archive) {
  if (!plainObject(archive)
    || archive.schema !== PORTABLE_RUNTIME_PACKAGE_SCHEMA
    || archive.package_digest !== portableRuntimePackageDigest(archive)
    || !plainObject(archive.manifest)
    || archive.manifest.manifest_digest
      !== portableRuntimePackageManifestDigest(archive.manifest)
    || archive.manifest.tree_digest
      !== portableRuntimePackageTreeDigest(archive.manifest.entries)
    || !Array.isArray(archive.entries)
    || !Array.isArray(archive.manifest.entries)
    || archive.entries.length !== archive.manifest.entries.length) {
    fail('external-runner-package-invalid')
  }
  const entries = new Map()
  for (let index = 0; index < archive.entries.length; index += 1) {
    const entry = archive.entries[index]
    const manifest = archive.manifest.entries[index]
    if (!plainObject(entry)
      || typeof entry.path !== 'string'
      || entry.path !== manifest?.path
      || invalidPath(entry.path)
      || entry.kind !== 'file'
      || entry.mode !== '0644') {
      fail('external-runner-package-entry-invalid')
    }
    const bytes = Buffer.from(entry.content_base64, 'base64')
    if (manifest.digest !== digestBytes(bytes)
      || manifest.size !== bytes.length
      || manifest.mode !== entry.mode) {
      fail('external-runner-package-entry-digest-mismatch')
    }
    if (entries.has(entry.path)) {
      fail('external-runner-package-entry-duplicate')
    }
    entries.set(entry.path, bytes)
  }
  const portableIndex = parseEntry(entries, 'conformance/index.json')
  const nativeIndex = parseEntry(entries, 'conformance/native/index.json')
  return {
    authorities: {
      native_reference_report_digest: nativeIndex.reference_report_digest,
      portable_conformance_digest: digestBytes(
        entries.get('conformance/index.json'),
      ),
    },
    entries,
    nativeIndex,
    portableIndex,
  }
}

async function materializePackage(entries, root) {
  for (const [path, bytes] of entries) {
    const destination = join(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 })
  }
}

function expectedWorkloads(authority) {
  return [
    ...authority.nativeIndex.workloads.map((workload) => ({
      ...workload,
      suite: 'native-lifecycle',
    })),
    ...authority.portableIndex.workloads.map((workload) => ({
      ...workload,
      suite: 'portable-four-opcode',
    })),
  ].sort(compareWorkloads)
}

function taskReferenceMap(reference) {
  if (!plainObject(reference)
    || !Array.isArray(reference.workloads)
    || !DIGEST.test(reference.report_digest)) {
    fail('external-runner-task-reference-invalid')
  }
  return new Map(reference.workloads.map((workload) => [
    workload.id,
    {
      id: workload.id,
      request_digest: workload.request.request_digest,
      result: workload.result,
    },
  ]))
}

function parseEntry(entries, path) {
  const bytes = entries.get(path)
  if (bytes === undefined) fail('external-runner-package-entry-missing')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('external-runner-package-entry-invalid')
  }
}

function runnerTarget(runner) {
  return EXTERNAL_RUNNER_TARGETS.find(({ id }) => id === runner?.target_id)
}

function workloadIdentity({ id, suite }) {
  return { id, suite }
}

function compareWorkloads(left, right) {
  return left.suite.localeCompare(right.suite) || left.id.localeCompare(right.id)
}

function invalidPath(path) {
  return path.startsWith('/')
    || path.includes('\\')
    || path.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    ))
}

function validNodeVersion(value, major) {
  const match = typeof value === 'string' ? NODE_VERSION.exec(value) : null
  return match !== null && Number(match[1]) === major
}

function elapsed(started) {
  const duration = process.hrtime.bigint() - started
  return (duration > 0n ? duration : 1n).toString()
}

function exactShape(value, expected) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), expected)
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
