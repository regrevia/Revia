import { createHash } from 'node:crypto'

import {
  llvmAotExternalEvidenceDigest,
  llvmAotExternalStableDigest,
  verifyLlvmAotExternalEvidence,
} from './llvm-aot-external-evidence.js'
import {
  portableExecutionHardGateReportDigest,
} from './portable-execution-hard-gate.js'
import {
  standaloneFaultHostReportDigest,
} from './standalone-fault-host-boundary.js'
import {
  standaloneMinimalStdReportDigest,
} from './standalone-minimal-std.js'
import {
  standalonePortableVmReportDigest,
} from './standalone-portable-vm.js'
import {
  verifyStandaloneCrossPlatformEvidence,
} from './standalone-cross-platform-runner.js'
import {
  standaloneTaskLifecycleReportDigest,
} from './standalone-task-lifecycle-core.js'

export const STANDALONE_SEMANTIC_PERFORMANCE_POLICY_SCHEMA =
  're.standalone-semantic-performance-hard-gate-policy@0.1.0'
export const STANDALONE_SEMANTIC_PERFORMANCE_REPORT_SCHEMA =
  're.standalone-semantic-performance-hard-gate-report@0.1.0'
export const STANDALONE_SEMANTIC_PERFORMANCE_PROFILE =
  're.standalone-semantic-performance-hard-gate@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CANDIDATES = Object.freeze([
  ['node-reference', 'semantic-reference'],
  ['standalone-c11', 'portable-native-candidate'],
  ['llvm-aot', 'external-native-candidate'],
  ['cranelift', 'external-native-candidate'],
])
const DOMAINS = Object.freeze([
  ['execution', 9],
  ['minimal-std', 12],
  ['fault', 13],
  ['task-lifecycle', 14],
])
const SEMANTIC_BUDGETS = Object.freeze([
  ['semantic_mismatch_count', 'max', 0],
  ['artifact_mismatch_count', 'max', 0],
  ['receipt_mismatch_count', 'max', 0],
  ['error_mismatch_count', 'max', 0],
])
const PERFORMANCE_METRICS = Object.freeze([
  ['cold_start_ns', 'max', 5_000_000_000],
  ['p99_ns', 'max', 2_000_000_000],
  ['peak_rss_bytes', 'max', 1_073_741_824],
  ['throughput_ops_sec', 'min', 1],
])
const REQUIRED_SAMPLE_COUNT = 5
const WORKLOAD_PROFILE = 'frozen-standalone-four-domain-suite'
const WARMUP = 'candidate-defined-but-versioned'
const REPORT_KEYS = Object.freeze([
  'authority',
  'candidates',
  'domains',
  'environments',
  'performance_budgets',
  'policy_digest',
  'profile',
  'release_claims',
  'report_digest',
  'schema',
  'semantic_budgets',
  'status',
])

export async function runStandaloneSemanticPerformanceHardGate(inputs = {}) {
  const validated = await validateInputs(inputs)
  if (!validated.ok) return validated

  const {
    crossEvidence,
    crossMatrix,
    llvmEvidence,
    package: archive,
    policy,
    portableGate,
    release_lock_digest,
    standaloneReports,
    toolchain_digest,
  } = inputs
  const report = {
    authority: {
      llvm_aot_evidence_digest: llvmEvidence.evidence_digest,
      llvm_aot_stable_digest: llvmEvidence.stable_digest,
      package_digest: archive.package_digest,
      portable_gate_report_digest: portableGate.report_digest,
      release_lock_digest,
      standalone_cross_platform_evidence_digest:
        crossEvidence.evidence_digest,
      standalone_cross_platform_matrix_digest: crossMatrix.matrix_digest,
      standalone_reports: {
        fault: standaloneReports.fault.report_digest,
        minimal_std: standaloneReports.minimal_std.report_digest,
        portable_vm: standaloneReports.portable_vm.report_digest,
        task_lifecycle: standaloneReports.task_lifecycle.report_digest,
      },
      toolchain_digest,
    },
    candidates: candidateReport(),
    domains: domainReport({
      llvmEvidence,
      portableGate,
      standaloneReports,
    }),
    environments: {
      measured: crossEvidence.measured_targets,
      pending: crossEvidence.pending_targets,
      status: crossEvidence.status,
    },
    performance_budgets: CANDIDATES.flatMap(([candidate]) =>
      PERFORMANCE_METRICS.map(([id, comparator, threshold]) => ({
        candidate,
        comparator,
        evidence_digest: null,
        id,
        observed: null,
        reason: candidate === 'cranelift'
          ? 'candidate-not-implemented'
          : 'no-comparable-profile-evidence',
        required_sample_count: REQUIRED_SAMPLE_COUNT,
        status: 'pending',
        threshold,
      }))),
    policy_digest: digestValue(policy),
    profile: STANDALONE_SEMANTIC_PERFORMANCE_PROFILE,
    release_claims: [],
    schema: STANDALONE_SEMANTIC_PERFORMANCE_REPORT_SCHEMA,
    semantic_budgets: SEMANTIC_BUDGETS.map(
      ([id, comparator, threshold]) => ({
        comparator,
        id,
        observed: 0,
        status: 'pass',
        threshold,
      }),
    ),
    status: 'semantic-frozen-performance-pending',
  }
  report.report_digest =
    standaloneSemanticPerformanceHardGateReportDigest(report)
  return { ok: true, value: report }
}

