import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  taskContractDigest,
  taskIdentity,
  validateTaskContract,
} from '../src/toolchain/task-contract.js'

const corpus = JSON.parse(
  await readFile(new URL('./fixtures/task-replay-corpus.json', import.meta.url), 'utf8'),
)

test('task contract is typed, finite, and declaration-order independent', () => {
  const first = validateTaskContract(corpus.contract)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.schema, 're.task-contract@0.1.0')
  assert.equal(first.value.max_attempts, 3)
  const reordered = structuredClone(corpus.contract)
  reordered.retryable_errors.reverse()
  reordered.checkpoint.fields.reverse()
  assert.deepEqual(validateTaskContract(reordered), first)
  assert.equal(taskContractDigest(reordered), taskContractDigest(corpus.contract))
})

test('task identity binds agent, module, node, revision, input, and caller key', () => {
  const identity = taskIdentity(corpus.contract, corpus.request)
  assert.equal(identity.ok, true, JSON.stringify(identity))
  assert.equal(identity.value.agent, corpus.request.agent)
  assert.equal(identity.value.module, corpus.request.module)
  assert.equal(identity.value.node_uid, corpus.request.node_uid)
  assert.match(identity.value.task_id, /^sha256:[0-9a-f]{64}$/)
  const changed = structuredClone(corpus.request)
  changed.idempotency_key = 'expense-002'
  assert.notEqual(taskIdentity(corpus.contract, changed).value.task_id, identity.value.task_id)
})

test('task contract rejects unbounded retry, detached node, and extra fields', () => {
  const unbounded = structuredClone(corpus.contract)
  unbounded.max_attempts = Infinity
  assert.equal(validateTaskContract(unbounded).diagnostics[0].code, 'invalid-task-max-attempts')
  const detached = structuredClone(corpus.request)
  detached.node_uid = 'bbbbbbbbbbbbbbbbbbbbbbbbba'
  assert.equal(taskIdentity(corpus.contract, detached).diagnostics[0].code, 'detached-task')
  const extra = structuredClone(corpus.contract)
  extra.runtime = 'implicit'
  assert.equal(validateTaskContract(extra).diagnostics[0].code, 'unexpected-task-contract-field')
})

test('task contract rejects malformed checkpoint and retry policy', () => {
  const checkpoint = structuredClone(corpus.contract)
  checkpoint.checkpoint.fields = ['revision']
  assert.equal(validateTaskContract(checkpoint).diagnostics[0].code, 'invalid-task-checkpoint-fields')
  const schedule = structuredClone(corpus.contract)
  schedule.backoff_ms = [1]
  assert.equal(validateTaskContract(schedule).diagnostics[0].code, 'invalid-task-backoff-schedule')
  const error = structuredClone(corpus.contract)
  error.retryable_errors.push('timeout')
  assert.equal(validateTaskContract(error).diagnostics[0].code, 'duplicate-task-retryable-error')
})
