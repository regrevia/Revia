import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { taskIdentity } from '../src/toolchain/task-contract.js'
import { executeTask } from '../src/toolchain/task-runtime.js'

const corpus = JSON.parse(
  await readFile(new URL('./fixtures/task-replay-corpus.json', import.meta.url), 'utf8'),
)

test('task runtime retries transient errors with finite deterministic backoff', async () => {
  const effects = new Map()
  const calls = []
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects,
    perform: async ({ attempt }) => {
      calls.push(attempt)
      if (attempt < 3) {
        return {
          checkpoint: { cursor: attempt },
          error: { code: 'timeout', message: 'temporary' },
          kind: 'error',
        }
      }
      return {
        effect: { key: 'expense:expense-001', payload: { posted: true } },
        kind: 'success',
        output: { approved: true },
      }
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.outcome, 'succeeded')
  assert.deepEqual(calls, [1, 2, 3])
  assert.deepEqual(result.value.trace.map(({ kind, backoff_ms }) => [kind, backoff_ms]), [
    ['attempt-start', 0],
    ['attempt-error', undefined],
    ['retry', undefined],
    ['attempt-start', 10],
    ['attempt-error', undefined],
    ['retry', undefined],
    ['attempt-start', 20],
    ['success', undefined],
  ])
})

test('permanent errors stop without implicit retry', async () => {
  let calls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects: new Map(),
    perform: async () => {
      calls += 1
      return {
        checkpoint: {},
        error: { code: 'validation', message: 'permanent' },
        kind: 'error',
      }
    },
  })
  assert.equal(result.value.outcome, 'failed')
  assert.equal(calls, 1)
})

test('replay does not duplicate committed effects and duplicate keys fail closed', async () => {
  const effects = new Map()
  let calls = 0
  const perform = async () => {
    calls += 1
    return {
      effect: { key: 'effect-1', payload: { committed: true } },
      kind: 'success',
      output: { ok: true },
    }
  }
  const first = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null, checkpoint: null, effects, perform,
  })
  const replay = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null, checkpoint: null, effects, perform,
  })
  assert.equal(first.value.replayed, false)
  assert.equal(replay.value.replayed, true)
  assert.equal(calls, 1)
  const other = structuredClone(corpus.request)
  other.idempotency_key = 'other'
  const conflict = await executeTask(corpus.contract, other, {
    cancel_at: null, checkpoint: null, effects,
    perform: async () => ({
      effect: { key: 'effect-1', payload: { committed: false } },
      kind: 'success',
      output: { ok: false },
    }),
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.diagnostics[0].code, 'duplicate-effect-key')
})

test('checkpoint replay, cancellation, and cancel race are explicit', async () => {
  const identity = taskIdentity(corpus.contract, corpus.request).value
  let resumedAttempt = 0
  const resumed = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: {
      attempt: 1,
      data: { cursor: 1 },
      input_digest: identity.input_digest,
      revision: identity.revision,
      state: 'retrying',
      task_id: identity.task_id,
    },
    effects: new Map(),
    perform: async ({ attempt }) => {
      resumedAttempt = attempt
      return {
        effect: { key: 'checkpoint-effect', payload: {} },
        kind: 'success',
        output: { resumed: true },
      }
    },
  })
  assert.equal(resumed.value.outcome, 'succeeded')
  assert.equal(resumedAttempt, 2)
  const stale = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: {
      attempt: 1,
      data: {},
      input_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      revision: 'old',
      state: 'retrying',
      task_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    effects: new Map(),
    perform: async () => ({ effect: null, kind: 'success', output: {} }),
  })
  assert.equal(stale.diagnostics[0].code, 'stale-task-checkpoint')
  const extraCheckpointField = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: {
      attempt: 1,
      data: { cursor: 1, injected: true },
      input_digest: identity.input_digest,
      revision: identity.revision,
      state: 'retrying',
      task_id: identity.task_id,
    },
    effects: new Map(),
    perform: async () => ({ effect: null, kind: 'success', output: {} }),
  })
  assert.equal(extraCheckpointField.diagnostics[0].code, 'unexpected-task-retry-checkpoint-data-field')
  const before = await executeTask(corpus.contract, corpus.request, {
    cancel_at: 'before_start', checkpoint: null, effects: new Map(),
    perform: async () => { throw new Error('must not start') },
  })
  assert.equal(before.value.outcome, 'cancelled')
  const after = await executeTask(corpus.contract, corpus.request, {
    cancel_at: 'after_start', checkpoint: null, effects: new Map(),
    perform: async () => ({ effect: null, kind: 'success', output: {} }),
  })
  assert.equal(after.value.outcome, 'cancelled')
  const winningRace = await executeTask(corpus.contract, corpus.request, {
    cancel_at: 'after_start', checkpoint: null, effects: new Map(),
    perform: async () => ({
      effect: { key: 'race-effect', payload: {} },
      kind: 'success',
      output: { committed: true },
    }),
  })
  assert.equal(winningRace.value.outcome, 'succeeded')
})