export async function verifyStandaloneSemanticPerformanceHardGate(
  report,
  inputs = {},
) {
  const validated = await validateInputs(inputs)
  if (!validated.ok) return validated
  const expected = await runStandaloneSemanticPerformanceHardGate(inputs)
  if (!expected.ok) return expected
  if (!plainObject(report)
    || !exactShape(report, REPORT_KEYS)
    || !DIGEST.test(report.report_digest)
    || report.report_digest
      !== standaloneSemanticPerformanceHardGateReportDigest(report)) {
    return rejected('standalone-hard-gate-report-digest-mismatch')
  }
  if (!canonicalEqual(report, expected.value)) {
    return rejected('standalone-hard-gate-report-authority-mismatch')
  }
  return { ok: true }
}

export function standaloneSemanticPerformanceHardGateReportDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid standalone semantic performance report')
  }
  return standaloneHardGateDigestWithout(report, 'report_digest')
}

export function standaloneHardGateDigestWithout(value, field) {
  if (!plainObject(value) || typeof field !== 'string') {
    throw new TypeError('invalid standalone hard gate digest input')
  }
  const { [field]: ignored, ...content } = value
  return digestValue(content)
}

async function validateInputs({
  crossEvidence,
  crossMatrix,
  llvmEvidence,
  loadGraph,
  package: archive,
  policy,
  portableBundle,
  portableGate,
  release_lock_digest,
  standaloneReports,
  toolchain_digest,
}) {
  const policyResult = validatePolicy(policy)
  if (!policyResult.ok) return policyResult
  if (!DIGEST.test(release_lock_digest)
    || !DIGEST.test(toolchain_digest)
    || typeof loadGraph !== 'function'
    || !plainObject(portableBundle)) {
    return rejected('standalone-hard-gate-input-invalid')
  }
  if (!validatePortableGate(portableGate)) {
    return rejected('standalone-hard-gate-portable-authority-mismatch')
  }
  if (!validateStandaloneReports(standaloneReports)
    || archive?.manifest?.authorities?.release_lock_digest
      !== release_lock_digest
    || archive?.manifest?.authorities?.toolchain_digest !== toolchain_digest) {
    return rejected('standalone-hard-gate-cross-platform-authority-mismatch')
  }
  const crossVerified = await verifyStandaloneCrossPlatformEvidence(
    crossEvidence,
    {
      matrix: crossMatrix,
      package: archive,
      reports: {
        fault_host: standaloneReports.fault,
        minimal_std: standaloneReports.minimal_std,
        portable_vm: standaloneReports.portable_vm,
        task_lifecycle: standaloneReports.task_lifecycle,
      },
    },
  )
  if (!crossVerified.ok
    || crossMatrix.release_lock_digest !== release_lock_digest
    || crossMatrix.toolchain_digest !== toolchain_digest
    || crossEvidence.status !== 'partial'
    || !canonicalEqual(crossEvidence.measured_targets, [
      'linux-x64-standalone-c11',
    ])
    || !canonicalEqual(crossEvidence.pending_targets, [
      'windows-x64-standalone-c11',
    ])) {
    return rejected('standalone-hard-gate-cross-platform-authority-mismatch')
  }
  const llvmVerified = await verifyLlvmAotExternalEvidence(llvmEvidence, {
    bundle: portableBundle,
    loadGraph,
    release_lock_digest,
    toolchain_digest,
  })
  if (!llvmVerified.ok
    || archive.manifest.authorities.llvm_aot_evidence_digest
      !== llvmEvidence.evidence_digest
    || archive.manifest.authorities.llvm_aot_stable_digest
      !== llvmEvidence.stable_digest) {
    return rejected('standalone-hard-gate-llvm-authority-mismatch')
  }
  return { ok: true }
}

