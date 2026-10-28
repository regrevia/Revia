import { createHash } from 'node:crypto'

export const PORTABLE_CONFORMANCE_MATRIX_SCHEMA =
  're.portable-conformance-matrix@0.1.0'
export const PORTABLE_CONFORMANCE_RUN_RECEIPT_SCHEMA =
  're.portable-conformance-run-receipt@0.1.0'
export const PORTABLE_CONFORMANCE_MATRIX_EVIDENCE_SCHEMA =
  're.portable-conformance-matrix-evidence@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const NODE_VERSION = /^v([0-9]+)\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u
const MATRIX_FIELDS = [
  'authorities',
  'bundle_digest',
  'bundle_path',
  'environments',
  'matrix_digest',
  'required_coverage',
  'schema',
  'status',
  'toolchain_digest',
]
const AUTHORITY_FIELDS = [
  'grammar_fuzz',
  'portable',
  'public_candidate',
  'tracked_tests',
]
const ENVIRONMENT_FIELDS = [
  'architecture',
  'id',
  'node_major',
  'platform',
]
const RECEIPT_FIELDS = [
  'bundle_digest',
  'environment',
  'grammar_fuzz',
  'matrix_digest',
  'portable',
  'public_candidate',
  'receipt_digest',
  'schema',
  'toolchain_digest',
  'tracked_tests',
]
const RECEIPT_ENVIRONMENT_FIELDS = [
  'architecture',
  'id',
  'node_major',
  'node_version',
  'platform',
]
const FUZZ_FIELDS = [
  'baseline_match',
  'crash_count',
  'iterations',
  'near_linear',
  'nondeterministic_count',
  'report_digest',
  'wrong_graph_count',
]
const PORTABLE_FIELDS = ['case_count', 'result_digest']
const PUBLIC_CANDIDATE_FIELDS = ['file_count', 'tree_digest', 'verified']
const TRACKED_TEST_FIELDS = [
  'selected_test_count',
  'selected_tests_digest',
  'status',
]
const EVIDENCE_FIELDS = [
  'evidence_digest',
  'matrix_digest',
  'pending_environments',
  'receipts',
  'schema',
  'status',
]
const REQUIRED_COVERAGE = [
  'grammar-fuzz',
  'portable-conformance',
  'public-candidate',
  'tracked-tests',
]

export function portableConformanceMatrixDigest(matrix) {
  if (!plainObject(matrix)) throw new TypeError('invalid portable conformance matrix')
  const { matrix_digest: ignored, ...content } = matrix
  return digest(content)
}

export function validatePortableConformanceMatrix(matrix) {
  const diagnostics = []
  if (!plainObject(matrix)
    || matrix.schema !== PORTABLE_CONFORMANCE_MATRIX_SCHEMA) {
    return rejected('portable-conformance-matrix-schema-mismatch')
  }
  exactFields(matrix, MATRIX_FIELDS, 'portable-conformance-matrix', diagnostics)
  if (matrix.status !== 'cross-platform-conformance-pending') {
    diagnostics.push({ code: 'portable-conformance-matrix-status-mismatch' })
  }
  if (typeof matrix.bundle_path !== 'string'
    || matrix.bundle_path.length === 0
    || matrix.bundle_path.startsWith('/')
    || matrix.bundle_path.includes('\\')
    || matrix.bundle_path.split('/').some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )) {
    diagnostics.push({ code: 'portable-conformance-matrix-bundle-path-invalid' })
  }
  for (const field of ['bundle_digest', 'toolchain_digest']) {
    if (!DIGEST.test(matrix[field])) {
      diagnostics.push({
        code: 'portable-conformance-matrix-digest-invalid',
        field,
      })
    }
  }
  validateAuthorities(matrix.authorities, diagnostics)
  if (!canonicalEqual(matrix.required_coverage, REQUIRED_COVERAGE)) {
    diagnostics.push({ code: 'portable-conformance-matrix-coverage-invalid' })
  }
  if (!Array.isArray(matrix.environments) || matrix.environments.length === 0) {
    diagnostics.push({ code: 'portable-conformance-matrix-environments-invalid' })
  } else {
    let previous = null
    for (const environment of matrix.environments) {
      validateEnvironment(environment, diagnostics)
      if (typeof environment?.id === 'string'
        && previous !== null
        && previous >= environment.id) {
        diagnostics.push({
          code: 'portable-conformance-matrix-environments-invalid',
        })
      }
      previous = environment?.id ?? previous
    }
  }
  if (matrix.matrix_digest !== portableConformanceMatrixDigest(matrix)) {
    diagnostics.push({ code: 'portable-conformance-matrix-digest-mismatch' })
  }
  return verificationResult(diagnostics)
}