test('in-flight deadline waits cooperative cleanup, closes once, and cannot late-commit', async () => {
  const effects = new Map()
  let closeCalls = 0
  let clearCalls = 0
  let fireDeadline
  let performerStarted
  const started = new Promise((resolve) => { performerStarted = resolve })

  const resultPromise = executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => { clearCalls += 1 },
    effects,
    perform: async ({ signal }) => {
      performerStarted()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {
        effect: { key: 'late-effect', payload: { committed: true } },
        kind: 'success',
        output: { approved: true },
      }
    },
    resource: {
      close: async () => { closeCalls += 1 },
    },
    setTimeoutImpl: (callback) => {
      fireDeadline = callback
      return { timer: 'deadline' }
    },
    timeout_ms: 25,
  })

  const startup = await Promise.race([
    started.then(() => 'started'),
    resultPromise.then(() => 'settled'),
  ])
  assert.equal(startup, 'started')
  fireDeadline()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'cancelled')
  assert.equal(result.value.cancel_reason, 'timeout')
  assert.equal(effects.size, 0)
  assert.equal(closeCalls, 1)
  assert.equal(clearCalls, 1)
  assert.deepEqual(result.value.trace.map(({ kind }) => kind), [
    'attempt-start',
    'cancel-after-start',
    'resource-close',
  ])
})

test('performer host fault still clears deadline and closes the resource once', async () => {
  let closeCalls = 0
  let clearCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => { clearCalls += 1 },
    effects: new Map(),
    perform: async () => {
      throw new Error('private performer fault')
    },
    resource: {
      close: async () => {
        closeCalls += 1
        throw new Error('private registration rollback close fault')
      },
    },
    setTimeoutImpl: () => ({ timer: 'deadline' }),
    timeout_ms: 25,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'task-runtime-failure' }],
    ok: false,
  })
  assert.equal(closeCalls, 1)
  assert.equal(clearCalls, 1)
})

test('parent cancellation wins a later timeout and removes its listener once', async () => {
  const effects = new Map()
  const parent = new AbortController()
  let clearCalls = 0
  let fireDeadline
  let performerStarted
  const started = new Promise((resolve) => { performerStarted = resolve })
  const resultPromise = executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => { clearCalls += 1 },
    effects,
    perform: async ({ signal }) => {
      performerStarted()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return {
        effect: { key: 'late-parent-effect', payload: {} },
        kind: 'success',
        output: { approved: true },
      }
    },
    setTimeoutImpl: (callback) => {
      fireDeadline = callback
      return { timer: 'deadline' }
    },
    signal: parent.signal,
    timeout_ms: 25,
  })

  await started
  parent.abort()
  fireDeadline()
  const result = await resultPromise

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'cancelled')
  assert.equal(result.value.cancel_reason, 'parent')
  assert.equal(effects.size, 0)
  assert.equal(clearCalls, 1)
  assert.equal(result.value.trace.filter(({ kind }) => kind === 'cancel-after-start').length, 1)
})