function validatePolicy(policy) {
  if (!plainObject(policy)
    || !exactShape(policy, [
      'candidates',
      'domains',
      'performance_profile',
      'profile',
      'schema',
      'semantic_budgets',
    ])
    || policy.schema !== STANDALONE_SEMANTIC_PERFORMANCE_POLICY_SCHEMA
    || policy.profile !== STANDALONE_SEMANTIC_PERFORMANCE_PROFILE
    || !canonicalEqual(
      policy.candidates,
      CANDIDATES.map(([id, role]) => ({ id, role })),
    )) {
    return rejected('standalone-hard-gate-policy-candidate-set-mismatch')
  }
  if (!canonicalEqual(
    policy.domains,
    DOMAINS.map(([id, workload_count]) => ({ id, workload_count })),
  )) {
    return rejected('standalone-hard-gate-policy-domain-set-mismatch')
  }
  if (!canonicalEqual(
    policy.semantic_budgets,
    SEMANTIC_BUDGETS.map(([id, comparator, threshold]) => ({
      comparator,
      id,
      threshold,
    })),
  )) {
    return rejected('standalone-hard-gate-policy-semantic-budget-mismatch')
  }
  const expectedPerformance = {
    metrics: PERFORMANCE_METRICS.map(([id, comparator, threshold]) => ({
      comparator,
      id,
      threshold,
    })),
    required_sample_count: REQUIRED_SAMPLE_COUNT,
    warmup: WARMUP,
    workload_profile: WORKLOAD_PROFILE,
  }
  if (!canonicalEqual(policy.performance_profile, expectedPerformance)) {
    return rejected('standalone-hard-gate-policy-performance-profile-mismatch')
  }
  return { ok: true }
}

function validatePortableGate(report) {
  if (!plainObject(report)
    || report.schema !== 're.portable-execution-hard-gate-report@0.1.0'
    || report.profile !== 're.portable-execution-hard-gate@0.1.0'
    || report.status !== 'semantic-frozen-performance-pending'
    || report.report_digest !== portableExecutionHardGateReportDigest(report)
    || !Array.isArray(report.release_claims)
    || report.release_claims.length !== 0
    || !Array.isArray(report.semantic_budgets ?? report.budgets)) {
    return false
  }
  const budgets = report.semantic_budgets ?? report.budgets
  return budgets.length === SEMANTIC_BUDGETS.length
    && budgets.every(({ observed, status, threshold }) =>
      observed === 0 && status === 'pass' && threshold === 0)
    && Array.isArray(report.performance_budgets)
    && report.performance_budgets.every(({ observed, status }) =>
      observed === null && status === 'pending')
}

function validateStandaloneReports(reports) {
  if (!plainObject(reports)
    || !exactShape(reports, [
      'fault',
      'minimal_std',
      'portable_vm',
      'task_lifecycle',
    ])) {
    return false
  }
  const expected = [
    [
      reports.portable_vm,
      're.standalone-portable-vm-report@0.1.0',
      9,
      standalonePortableVmReportDigest,
    ],
    [
      reports.minimal_std,
      're.standalone-minimal-std-report@0.1.0',
      12,
      standaloneMinimalStdReportDigest,
    ],
    [
      reports.fault,
      're.standalone-fault-host-report@0.1.0',
      13,
      standaloneFaultHostReportDigest,
    ],
    [
      reports.task_lifecycle,
      're.standalone-task-lifecycle-report@0.1.0',
      14,
      standaloneTaskLifecycleReportDigest,
    ],
  ]
  return expected.every(([report, schema, count, reportDigest]) =>
    plainObject(report)
    && report.schema === schema
    && report.status === 'measured'
    && Array.isArray(report.workloads)
    && report.workloads.length === count
    && report.report_digest === reportDigest(report))
}

function candidateReport() {
  return CANDIDATES.map(([id, role]) => ({
    domain_ids: id === 'cranelift'
      ? []
      : id === 'llvm-aot'
        ? ['execution']
        : DOMAINS.map(([domain]) => domain),
    id,
    performance_status: 'pending',
    role,
    semantic_status: id === 'cranelift'
      ? 'pending'
      : id === 'llvm-aot'
        ? 'reported'
        : 'verified',
  }))
}

function domainReport({ llvmEvidence, portableGate, standaloneReports }) {
  return [
    {
      id: 'execution',
      llvm_aot_stable_digest: llvmEvidence.stable_digest,
      node_reference_digest:
        portableGate.authority.execution_report_digest,
      standalone_report_digest: standaloneReports.portable_vm.report_digest,
      workload_count: 9,
    },
    {
      id: 'minimal-std',
      llvm_aot_stable_digest: null,
      node_reference_digest: standaloneReports.minimal_std.bundle_digest,
      standalone_report_digest: standaloneReports.minimal_std.report_digest,
      workload_count: 12,
    },
    {
      id: 'fault',
      llvm_aot_stable_digest: null,
      node_reference_digest: portableGate.authority.fault_report_digest,
      standalone_report_digest: standaloneReports.fault.report_digest,
      workload_count: 13,
    },
    {
      id: 'task-lifecycle',
      llvm_aot_stable_digest: null,
      node_reference_digest: portableGate.authority.lifecycle_report_digest,
      standalone_report_digest:
        standaloneReports.task_lifecycle.report_digest,
      workload_count: 14,
    },
  ]
}

function exactShape(value, fields) {
  return plainObject(value)
    && canonicalEqual(Object.keys(value).sort(), [...fields].sort())
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
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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
