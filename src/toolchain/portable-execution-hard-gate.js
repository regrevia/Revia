import { createHash } from 'node:crypto'

export const PORTABLE_EXECUTION_HARD_GATE_POLICY_SCHEMA =
  're.portable-execution-hard-gate-policy@0.1.0'
export const PORTABLE_EXECUTION_HARD_GATE_REPORT_SCHEMA =
  're.portable-execution-hard-gate-report@0.1.0'
export const PORTABLE_EXECUTION_HARD_GATE_PROFILE =
  're.portable-execution-hard-gate@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const CANDIDATES = Object.freeze([
  ['node-reference', 'semantic-reference'],
  ['portable-core', 'portable-candidate'],
  ['portable-process', 'transport-candidate'],
  ['llvm-aot', 'external-native-candidate'],
  ['cranelift', 'external-native-candidate'],
])
const DOMAINS = Object.freeze([
  ['execution', 9],
  ['fault', 13],
  ['task-lifecycle', 14],
])
const SEMANTIC_BUDGETS = Object.freeze([
  ['semantic_mismatch_count', 'max', 0],
  ['artifact_mismatch_count', 'max', 0],
  ['receipt_mismatch_count', 'max', 0],
  ['error_mismatch_count', 'max', 0],
])
const PERFORMANCE_BUDGETS = Object.freeze([
  ['cold_start_ns', 'max', 5_000_000_000],
  ['p99_ns', 'max', 2_000_000_000],
  ['peak_rss_bytes', 'max', 1_073_741_824],
  ['throughput_ops_sec', 'min', 1],
])

export function runPortableExecutionHardGate({
  executionReport,
  externalEvidence,
  externalMatrix,
  faultReport,
  lifecycleReport,
  policy,
  runtimeAbiReport,
} = {}) {
  const validated = validateInputs({
    executionReport,
    externalEvidence,
    externalMatrix,
    faultReport,
    lifecycleReport,
    policy,
    runtimeAbiReport,
  })
  if (!validated.ok) return validated

  const report = {
    authority: {
      execution_report_digest: executionReport.report_digest,
      external_evidence_digest: externalEvidence.evidence_digest,
      external_matrix_digest: externalMatrix.matrix_digest,
      fault_report_digest: faultReport.report_digest,
      lifecycle_report_digest: lifecycleReport.report_digest,
      runtime_abi_report_digest: runtimeAbiReport.report_digest,
    },
    budgets: SEMANTIC_BUDGETS.map(([id, comparator, threshold]) => ({
      comparator,
      id,
      observed: 0,
      status: 'pass',
      threshold,
    })),
    candidates: candidateReport(executionReport, externalEvidence),
    domains: DOMAINS.map(([id, workload_count]) => ({
      id,
      report_digest: domainReportDigest({
        executionReport,
        faultReport,
        lifecycleReport,
      }, id),
      workload_count,
    })),
    performance_budgets: PERFORMANCE_BUDGETS.map(
      ([id, comparator, threshold]) => ({
        comparator,
        id,
        observed: null,
        status: 'pending',
        threshold,
      }),
    ),
    policy_digest: digest(policy),
    profile: PORTABLE_EXECUTION_HARD_GATE_PROFILE,
    release_claims: [],
    schema: PORTABLE_EXECUTION_HARD_GATE_REPORT_SCHEMA,
    status: 'semantic-frozen-performance-pending',
  }
  report.report_digest = portableExecutionHardGateReportDigest(report)
  return { ok: true, value: report }
}

export function verifyPortableExecutionHardGate(report, inputs = {}) {
  const validated = validateInputs(inputs)
  if (!validated.ok) return validated
  const expected = runPortableExecutionHardGate(inputs)
  if (!expected.ok) return expected
  if (!plainObject(report)
    || !DIGEST.test(report.report_digest)
    || report.report_digest !== portableExecutionHardGateReportDigest(report)) {
    return rejected('portable-hard-gate-report-digest-mismatch')
  }
  if (canonicalJson(report) !== canonicalJson(expected.value)) {
    return rejected('portable-hard-gate-report-authority-mismatch')
  }
  return { ok: true }
}

export function portableExecutionHardGateReportDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid portable execution hard gate report')
  }
  const { report_digest: ignored, ...content } = report
  return digest(content)
}

function validateInputs({
  executionReport,
  externalEvidence,
  externalMatrix,
  faultReport,
  lifecycleReport,
  policy,
  runtimeAbiReport,
}) {
  const policyResult = validatePolicy(policy)
  if (!policyResult.ok) return policyResult

  if (!validDigestReport(
    executionReport,
    're.portable-executor-benchmark@0.1.0',
    'execution',
  )) {
    return rejected('portable-hard-gate-execution-authority-mismatch')
  }
  if (!validDigestReport(
    faultReport,
    're.portable-fault-protocol-report@0.1.0',
    'fault',
  ) || !Array.isArray(faultReport.workloads)
    || faultReport.workloads.length !== 13) {
    return rejected('portable-hard-gate-fault-authority-mismatch')
  }
  if (!validDigestReport(
    lifecycleReport,
    're.task-runtime-lifecycle-report@0.1.0',
    'task-lifecycle',
  ) || !Array.isArray(lifecycleReport.workloads)
    || lifecycleReport.workloads.length !== 14) {
    return rejected('portable-hard-gate-lifecycle-authority-mismatch')
  }
  if (!validateExecutionCandidates(executionReport)) {
    return rejected('portable-hard-gate-execution-authority-mismatch')
  }
  if (!validateRuntimeAbiReport(
    runtimeAbiReport,
    executionReport,
    faultReport,
    lifecycleReport,
  )) {
    return rejected('portable-hard-gate-runtime-abi-authority-mismatch')
  }
  if (!validateExternalEvidence(externalMatrix, externalEvidence)) {
    return rejected('portable-hard-gate-external-authority-mismatch')
  }
  return { ok: true }
}