test('checkpoint rejection still clears deadline and closes the accepted resource', async () => {
  let closeCalls = 0
  let clearCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: {
      attempt: 1,
      data: {},
      input_digest: `sha256:${'a'.repeat(64)}`,
      revision: 'stale',
      state: 'retrying',
      task_id: `sha256:${'b'.repeat(64)}`,
    },
    clearTimeoutImpl: () => { clearCalls += 1 },
    effects: new Map(),
    perform: async () => {
      throw new Error('performer must not start')
    },
    resource: {
      close: async () => { closeCalls += 1 },
    },
    setTimeoutImpl: () => ({ timer: 'deadline' }),
    timeout_ms: 25,
  })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'stale-task-checkpoint')
  assert.equal(closeCalls, 1)
  assert.equal(clearCalls, 1)
})

test('an already-aborted parent signal cancels before the performer starts', async () => {
  const parent = new AbortController()
  parent.abort()
  let performerCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects: new Map(),
    perform: async () => {
      performerCalls += 1
      return {
        effect: { key: 'must-not-commit', payload: {} },
        kind: 'success',
        output: {},
      }
    },
    signal: parent.signal,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'cancelled')
  assert.equal(result.value.cancel_reason, 'parent')
  assert.equal(performerCalls, 0)
  assert.deepEqual(result.value.trace.map(({ kind }) => kind), ['cancel-before-start'])
})

test('resource close failure rejects a would-be successful terminal result', async () => {
  const effects = new Map()
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects,
    perform: async () => ({
      effect: { key: 'committed-before-close', payload: {} },
      kind: 'success',
      output: { approved: true },
    }),
    resource: {
      close: async () => {
        throw new Error('private close fault')
      },
    },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'task-resource-close-failure' }],
    ok: false,
  })
  assert.equal(effects.size, 0)
})

test('task lifecycle snapshots signal capabilities once before listener registration', async () => {
  let addReads = 0
  let removeReads = 0
  let abortedReads = 0
  let addCalls = 0
  let removeCalls = 0
  let performerCalls = 0
  const parentSignal = {
    get addEventListener() {
      addReads += 1
      if (addReads === 1) return () => { addCalls += 1 }
      throw new Error('private signal add accessor drift')
    },
    get removeEventListener() {
      removeReads += 1
      if (removeReads === 1) return () => { removeCalls += 1 }
      throw new Error('private signal remove accessor drift')
    },
    get aborted() {
      abortedReads += 1
      if (abortedReads === 1) return false
      throw new Error('private signal aborted accessor drift')
    },
  }
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects: new Map(),
    perform: async () => {
      performerCalls += 1
      return {
        effect: { key: 'snapshotted-signal', payload: {} },
        kind: 'success',
        output: {},
      }
    },
    signal: parentSignal,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'succeeded')
  assert.equal(addReads, 1)
  assert.equal(removeReads, 1)
  assert.equal(abortedReads, 1)
  assert.equal(addCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(performerCalls, 1)
})

test('task lifecycle listener registration failure rolls back the listener and resource', async () => {
  const listeners = new Set()
  let removeCalls = 0
  let closeCalls = 0
  let timerCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      listeners.add(listener)
      throw new Error('private signal registration fault')
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      removeCalls += 1
      listeners.delete(listener)
    },
  }
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => {},
    effects: new Map(),
    perform: async () => {
      throw new Error('performer must not start')
    },
    resource: {
      close: async () => { closeCalls += 1 },
    },
    setTimeoutImpl: () => {
      timerCalls += 1
      return { timer: true }
    },
    signal: parentSignal,
    timeout_ms: 10,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-task-signal' }],
    ok: false,
  })
  assert.equal(removeCalls, 1)
  assert.equal(listeners.size, 0)
  assert.equal(timerCalls, 0)
  assert.equal(closeCalls, 1)
})

