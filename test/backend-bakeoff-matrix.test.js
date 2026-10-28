import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const matrix = JSON.parse(await readFile(
  new URL('./fixtures/backend-bakeoff-matrix.json', import.meta.url),
  'utf8',
))

test('backend bake-off separates production candidates from semantic reference', () => {
  assert.equal(matrix.schema, 're.backend-bakeoff@0.2.0')
  assert.equal(matrix.status, 'contract-defined')
  assert.deepEqual(matrix.candidates.map(({ id }) => id), [
    'aot-llvm',
    'cranelift',
    'go-lowering',
    'jvm-bytecode',
    'node-reference',
  ])
  assert.equal(
    matrix.candidates.find(({ id }) => id === 'node-reference').role,
    'semantic-reference',
  )
  assert.ok(
    matrix.candidates
      .filter(({ id }) => id !== 'node-reference')
      .every(({ role }) => role === 'production-candidate'),
  )
})

test('memory contract permits immutable aliasing without requiring a copy', () => {
  assert.deepEqual(matrix.memory_contract, {
    backend_representation: 'internal-mutation-must-be-unobservable',
    cross_task_resource: 'typed-handle-with-declared-footprint',
    cross_task_value: 'immutable-share',
    forbidden_observable: [
      'data-race',
      'use-after-free',
      'uninitialized-read',
      'torn-read',
    ],
    immutable_aliasing: 'allowed-without-copy',
    mutable_state: 'opaque-resource-only',
    ordinary_value: 'observationally-immutable-after-construction',
    region_reference: 'cannot-outlive-owner',
  })
  assert.deepEqual(
    matrix.memory_probes.map(({ id }) => id),
    ['MEM-001', 'MEM-002', 'MEM-003', 'MEM-004'],
  )
})

test('every workload has explicit required axes from the matrix vocabulary', () => {
  const axes = new Set(matrix.axes)
  const workloadIds = matrix.workload_profiles.map(({ id }) => id)

  assert.ok(workloadIds.includes('task-100k'))
  assert.ok(workloadIds.includes('module-5000-clean-incremental'))
  assert.ok(matrix.axes.includes('clean_build_ms'))
  assert.ok(matrix.axes.includes('cancel_latency_p99_ms'))
  for (const workload of matrix.workload_profiles) {
    assert.ok(workload.required_axes.length > 0)
    assert.ok(workload.required_axes.every((axis) => axes.has(axis)))
  }
  assert.ok(matrix.candidate_axes.every((axis) => axes.has(axis)))
})

test('measurement protocol pins environment and keeps cold and warm separate', () => {
  assert.deepEqual(matrix.hard_gates, [
    'semantic-equivalence',
    'memory-safety-contract',
    'structured-cancellation',
    'exact-release-lock',
    'reproducible-artifact',
  ])
  assert.equal(matrix.measurement.hardware, 'digest-pinned')
  assert.equal(matrix.measurement.operating_system, 'digest-pinned')
  assert.equal(matrix.measurement.toolchain, 'digest-pinned')
  assert.equal(matrix.measurement.cold_and_warm, 'reported-separately')
})