export function createPortableConformanceRunReceipt({
  environment,
  grammarFuzz,
  matrix,
  portable,
  publicCandidate,
  trackedTests,
} = {}) {
  const matrixResult = validatePortableConformanceMatrix(matrix)
  if (!matrixResult.ok) return matrixResult
  const content = {
    bundle_digest: matrix.bundle_digest,
    environment,
    grammar_fuzz: grammarFuzz,
    matrix_digest: matrix.matrix_digest,
    portable,
    public_candidate: publicCandidate,
    schema: PORTABLE_CONFORMANCE_RUN_RECEIPT_SCHEMA,
    toolchain_digest: matrix.toolchain_digest,
    tracked_tests: trackedTests,
  }
  const receipt = {
    ...content,
    receipt_digest: digest(content),
  }
  const verified = verifyPortableConformanceRunReceipt(receipt, { matrix })
  return verified.ok ? { ok: true, value: receipt } : verified
}

export function verifyPortableConformanceRunReceipt(
  receipt,
  { matrix } = {},
) {
  const matrixResult = validatePortableConformanceMatrix(matrix)
  if (!matrixResult.ok) return matrixResult
  const diagnostics = []
  if (!plainObject(receipt)
    || receipt.schema !== PORTABLE_CONFORMANCE_RUN_RECEIPT_SCHEMA) {
    return rejected('portable-conformance-receipt-schema-mismatch')
  }
  exactFields(receipt, RECEIPT_FIELDS, 'portable-conformance-receipt', diagnostics)
  const environment = matrix.environments.find(
    ({ id }) => id === receipt.environment?.id,
  )
  if (environment === undefined
    || !plainObject(receipt.environment)
    || !exactShape(receipt.environment, RECEIPT_ENVIRONMENT_FIELDS)
    || receipt.environment.platform !== environment.platform
    || receipt.environment.architecture !== environment.architecture
    || receipt.environment.node_major !== environment.node_major
    || !validNodeVersion(
      receipt.environment.node_version,
      receipt.environment.node_major,
    )) {
    diagnostics.push({
      code: 'portable-conformance-receipt-environment-mismatch',
    })
  }
  if (receipt.matrix_digest !== matrix.matrix_digest
    || receipt.bundle_digest !== matrix.bundle_digest
    || receipt.toolchain_digest !== matrix.toolchain_digest) {
    diagnostics.push({ code: 'portable-conformance-receipt-digest-mismatch' })
  }
  validatePortable(receipt.portable, diagnostics)
  validateTrackedTests(receipt.tracked_tests, diagnostics)
  validateGrammarFuzz(receipt.grammar_fuzz, diagnostics)
  validatePublicCandidate(receipt.public_candidate, diagnostics)
  if (!canonicalEqual(receipt.portable, matrix.authorities.portable)
    || !canonicalEqual(
      receipt.tracked_tests,
      {
        ...matrix.authorities.tracked_tests,
        status: 0,
      },
    )
    || receipt.grammar_fuzz.iterations
      !== matrix.authorities.grammar_fuzz.iterations
    || receipt.grammar_fuzz.report_digest
      !== matrix.authorities.grammar_fuzz.report_digest
    || !canonicalEqual(
      receipt.public_candidate,
      {
        ...matrix.authorities.public_candidate,
        verified: true,
      },
    )) {
    diagnostics.push({ code: 'portable-conformance-receipt-digest-mismatch' })
  }
  const { receipt_digest: ignored, ...content } = receipt
  if (receipt.receipt_digest !== digest(content)) {
    diagnostics.push({ code: 'portable-conformance-receipt-digest-mismatch' })
  }
  return verificationResult(diagnostics)
}

export function createPortableConformanceMatrixEvidence({
  matrix,
  receipts,
} = {}) {
  const matrixResult = validatePortableConformanceMatrix(matrix)
  if (!matrixResult.ok) return matrixResult
  if (!Array.isArray(receipts)) {
    return rejected('portable-conformance-evidence-receipts-invalid')
  }
  const measured = new Set(receipts.map((receipt) => receipt?.environment?.id))
  const pending = matrix.environments
    .map(({ id }) => id)
    .filter((id) => !measured.has(id))
  const status = pending.length === 0 ? 'complete' : 'partial'
  const content = {
    matrix_digest: matrix.matrix_digest,
    pending_environments: pending,
    receipts,
    schema: PORTABLE_CONFORMANCE_MATRIX_EVIDENCE_SCHEMA,
    status,
  }
  const evidence = {
    ...content,
    evidence_digest: digest(content),
  }
  const verified = verifyPortableConformanceMatrixEvidence(
    evidence,
    { matrix },
  )
  return verified.ok ? { ok: true, value: evidence } : verified
}