test('task lifecycle cleanup attempts timer, signal, and resource cleanup while preserving the first fault', async () => {
  let clearCalls = 0
  let removeCalls = 0
  let closeCalls = 0
  const parentSignal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      removeCalls += 1
      throw new Error('private signal cleanup fault')
    },
  }
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => {
      clearCalls += 1
      throw new Error('private timer cleanup fault')
    },
    effects: new Map(),
    perform: async () => {
      throw new Error('private performer fault')
    },
    resource: {
      close: async () => {
        closeCalls += 1
        throw new Error('private resource cleanup fault')
      },
    },
    setTimeoutImpl: () => ({ timer: true }),
    signal: parentSignal,
    timeout_ms: 10,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'task-runtime-failure' }],
    ok: false,
  })
  assert.equal(clearCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(closeCalls, 1)
})

test('task terminal cleanup preserves the first cleanup diagnostic and rolls back a new effect', async () => {
  const effects = new Map()
  let clearCalls = 0
  let removeCalls = 0
  let closeCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => {
      clearCalls += 1
      throw new Error('private timer terminal cleanup fault')
    },
    effects,
    perform: async () => ({
      effect: { key: 'cleanup-rollback-effect', payload: {} },
      kind: 'success',
      output: {},
    }),
    resource: {
      close: async () => {
        closeCalls += 1
        throw new Error('private resource terminal cleanup fault')
      },
    },
    setTimeoutImpl: () => ({ timer: true }),
    signal: {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        removeCalls += 1
        throw new Error('private signal terminal cleanup fault')
      },
    },
    timeout_ms: 10,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-task-timeout' }],
    ok: false,
  })
  assert.equal(clearCalls, 1)
  assert.equal(removeCalls, 1)
  assert.equal(closeCalls, 1)
  assert.equal(effects.size, 0)
})

test('task resource close uses a construction-time bound method snapshot', async () => {
  let closeReads = 0
  let closeCalls = 0
  const resource = {
    get close() {
      closeReads += 1
      if (closeReads === 1) {
        return function () {
          assert.equal(this, resource)
          closeCalls += 1
        }
      }
      throw new Error('private close accessor drift')
    },
  }
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    effects: new Map(),
    perform: async () => ({
      effect: { key: 'snapshotted-resource', payload: {} },
      kind: 'success',
      output: {},
    }),
    resource,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'succeeded')
  assert.equal(closeReads, 1)
  assert.equal(closeCalls, 1)
})

test('task timer setup failure cleans the listener and resource without replacing the timer diagnostic', async () => {
  let removeCalls = 0
  let closeCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: () => {},
    effects: new Map(),
    perform: async () => {
      throw new Error('performer must not start')
    },
    resource: {
      close: async () => {
        closeCalls += 1
        throw new Error('private timer rollback close fault')
      },
    },
    setTimeoutImpl: () => {
      throw new Error('private timer setup fault')
    },
    signal: {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        removeCalls += 1
        throw new Error('private timer rollback signal fault')
      },
    },
    timeout_ms: 10,
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'invalid-task-timeout' }],
    ok: false,
  })
  assert.equal(removeCalls, 1)
  assert.equal(closeCalls, 1)
})

test('task lifecycle clears an established timer even when its handle is null', async () => {
  let clearCalls = 0
  const result = await executeTask(corpus.contract, corpus.request, {
    cancel_at: null,
    checkpoint: null,
    clearTimeoutImpl: (timer) => {
      assert.equal(timer, null)
      clearCalls += 1
    },
    effects: new Map(),
    perform: async () => ({
      effect: { key: 'null-timer-handle', payload: {} },
      kind: 'success',
      output: {},
    }),
    setTimeoutImpl: () => null,
    timeout_ms: 10,
  })

  assert.equal(result.ok, true)
  assert.equal(result.value.outcome, 'succeeded')
  assert.equal(clearCalls, 1)
})
