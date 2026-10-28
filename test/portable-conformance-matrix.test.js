import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

let matrixApi
try {
  matrixApi = await import('../src/toolchain/portable-conformance-matrix.js')
} catch {
  matrixApi = null
}

const digest = (character) => `sha256:${character.repeat(64)}`

test('portable conformance matrix partitions measured and pending environments exactly', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const receipt = fixtureReceipt(matrix, 'darwin-arm64-node-24')
  const evidence = fixtureEvidence(matrix, [receipt], [
    'darwin-arm64-node-22',
    'linux-x64-node-22',
    'linux-x64-node-24',
  ])

  assert.deepEqual(matrixApi.validatePortableConformanceMatrix(matrix), { ok: true })
  assert.deepEqual(matrixApi.verifyPortableConformanceMatrixEvidence(
    evidence,
    { matrix },
  ), {
    ok: true,
    value: {
      pending_environments: [
        'darwin-arm64-node-22',
        'linux-x64-node-22',
        'linux-x64-node-24',
      ],
      status: 'partial',
    },
  })
})

test('portable conformance matrix rejects identity, result and partition drift', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const receipt = fixtureReceipt(matrix, 'darwin-arm64-node-24')
  const evidence = fixtureEvidence(matrix, [receipt], [
    'darwin-arm64-node-22',
    'linux-x64-node-22',
    'linux-x64-node-24',
  ])

  for (const [label, mutate, code] of [
    [
      'undeclared Node major',
      (value) => { value.receipts[0].environment.node_major = 23 },
      'portable-conformance-receipt-environment-mismatch',
    ],
    [
      'portable result digest',
      (value) => { value.receipts[0].portable.result_digest = digest('f') },
      'portable-conformance-receipt-digest-mismatch',
    ],
    [
      'duplicate environment',
      (value) => { value.pending_environments.push('darwin-arm64-node-24') },
      'portable-conformance-evidence-partition-mismatch',
    ],
    [
      'missing environment',
      (value) => { value.pending_environments.pop() },
      'portable-conformance-evidence-partition-mismatch',
    ],
    [
      'unknown environment',
      (value) => {
        value.pending_environments[0] = 'linux-arm64-node-24'
        value.pending_environments.sort()
      },
      'portable-conformance-evidence-partition-mismatch',
    ],
    [
      'duplicate receipt',
      (value) => { value.receipts.push(structuredClone(value.receipts[0])) },
      'portable-conformance-evidence-partition-mismatch',
    ],
    [
      'fuzz failure',
      (value) => { value.receipts[0].grammar_fuzz.crash_count = 1 },
      'portable-conformance-receipt-fuzz-failed',
    ],
    [
      'candidate tree drift',
      (value) => {
        value.receipts[0].public_candidate.tree_digest = digest('e')
      },
      'portable-conformance-receipt-digest-mismatch',
    ],
  ]) {
    const changed = structuredClone(evidence)
    mutate(changed)
    refreshReceiptDigest(changed.receipts[0])
    refreshEvidenceDigest(changed)

    const result = matrixApi.verifyPortableConformanceMatrixEvidence(
      changed,
      { matrix },
    )

    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), label)
  }
})

test('portable conformance matrix rejects authority and coverage drift', () => {
  assert.notEqual(matrixApi, null)

  for (const [label, mutate, code] of [
    [
      'coverage removal',
      (value) => { value.required_coverage.pop() },
      'portable-conformance-matrix-coverage-invalid',
    ],
    [
      'coverage addition',
      (value) => { value.required_coverage.push('native-backend') },
      'portable-conformance-matrix-coverage-invalid',
    ],
    [
      'tracked inventory drift',
      (value) => { value.authorities.tracked_tests.selected_test_count += 1 },
      'portable-conformance-matrix-digest-mismatch',
    ],
  ]) {
    const changed = structuredClone(fixtureMatrix())
    mutate(changed)

    const result = matrixApi.validatePortableConformanceMatrix(changed)

    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), label)
  }
})