export function mergePortableConformanceRunReceipt({
  evidence,
  matrix,
  receipt,
} = {}) {
  const matrixResult = validatePortableConformanceMatrix(matrix)
  if (!matrixResult.ok) return matrixResult
  const evidenceResult = verifyPortableConformanceMatrixEvidence(
    evidence,
    { matrix },
  )
  if (!evidenceResult.ok) return evidenceResult
  const receiptResult = verifyPortableConformanceRunReceipt(receipt, { matrix })
  if (!receiptResult.ok) return receiptResult

  const receipts = new Map(evidence.receipts.map((entry) => [
    entry.environment.id,
    entry,
  ]))
  receipts.set(receipt.environment.id, receipt)
  return createPortableConformanceMatrixEvidence({
    matrix,
    receipts: [...receipts.values()].sort((left, right) =>
      left.environment.id.localeCompare(right.environment.id)),
  })
}

export function verifyPortableConformanceMatrixEvidence(
  evidence,
  { matrix } = {},
) {
  const matrixResult = validatePortableConformanceMatrix(matrix)
  if (!matrixResult.ok) return matrixResult
  const diagnostics = []
  if (!plainObject(evidence)
    || evidence.schema !== PORTABLE_CONFORMANCE_MATRIX_EVIDENCE_SCHEMA) {
    return rejected('portable-conformance-evidence-schema-mismatch')
  }
  exactFields(evidence, EVIDENCE_FIELDS, 'portable-conformance-evidence', diagnostics)
  if (evidence.matrix_digest !== matrix.matrix_digest) {
    diagnostics.push({ code: 'portable-conformance-evidence-matrix-mismatch' })
  }
  const receiptIds = []
  if (!Array.isArray(evidence.receipts)) {
    diagnostics.push({ code: 'portable-conformance-evidence-receipts-invalid' })
  } else {
    for (const receipt of evidence.receipts) {
      const verified = verifyPortableConformanceRunReceipt(receipt, { matrix })
      if (!verified.ok) diagnostics.push(...verified.diagnostics)
      receiptIds.push(receipt?.environment?.id)
    }
  }
  const environmentIds = matrix.environments.map(({ id }) => id)
  const pending = Array.isArray(evidence.pending_environments)
    ? evidence.pending_environments
    : []
  const expectedStatus = Array.isArray(pending) && pending.length === 0
    ? 'complete'
    : 'partial'
  if (!Array.isArray(evidence.pending_environments)
    || !sortedUniqueText(receiptIds)
    || !sortedUniqueText(pending)
    || evidence.status !== expectedStatus
    || !sameSet([...receiptIds, ...pending], environmentIds)
    || receiptIds.some((id) => pending.includes(id))) {
    diagnostics.push({
      code: 'portable-conformance-evidence-partition-mismatch',
    })
  }
  const { evidence_digest: ignored, ...content } = evidence
  if (evidence.evidence_digest !== digest(content)) {
    diagnostics.push({ code: 'portable-conformance-evidence-digest-mismatch' })
  }
  return diagnostics.length === 0
    ? {
        ok: true,
        value: {
          pending_environments: [...pending],
          status: evidence.status,
        },
      }
    : { diagnostics, ok: false }
}

export function verifyPortableConformanceReleaseEvidence(
  evidence,
  { matrix } = {},
) {
  const verified = verifyPortableConformanceMatrixEvidence(evidence, { matrix })
  if (!verified.ok) return verified
  if (evidence.receipts.length === 0) {
    return rejected('portable-conformance-release-evidence-unmeasured')
  }
  return {
    ok: true,
    value: {
      measured_environments: evidence.receipts.map(
        ({ environment }) => environment.id,
      ),
      pending_environments: verified.value.pending_environments,
      status: verified.value.status,
    },
  }
}

function validateEnvironment(environment, diagnostics) {
  if (!plainObject(environment)
    || !exactShape(environment, ENVIRONMENT_FIELDS)
    || typeof environment.id !== 'string'
    || environment.id.length === 0
    || !['darwin', 'linux'].includes(environment.platform)
    || !['arm64', 'x64'].includes(environment.architecture)
    || !Number.isSafeInteger(environment.node_major)
    || environment.node_major < 22
    || environment.id !== [
      environment.platform,
      environment.architecture,
      `node-${environment.node_major}`,
    ].join('-')) {
    diagnostics.push({ code: 'portable-conformance-matrix-environment-invalid' })
  }
}

