import { createHash } from 'node:crypto'

import { agentProjectReleaseLockDigest } from '../runtime/backend-contract.js'
import {
  portableRuntimePackageDigest,
  portableRuntimePackageManifestDigest,
  portableRuntimePackageTreeDigest,
} from './portable-runtime-package.js'
import {
  portableExecutionHardGateReportDigest,
} from './portable-execution-hard-gate.js'
import {
  standaloneCrossPlatformEvidenceDigest,
  standaloneCrossPlatformMatrixDigest,
} from './standalone-cross-platform-runner.js'
import {
  standaloneFaultHostReportDigest,
  STANDALONE_FAULT_HOST_ERROR_SCHEMA,
  STANDALONE_FAULT_HOST_RECEIPT_SCHEMA,
  STANDALONE_FAULT_HOST_REQUEST_SCHEMA,
  STANDALONE_FAULT_HOST_WIRE_SCHEMA,
} from './standalone-fault-host-boundary.js'
import {
  standaloneMinimalStdReportDigest,
  STANDALONE_MINIMAL_STD_ERROR_SCHEMA,
  STANDALONE_MINIMAL_STD_RECEIPT_SCHEMA,
  STANDALONE_MINIMAL_STD_REQUEST_SCHEMA,
  STANDALONE_MINIMAL_STD_WIRE_SCHEMA,
} from './standalone-minimal-std.js'
import {
  standalonePortableVmReportDigest,
  STANDALONE_PORTABLE_VM_ERROR_SCHEMA,
  STANDALONE_PORTABLE_VM_RECEIPT_SCHEMA,
  STANDALONE_PORTABLE_VM_WIRE_SCHEMA,
} from './standalone-portable-vm.js'
import {
  standaloneSemanticPerformanceHardGateReportDigest,
} from './standalone-semantic-performance-hard-gate.js'
import {
  standaloneTaskLifecycleReportDigest,
  STANDALONE_TASK_LIFECYCLE_RECEIPT_SCHEMA,
  STANDALONE_TASK_LIFECYCLE_REQUEST_SCHEMA,
  STANDALONE_TASK_LIFECYCLE_WIRE_SCHEMA,
} from './standalone-task-lifecycle-core.js'

export const STANDALONE_RUNTIME_CONTRACT_SCHEMA =
  're.standalone-runtime-contract@0.1.0'
export const STANDALONE_RUNTIME_CONTRACT_POLICY_SCHEMA =
  're.standalone-runtime-contract-policy@0.1.0'