test('portable conformance evidence rejects malformed pending without throwing', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const receipt = fixtureReceipt(matrix, 'darwin-arm64-node-24')
  const evidence = fixtureEvidence(matrix, [receipt], [])
  evidence.pending_environments = null
  refreshEvidenceDigest(evidence)

  assert.deepEqual(
    matrixApi.verifyPortableConformanceMatrixEvidence(evidence, { matrix }),
    {
      diagnostics: [{
        code: 'portable-conformance-evidence-partition-mismatch',
      }],
      ok: false,
    },
  )
})

test('portable conformance release evidence requires measured receipts without host identity', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const measured = fixtureEvidence(
    matrix,
    [fixtureReceipt(matrix, 'darwin-arm64-node-24')],
    [
      'darwin-arm64-node-22',
      'linux-x64-node-22',
      'linux-x64-node-24',
    ],
  )
  assert.deepEqual(
    matrixApi.verifyPortableConformanceReleaseEvidence(measured, { matrix }),
    {
      ok: true,
      value: {
        measured_environments: ['darwin-arm64-node-24'],
        pending_environments: [
          'darwin-arm64-node-22',
          'linux-x64-node-22',
          'linux-x64-node-24',
        ],
        status: 'partial',
      },
    },
  )

  const allPending = fixtureEvidence(
    matrix,
    [],
    matrix.environments.map(({ id }) => id),
  )
  const rejected = matrixApi.verifyPortableConformanceReleaseEvidence(
    allPending,
    { matrix },
  )
  assert.equal(rejected.ok, false)
  assert.deepEqual(rejected.diagnostics, [{
    code: 'portable-conformance-release-evidence-unmeasured',
  }])
})

test('portable conformance receipt merge preserves other environments and replaces current', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const node22 = fixtureReceipt(matrix, 'darwin-arm64-node-22')
  const node24 = fixtureReceipt(matrix, 'darwin-arm64-node-24')
  const first = fixtureEvidence(matrix, [node24], [
    'darwin-arm64-node-22',
    'linux-x64-node-22',
    'linux-x64-node-24',
  ])

  const merged = matrixApi.mergePortableConformanceRunReceipt({
    evidence: first,
    matrix,
    receipt: node22,
  })

  assert.equal(merged.ok, true)
  assert.deepEqual(
    merged.value.receipts.map(({ environment }) => environment.id),
    ['darwin-arm64-node-22', 'darwin-arm64-node-24'],
  )
  assert.deepEqual(merged.value.pending_environments, [
    'linux-x64-node-22',
    'linux-x64-node-24',
  ])

  const replacedNode24 = structuredClone(node24)
  replacedNode24.environment.node_version = 'v24.17.0'
  refreshReceiptDigest(replacedNode24)
  const replaced = matrixApi.mergePortableConformanceRunReceipt({
    evidence: merged.value,
    matrix,
    receipt: replacedNode24,
  })

  assert.equal(replaced.ok, true)
  assert.deepEqual(
    replaced.value.receipts.map(({ environment }) => ({
      id: environment.id,
      version: environment.node_version,
    })),
    [
      { id: 'darwin-arm64-node-22', version: 'v22.16.0' },
      { id: 'darwin-arm64-node-24', version: 'v24.17.0' },
    ],
  )
})

test('portable conformance receipt merge rejects existing and incoming drift', () => {
  assert.notEqual(matrixApi, null)

  const matrix = fixtureMatrix()
  const node24 = fixtureReceipt(matrix, 'darwin-arm64-node-24')
  const evidence = fixtureEvidence(matrix, [node24], [
    'darwin-arm64-node-22',
    'linux-x64-node-22',
    'linux-x64-node-24',
  ])

  const driftedEvidence = structuredClone(evidence)
  driftedEvidence.receipts[0].portable.result_digest = digest('f')
  refreshReceiptDigest(driftedEvidence.receipts[0])
  refreshEvidenceDigest(driftedEvidence)
  const existingDrift = matrixApi.mergePortableConformanceRunReceipt({
    evidence: driftedEvidence,
    matrix,
    receipt: fixtureReceipt(matrix, 'darwin-arm64-node-22'),
  })
  assert.equal(existingDrift.ok, false)
  assert.ok(existingDrift.diagnostics.some(
    ({ code }) => code === 'portable-conformance-receipt-digest-mismatch',
  ))

  const unknownReceipt = structuredClone(node24)
  unknownReceipt.environment = {
    architecture: 'arm64',
    id: 'linux-arm64-node-24',
    node_major: 24,
    node_version: 'v24.16.0',
    platform: 'linux',
  }
  refreshReceiptDigest(unknownReceipt)
  const incomingDrift = matrixApi.mergePortableConformanceRunReceipt({
    evidence,
    matrix,
    receipt: unknownReceipt,
  })
  assert.equal(incomingDrift.ok, false)
  assert.ok(incomingDrift.diagnostics.some(
    ({ code }) => code === 'portable-conformance-receipt-environment-mismatch',
  ))
})