function validatePolicy(policy) {
  if (!plainObject(policy)
    || policy.schema !== PORTABLE_EXECUTION_HARD_GATE_POLICY_SCHEMA
    || policy.profile !== PORTABLE_EXECUTION_HARD_GATE_PROFILE
    || canonicalJson(policy.candidates) !== canonicalJson(
      CANDIDATES.map(([id, role]) => ({ id, role })),
    )) {
    return rejected('portable-hard-gate-policy-candidate-set-mismatch')
  }
  if (canonicalJson(policy.domains) !== canonicalJson(
    DOMAINS.map(([id, workload_count]) => ({ id, workload_count })),
  )) {
    return rejected('portable-hard-gate-policy-domain-set-mismatch')
  }
  if (canonicalJson(policy.budgets) !== canonicalJson(
    SEMANTIC_BUDGETS.map(([id, comparator, threshold]) => ({
      comparator,
      id,
      threshold,
    })),
  )) {
    return rejected('portable-hard-gate-policy-budget-mismatch')
  }
  if (canonicalJson(policy.performance_budgets) !== canonicalJson(
    PERFORMANCE_BUDGETS.map(([id, comparator, threshold]) => ({
      comparator,
      id,
      threshold,
    })),
  )) {
    return rejected('portable-hard-gate-policy-budget-mismatch')
  }
  return { ok: true }
}

function validateExecutionCandidates(report) {
  const expected = ['node-reference', 'portable-core', 'portable-process', 'llvm-aot', 'cranelift']
  return Array.isArray(report.candidates)
    && canonicalJson(report.candidates.map(({ candidate }) => candidate))
      === canonicalJson(expected)
    && report.candidates.slice(0, 3).every((candidate) =>
      candidate.status === 'measured'
      && Array.isArray(candidate.workloads)
      && candidate.workloads.length === 9)
}

function validateRuntimeAbiReport(
  report,
  executionReport,
  faultReport,
  lifecycleReport,
) {
  if (!validDigestReport(
    report,
    're.portable-runtime-abi-report@0.1.0',
    'runtime-abi',
  ) || !Array.isArray(report.domains)
    || report.domains.length !== 3) {
    return false
  }
  const expected = [
    ['execution', executionReport],
    ['fault', faultReport],
    ['task-lifecycle', lifecycleReport],
  ]
  return report.domains.every((domain, index) =>
    domain.id === expected[index][0]
    && domain.report_digest === expected[index][1].report_digest
    && domain.workload_count === DOMAINS[index][1])
}

function validateExternalEvidence(matrix, evidence) {
  if (!plainObject(matrix)
    || matrix.schema !== 're.external-runner-matrix@0.1.0'
    || !DIGEST.test(matrix.matrix_digest)
    || matrix.matrix_digest !== digestWithout(matrix, 'matrix_digest')
    || !plainObject(evidence)
    || evidence.schema !== 're.external-runner-matrix-evidence@0.1.0'
    || evidence.matrix_digest !== matrix.matrix_digest
    || !DIGEST.test(evidence.evidence_digest)
    || evidence.evidence_digest !== digestWithout(evidence, 'evidence_digest')
    || !Array.isArray(evidence.claims)) {
    return false
  }
  return evidence.claims.some(({ receipt }) =>
    receipt?.status === 'measured'
    && receipt?.target?.backend === 'aot-llvm'
    && receipt.target.suites?.includes('portable-four-opcode'))
}

function validDigestReport(report, schema, kind) {
  if (!plainObject(report)
    || report.schema !== schema
    || !DIGEST.test(report.report_digest)
    || report.report_digest !== digestWithout(report, 'report_digest')) {
    return false
  }
  if (kind === 'execution'
    && report.profile !== 're.portable-equivalence@0.1.0') {
    return false
  }
  return true
}

function candidateReport(executionReport, externalEvidence) {
  const measured = new Set(
    executionReport.candidates
      .filter(({ status }) => status === 'measured')
      .map(({ candidate }) => candidate),
  )
  const llvmReported = externalEvidence.claims.some(({ receipt }) =>
    receipt?.status === 'measured'
    && receipt?.target?.backend === 'aot-llvm'
    && receipt.target.suites?.includes('portable-four-opcode'))
  return CANDIDATES.map(([id, role]) => ({
    domain_ids: id === 'cranelift'
      ? []
      : id === 'llvm-aot'
        ? ['execution']
        : ['execution', 'fault', 'task-lifecycle'],
    id,
    performance_status: 'pending',
    role,
    semantic_status: measured.has(id)
      ? 'verified'
      : id === 'llvm-aot' && llvmReported
        ? 'reported'
        : 'pending',
  }))
}

function domainReportDigest(reports, id) {
  if (id === 'execution') return reports.executionReport.report_digest
  if (id === 'fault') return reports.faultReport.report_digest
  return reports.lifecycleReport.report_digest
}

function digestWithout(value, field) {
  const { [field]: ignored, ...content } = value
  return digest(content)
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