export const STANDALONE_RUNTIME_CONTRACT_PROFILE =
  STANDALONE_RUNTIME_CONTRACT_SCHEMA

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const RELEASE_STATUS = 'protocol-frozen-execution-pending'
const EXECUTION_REQUEST_SCHEMA = 're.portable-equivalence-request@0.1.0'
const TASK_RESULT_SCHEMA = 're.task-runtime-lifecycle-result@0.1.0'
const FAULT_RESULT_SCHEMA = 're.portable-fault-protocol-result@0.1.0'
const COMMON_ARTIFACT_FIELDS = Object.freeze([
  'artifact_digest',
  'graph_revision',
  'package_digest',
  'request_digest',
])
const REPORTS = Object.freeze({
  fault: Object.freeze({
    digest: standaloneFaultHostReportDigest,
    profile: 're.standalone-fault-host@0.1.0',
    schema: 're.standalone-fault-host-report@0.1.0',
    workload_count: 13,
  }),
  minimal_std: Object.freeze({
    digest: standaloneMinimalStdReportDigest,
    profile: 're.standalone-minimal-std@0.1.0',
    schema: 're.standalone-minimal-std-report@0.1.0',
    workload_count: 12,
  }),
  portable_vm: Object.freeze({
    digest: standalonePortableVmReportDigest,
    profile: 're.standalone-portable-vm@0.1.0',
    schema: 're.standalone-portable-vm-report@0.1.0',
    workload_count: 9,
  }),
  task_lifecycle: Object.freeze({
    digest: standaloneTaskLifecycleReportDigest,
    profile: 're.standalone-task-lifecycle@0.1.0',
    schema: 're.standalone-task-lifecycle-report@0.1.0',
    workload_count: 14,
  }),
})
const REPORT_KEYS = Object.freeze({
  fault: [
    'candidate', 'corpus_digest', 'executable_digest', 'package_digest',
    'profile', 'protocol_report_digest', 'provenance', 'release_lock_digest',
    'report_digest', 'schema', 'source_digest', 'status', 'target_triple',
    'toolchain_digest', 'wire_schema', 'workloads',
  ],
  minimal_std: [
    'bundle_digest', 'candidate', 'executable_digest', 'package_digest',
    'profile', 'provenance', 'report_digest', 'schema', 'source_digest',
    'status', 'target_triple', 'wire_schema', 'workloads',
  ],
  portable_vm: [
    'bundle_digest', 'candidate', 'executable_digest', 'profile',
    'provenance', 'release_lock_digest', 'report_digest', 'schema',
    'source_digest', 'status', 'target_triple', 'toolchain_digest',
    'wire_schema', 'workloads',
  ],
  task_lifecycle: [
    'corpus_digest', 'executable_digest', 'package_digest', 'profile',
    'provenance', 'reference_report_digest', 'release_lock_digest',
    'report_digest', 'schema', 'source_digest', 'status', 'target_triple',
    'toolchain_digest', 'wire_schema', 'workloads',
  ],
})
const DOMAIN_KEYS = Object.freeze([
  'id',
  'report_digest',
  'report_schema',
  'workload_count',
])
const AUTHORITY_KEYS = Object.freeze([
  'cross_platform_evidence_digest',
  'cross_platform_matrix_digest',
  'fault_report_digest',
  'minimal_std_report_digest',
  'package_digest',
  'package_manifest_digest',
  'package_tree_digest',
  'portable_gate_digest',
  'portable_vm_report_digest',
  'release_lock_digest',
  'semantic_gate_digest',
  'task_lifecycle_report_digest',
  'toolchain_digest',
])
const ARTIFACT_KEYS = Object.freeze([
  'digest_algorithm',
  'digest_field',
  'framing',
  'header_bytes',
  'max_payload_bytes',
  'request_magics',
  'response_magics',
  'version',
  'wire_schemas',
])
const REQUEST_KEYS = Object.freeze([
  'authority_fields',
  'digest_field',
  'expected_outcome_input',
  'oracle_binding',
  'schemas',
])
const RECEIPT_KEYS = Object.freeze([
  'bound_fields',
  'digest_field',
  'expected_outcome_input',
  'replay_binding',
  'schemas',
])
const ERROR_KEYS = Object.freeze([
  'closed_set',
  'expected_outcome_input',
  'nested_result_schemas',
  'schemas',
  'stable_code_field',
])
const CONTRACT_KEYS = Object.freeze([
  'artifact_protocol',
  'authority',
  'contract_digest',
  'domains',
  'error_protocol',
  'mismatch_budgets',
  'profile',
  'receipt_protocol',
  'release_claims',
  'release_status',
  'request_protocol',
  'schema',
])

export function runStandaloneRuntimeContract(inputs = {}) {
  const validated = validateInputs(inputs)
  if (!validated.ok) return validated
  const report = buildContract(inputs)
  report.contract_digest = standaloneRuntimeContractDigest(report)
  return { ok: true, value: report }
}

export function verifyStandaloneRuntimeContract(report, inputs = {}) {
  const validated = validateInputs(inputs)
  if (!validated.ok) return validated
  if (!plainObject(report)
    || !exactShape(report, CONTRACT_KEYS)
    || !DIGEST.test(report.contract_digest)
    || report.contract_digest !== standaloneRuntimeContractDigest(report)) {
    return rejected('standalone-runtime-contract-report-digest-mismatch')
  }
  const expected = buildContract(inputs)
  expected.contract_digest = standaloneRuntimeContractDigest(expected)
  if (!canonicalEqual(report, expected)) {
    return rejected('standalone-runtime-contract-authority-mismatch')
  }
  return { ok: true }
}

export function standaloneRuntimeContractDigest(report) {
  if (!plainObject(report)) {
    throw new TypeError('invalid standalone runtime contract')
  }
  const { contract_digest: ignored, ...content } = report
  return digestValue(content)
}