function fixtureMatrix() {
  const matrix = {
    authorities: {
      grammar_fuzz: {
        iterations: 1_000_000,
        report_digest: digest('b'),
      },
      portable: {
        case_count: 9,
        result_digest: digest('c'),
      },
      public_candidate: {
        file_count: 297,
        tree_digest: digest('d'),
      },
      tracked_tests: {
        selected_test_count: 95,
        selected_tests_digest: digest('8'),
      },
    },
    bundle_digest: digest('a'),
    bundle_path: 'test/fixtures/portable-conformance.json',
    environments: [
      environment('darwin-arm64-node-22', 'darwin', 'arm64', 22),
      environment('darwin-arm64-node-24', 'darwin', 'arm64', 24),
      environment('linux-x64-node-22', 'linux', 'x64', 22),
      environment('linux-x64-node-24', 'linux', 'x64', 24),
    ],
    required_coverage: [
      'grammar-fuzz',
      'portable-conformance',
      'public-candidate',
      'tracked-tests',
    ],
    schema: 're.portable-conformance-matrix@0.1.0',
    status: 'cross-platform-conformance-pending',
    toolchain_digest: digest('9'),
  }
  return {
    ...matrix,
    matrix_digest: canonicalDigest(matrix),
  }
}

function fixtureReceipt(matrix, environmentId) {
  const environment = matrix.environments.find(({ id }) => id === environmentId)
  const receipt = {
    bundle_digest: matrix.bundle_digest,
    environment: {
      architecture: environment.architecture,
      id: environment.id,
      node_major: environment.node_major,
      node_version: `v${environment.node_major}.16.0`,
      platform: environment.platform,
    },
    grammar_fuzz: {
      baseline_match: true,
      crash_count: 0,
      iterations: 1_000_000,
      near_linear: true,
      nondeterministic_count: 0,
      report_digest: digest('b'),
      wrong_graph_count: 0,
    },
    matrix_digest: matrix.matrix_digest,
    portable: {
      case_count: 9,
      result_digest: digest('c'),
    },
    public_candidate: {
      file_count: 297,
      tree_digest: digest('d'),
      verified: true,
    },
    schema: 're.portable-conformance-run-receipt@0.1.0',
    tracked_tests: {
      selected_test_count: 95,
      selected_tests_digest: digest('8'),
      status: 0,
    },
    toolchain_digest: matrix.toolchain_digest,
  }
  return {
    ...receipt,
    receipt_digest: canonicalDigest(receipt),
  }
}

function fixtureEvidence(matrix, receipts, pendingEnvironments) {
  const evidence = {
    matrix_digest: matrix.matrix_digest,
    pending_environments: pendingEnvironments,
    receipts,
    schema: 're.portable-conformance-matrix-evidence@0.1.0',
    status: 'partial',
  }
  return {
    ...evidence,
    evidence_digest: canonicalDigest(evidence),
  }
}

function environment(id, platform, architecture, nodeMajor) {
  return { architecture, id, node_major: nodeMajor, platform }
}

function refreshReceiptDigest(receipt) {
  const { receipt_digest: ignored, ...content } = receipt
  receipt.receipt_digest = canonicalDigest(content)
}

function refreshEvidenceDigest(evidence) {
  const { evidence_digest: ignored, ...content } = evidence
  evidence.evidence_digest = canonicalDigest(content)
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