function validateAuthorities(authorities, diagnostics) {
  if (!plainObject(authorities)
    || !exactShape(authorities, AUTHORITY_FIELDS)) {
    diagnostics.push({ code: 'portable-conformance-matrix-authorities-invalid' })
    return
  }
  const grammarFuzz = authorities.grammar_fuzz
  const portable = authorities.portable
  const publicCandidate = authorities.public_candidate
  const trackedTests = authorities.tracked_tests
  if (!plainObject(grammarFuzz)
    || !exactShape(grammarFuzz, ['iterations', 'report_digest'])
    || !Number.isSafeInteger(grammarFuzz.iterations)
    || grammarFuzz.iterations <= 0
    || !DIGEST.test(grammarFuzz.report_digest)
    || !plainObject(portable)
    || !exactShape(portable, PORTABLE_FIELDS)
    || !Number.isSafeInteger(portable.case_count)
    || portable.case_count <= 0
    || !DIGEST.test(portable.result_digest)
    || !plainObject(publicCandidate)
    || !exactShape(publicCandidate, ['file_count', 'tree_digest'])
    || !Number.isSafeInteger(publicCandidate.file_count)
    || publicCandidate.file_count <= 0
    || !DIGEST.test(publicCandidate.tree_digest)
    || !plainObject(trackedTests)
    || !exactShape(trackedTests, [
      'selected_test_count',
      'selected_tests_digest',
    ])
    || !Number.isSafeInteger(trackedTests.selected_test_count)
    || trackedTests.selected_test_count <= 0
    || !DIGEST.test(trackedTests.selected_tests_digest)) {
    diagnostics.push({ code: 'portable-conformance-matrix-authorities-invalid' })
  }
}

function validatePortable(value, diagnostics) {
  if (!plainObject(value)
    || !exactShape(value, PORTABLE_FIELDS)
    || !Number.isSafeInteger(value.case_count)
    || value.case_count <= 0
    || !DIGEST.test(value.result_digest)) {
    diagnostics.push({ code: 'portable-conformance-receipt-portable-invalid' })
  }
}

function validateTrackedTests(value, diagnostics) {
  if (!plainObject(value)
    || !exactShape(value, TRACKED_TEST_FIELDS)
    || value.status !== 0
    || !Number.isSafeInteger(value.selected_test_count)
    || value.selected_test_count <= 0
    || !DIGEST.test(value.selected_tests_digest)) {
    diagnostics.push({ code: 'portable-conformance-receipt-tests-failed' })
  }
}

function validateGrammarFuzz(value, diagnostics) {
  if (!plainObject(value)
    || !exactShape(value, FUZZ_FIELDS)
    || value.baseline_match !== true
    || value.near_linear !== true
    || !Number.isSafeInteger(value.iterations)
    || value.iterations <= 0
    || !zeroCount(value.crash_count)
    || !zeroCount(value.nondeterministic_count)
    || !zeroCount(value.wrong_graph_count)
    || !DIGEST.test(value.report_digest)) {
    diagnostics.push({ code: 'portable-conformance-receipt-fuzz-failed' })
  }
}

function validatePublicCandidate(value, diagnostics) {
  if (!plainObject(value)
    || !exactShape(value, PUBLIC_CANDIDATE_FIELDS)
    || value.verified !== true
    || !Number.isSafeInteger(value.file_count)
    || value.file_count <= 0
    || !DIGEST.test(value.tree_digest)) {
    diagnostics.push({
      code: 'portable-conformance-receipt-public-candidate-failed',
    })
  }
}

function zeroCount(value) {
  return Number.isSafeInteger(value) && value === 0
}

function validNodeVersion(value, major) {
  const match = typeof value === 'string' ? NODE_VERSION.exec(value) : null
  return match !== null && Number(match[1]) === major
}

function exactFields(value, expected, namespace, diagnostics) {
  if (!plainObject(value)) return
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      diagnostics.push({ code: `${namespace}-unexpected-field`, field })
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({ code: `${namespace}-missing-field`, field })
    }
  }
}

function exactShape(value, expected) {
  return plainObject(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(expected)
}

function sortedUniqueText(value) {
  return Array.isArray(value)
    && value.every((entry, index) => (
      typeof entry === 'string'
      && entry.length > 0
      && (index === 0 || value[index - 1] < entry)
    ))
}

function sameSet(actual, expected) {
  return sortedUniqueText([...actual].sort())
    && canonicalJson([...actual].sort()) === canonicalJson(expected)
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
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

function verificationResult(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