function buildContract({
  crossEvidence,
  crossMatrix,
  package: archive,
  portableGate,
  releaseLock,
  semanticGate,
  standaloneReports,
  toolchain_digest,
  policy,
}) {
  const report = {
    artifact_protocol: {
      digest_algorithm: policy.artifact_protocol.digest_algorithm,
      digest_field: policy.artifact_protocol.digest_field,
      framing: 'magic+version+length+sha256+payload',
      header_bytes: policy.artifact_protocol.header_bytes,
      max_payload_bytes: policy.artifact_protocol.max_payload_bytes,
      request_magics: [
        'REVMREQ1',
        'RESTREQ1',
        'REFLREQ1',
        'RETLREQ1',
      ],
      response_magics: [
        'REVMRES1',
        'RESTRES1',
        'REFLRES1',
        'RETLRES1',
      ],
      version: policy.artifact_protocol.version,
      wire_schemas: [
        STANDALONE_PORTABLE_VM_WIRE_SCHEMA,
        STANDALONE_MINIMAL_STD_WIRE_SCHEMA,
        STANDALONE_FAULT_HOST_WIRE_SCHEMA,
        STANDALONE_TASK_LIFECYCLE_WIRE_SCHEMA,
      ],
    },
    authority: {
      cross_platform_evidence_digest:
        standaloneCrossPlatformEvidenceDigest(crossEvidence),
      cross_platform_matrix_digest:
        standaloneCrossPlatformMatrixDigest(crossMatrix),
      fault_report_digest: standaloneReports.fault.report_digest,
      minimal_std_report_digest: standaloneReports.minimal_std.report_digest,
      package_digest: portableRuntimePackageDigest(archive),
      package_manifest_digest:
        portableRuntimePackageManifestDigest(archive.manifest),
      package_tree_digest:
        portableRuntimePackageTreeDigest(archive.manifest.entries),
      portable_gate_digest:
        portableExecutionHardGateReportDigest(portableGate),
      portable_vm_report_digest: standaloneReports.portable_vm.report_digest,
      release_lock_digest: agentProjectReleaseLockDigest(releaseLock),
      semantic_gate_digest:
        standaloneSemanticPerformanceHardGateReportDigest(semanticGate),
      task_lifecycle_report_digest:
        standaloneReports.task_lifecycle.report_digest,
      toolchain_digest,
    },
    domains: [
      domain('execution', standaloneReports.portable_vm),
      domain('minimal-std', standaloneReports.minimal_std),
      domain('fault', standaloneReports.fault),
      domain('task-lifecycle', standaloneReports.task_lifecycle),
    ],
    error_protocol: {
      closed_set: true,
      expected_outcome_input: false,
      nested_result_schemas: [FAULT_RESULT_SCHEMA, TASK_RESULT_SCHEMA],
      schemas: [
        STANDALONE_PORTABLE_VM_ERROR_SCHEMA,
        STANDALONE_MINIMAL_STD_ERROR_SCHEMA,
        STANDALONE_FAULT_HOST_ERROR_SCHEMA,
      ],
      stable_code_field: 'code',
    },
    mismatch_budgets: policy.mismatch_budgets,
    profile: STANDALONE_RUNTIME_CONTRACT_PROFILE,
    receipt_protocol: {
      bound_fields: [
        'artifact_digest',
        'graph_revision',
        'provenance',
        'request_digest',
        'result_digest',
        'target_triple',
      ],
      digest_field: 'receipt_digest',
      expected_outcome_input: false,
      replay_binding: 'request+artifact+target+provenance+result',
      schemas: [
        STANDALONE_PORTABLE_VM_RECEIPT_SCHEMA,
        STANDALONE_MINIMAL_STD_RECEIPT_SCHEMA,
        STANDALONE_FAULT_HOST_RECEIPT_SCHEMA,
        STANDALONE_TASK_LIFECYCLE_RECEIPT_SCHEMA,
      ],
    },
    release_claims: [],
    release_status: policy.release_status,
    request_protocol: {
      authority_fields: COMMON_ARTIFACT_FIELDS,
      digest_field: 'request_digest',
      expected_outcome_input: false,
      oracle_binding: 'trusted-request-external-reference',
      schemas: [
        EXECUTION_REQUEST_SCHEMA,
        STANDALONE_MINIMAL_STD_REQUEST_SCHEMA,
        STANDALONE_FAULT_HOST_REQUEST_SCHEMA,
        STANDALONE_TASK_LIFECYCLE_REQUEST_SCHEMA,
      ],
    },
    schema: STANDALONE_RUNTIME_CONTRACT_SCHEMA,
  }
  return report
}

function domain(id, report) {
  return {
    id,
    report_digest: report.report_digest,
    report_schema: report.schema,
    workload_count: report.workloads.length,
  }
}

function validateInputs({
  crossEvidence,
  crossMatrix,
  package: archive,
  portableGate,
  releaseLock,
  semanticGate,
  standaloneReports,
  toolchain_digest,
  policy,
} = {}) {
  if (!plainObject(policy)
    || !exactShape(policy, [
      'artifact_protocol',
      'domains',
      'mismatch_budgets',
      'profile',
      'release_status',
      'schema',
    ])
    || policy.schema !== STANDALONE_RUNTIME_CONTRACT_POLICY_SCHEMA
    || policy.profile !== STANDALONE_RUNTIME_CONTRACT_PROFILE
    || policy.release_status !== RELEASE_STATUS
    || !plainObject(policy.artifact_protocol)
    || !exactShape(policy.artifact_protocol, [
      'digest_algorithm',
      'digest_field',
      'header_bytes',
      'max_payload_bytes',
      'version',
    ])
    || !canonicalEqual(policy.artifact_protocol, {
      digest_algorithm: 'sha256',
      digest_field: 'payload_digest',
      header_bytes: 44,
      max_payload_bytes: 65_535,
      version: 1,
    })
    || !canonicalEqual(policy.domains, [
      { id: 'execution', workload_count: 9 },
      { id: 'minimal-std', workload_count: 12 },
      { id: 'fault', workload_count: 13 },
      { id: 'task-lifecycle', workload_count: 14 },
    ])
    || !canonicalEqual(policy.mismatch_budgets, [
      { comparator: 'max', id: 'semantic_mismatch_count', threshold: 0 },
      { comparator: 'max', id: 'artifact_mismatch_count', threshold: 0 },
      { comparator: 'max', id: 'receipt_mismatch_count', threshold: 0 },
      { comparator: 'max', id: 'error_mismatch_count', threshold: 0 },
    ])) {
    return rejected('standalone-runtime-contract-policy-shape-mismatch')
  }
  if (!plainObject(releaseLock)
    || !exactShape(releaseLock, [
      'artifacts',
      'backend',
      'build_artifact',
      'graph_revision',
      'independent_review',
      'module_interfaces',
      'package_digest',
      'profile',
      'release',
      'rollback',
      'schema',
      'stage',
      'toolchain',
    ])
    || !plainObject(releaseLock.toolchain)
    || !DIGEST.test(releaseLock.toolchain.digest)
    || !DIGEST.test(toolchain_digest)
    || toolchain_digest !== releaseLock.toolchain.digest) {
    return rejected('standalone-runtime-contract-release-authority-mismatch')
  }
  if (!validatePackage(archive)) {
    return rejected('standalone-runtime-contract-package-authority-mismatch')
  }
  if (!validateReportSet(standaloneReports, releaseLock, toolchain_digest)) {
    return rejected('standalone-runtime-contract-report-authority-mismatch')
  }
  if (!validateCrossPlatform(crossMatrix, crossEvidence, archive, releaseLock, toolchain_digest)) {
    return rejected('standalone-runtime-contract-cross-platform-authority-mismatch')
  }
  if (!validateGate(portableGate, semanticGate, releaseLock, toolchain_digest)) {
    return rejected('standalone-runtime-contract-semantic-gate-authority-mismatch')
  }
  return { ok: true }
}

function validatePackage(archive) {
  return plainObject(archive)
    && exactShape(archive, ['entries', 'manifest', 'package_digest', 'schema'])
    && archive.schema === 're.portable-runtime-package@0.1.0'
    && DIGEST.test(archive.package_digest)
    && archive.package_digest === portableRuntimePackageDigest(archive)
    && plainObject(archive.manifest)
    && exactShape(archive.manifest, [
      'authorities',
      'conformance_entry',
      'entries',
      'format',
      'manifest_digest',
      'package',
      'pending',
      'policy_digest',
      'profile',
      'schema',
      'target',
      'tree_digest',
    ])
    && archive.manifest.manifest_digest
      === portableRuntimePackageManifestDigest(archive.manifest)
    && archive.manifest.tree_digest
      === portableRuntimePackageTreeDigest(archive.manifest.entries)
    && Array.isArray(archive.entries)
    && Array.isArray(archive.manifest.entries)
    && archive.entries.length === archive.manifest.entries.length
    && archive.entries.every((entry) => plainObject(entry)
      && exactShape(entry, ['content_base64', 'kind', 'mode', 'path']))
    && archive.manifest.entries.every((entry) => plainObject(entry)
      && exactShape(entry, ['digest', 'mode', 'path', 'size']))
}

function validateReportSet(reports, releaseLock, toolchain_digest) {
  if (!plainObject(reports)
    || !exactShape(reports, Object.keys(REPORTS))) {
    return false
  }
  return Object.entries(REPORTS).every(([name, definition]) => {
    const report = reports[name]
    if (!plainObject(report)
      || !exactShape(report, REPORT_KEYS[name])
      || report.schema !== definition.schema
      || report.profile !== definition.profile
      || report.status !== 'measured'
      || !Array.isArray(report.workloads)
      || report.workloads.length !== definition.workload_count
      || !DIGEST.test(report.report_digest)
      || report.report_digest !== definition.digest(report)) {
      return false
    }
    if (report.release_lock_digest !== undefined
      && report.release_lock_digest
        !== agentProjectReleaseLockDigest(releaseLock)) {
      return false
    }
    if (report.toolchain_digest !== undefined
      && report.toolchain_digest !== toolchain_digest) {
      return false
    }
    return true
  })
}

function validateCrossPlatform(
  matrix,
  evidence,
  archive,
  releaseLock,
  toolchain_digest,
) {
  return plainObject(matrix)
    && exactShape(matrix, [
      'authorities',
      'matrix_digest',
      'package_digest',
      'profile',
      'release_lock_digest',
      'schema',
      'status',
      'targets',
      'toolchain_digest',
    ])
    && matrix.schema === 're.standalone-cross-platform-matrix@0.1.0'
    && matrix.profile === 're.standalone-cross-platform-runner@0.1.0'
    && matrix.status === 'standalone-cross-platform-pending'
    && matrix.package_digest === archive.package_digest
    && matrix.release_lock_digest === agentProjectReleaseLockDigest(releaseLock)
    && matrix.toolchain_digest === toolchain_digest
    && DIGEST.test(matrix.matrix_digest)
    && matrix.matrix_digest === standaloneCrossPlatformMatrixDigest(matrix)
    && plainObject(evidence)
    && exactShape(evidence, [
      'claims',
      'evidence_digest',
      'matrix_digest',
      'measured_targets',
      'pending_targets',
      'schema',
      'status',
    ])
    && evidence.schema === 're.standalone-cross-platform-evidence@0.1.0'
    && evidence.status === 'partial'
    && evidence.matrix_digest === matrix.matrix_digest
    && evidence.matrix_digest === standaloneCrossPlatformMatrixDigest(matrix)
    && DIGEST.test(evidence.evidence_digest)
    && evidence.evidence_digest
      === standaloneCrossPlatformEvidenceDigest(evidence)
}

function validateGate(portableGate, semanticGate, releaseLock, toolchain_digest) {
  return validGate(
    portableGate,
    're.portable-execution-hard-gate-report@0.1.0',
    're.portable-execution-hard-gate@0.1.0',
    portableExecutionHardGateReportDigest,
  )
    && validGate(
      semanticGate,
      're.standalone-semantic-performance-hard-gate-report@0.1.0',
      're.standalone-semantic-performance-hard-gate@0.1.0',
      standaloneSemanticPerformanceHardGateReportDigest,
    )
    && portableGate.release_claims.length === 0
    && semanticGate.release_claims.length === 0
    && portableGate.status === 'semantic-frozen-performance-pending'
    && semanticGate.status === 'semantic-frozen-performance-pending'
    && semanticGate.authority.release_lock_digest
      === agentProjectReleaseLockDigest(releaseLock)
    && semanticGate.authority.toolchain_digest === toolchain_digest
}

function validGate(report, schema, profile, digest) {
  return plainObject(report)
    && DIGEST.test(report.report_digest)
    && report.schema === schema
    && report.profile === profile
    && report.report_digest === digest(report)
    && Array.isArray(report.release_claims)
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
