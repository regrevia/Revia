import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

import { executeConcurrencyPlan } from '../src/toolchain/concurrency-runtime.js'
import { lowerConcurrency } from '../src/toolchain/concurrency-contract.js'
import { invokeAgentCapability } from '../src/host/agent-adapter-contract.js'
import {
  createServerDbSqliteFileHandle,
} from '../src/host/server-db-sqlite-file.js'
import {
  createServerDbSqliteConnectionSet,
} from '../src/host/server-db-sqlite-connection-set.js'

const profile = {
  digest: 'sha256:4ace4315fa907f0bfa8458e88f1d3a10b0a16214e7813b431f6859b43a9b4b2f',
  id: 'server-minimum@0.1.0',
  schema: 're.server-profile@0.1.0',
}
const concurrencyDigest = (letter) => `sha256:${letter.repeat(64)}`

test('SQLite connection set bounds leases and runs two serial text-boundary reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  file.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text not null,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    )
  `)
  file.database.prepare(`
    insert into expense_review_decisions (
      request_id, amount, request_currency, outcome,
      approved, result_currency, error_variant
    ) values (?, ?, ?, ?, ?, ?, ?)
  `).run('expense-set:1', '125.00', 'usd', 'ok', 1, 'usd', null)

  const set = createServerDbSqliteConnectionSet({
    connection_count: 2,
    file_handle: file,
  })
  t.after(() => set.close())
  const first = set.acquire()
  const second = set.acquire()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(set.acquire(), { error: 'capacity', ok: false })
  assert.deepEqual(Object.keys(first.value), ['release'])
  assert.deepEqual(Object.keys(second.value), ['release'])
  const firstAdapter = set.bindAgentBusinessAdapter(first.value, {
    contract: contract(),
    database_name: 'expense',
    profile,
  })
  const secondAdapter = set.bindAgentBusinessAdapter(second.value, {
    contract: contract(),
    database_name: 'expense',
    profile,
  })
  assert.deepEqual(invoke(firstAdapter, 'expense-set:1').value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.deepEqual(invoke(secondAdapter, 'expense-set:1').value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.deepEqual(first.value.release(), { ok: true })
  assert.deepEqual(first.value.release(), { error: 'released', ok: false })
  assert.deepEqual(set.release(first.value), { error: 'released', ok: false })
  assert.deepEqual(invoke(firstAdapter, 'expense-set:1').value.outcome, {
    kind: 'host-fault',
  })
  const reused = set.acquire()
  assert.equal(reused.ok, true)
  assert.deepEqual(Object.keys(reused.value), ['release'])
  assert.deepEqual(set.release({}), { error: 'invalid lease', ok: false })
  assert.deepEqual(set.acquire(), { error: 'capacity', ok: false })
  assert.deepEqual(set.release(first.value), { error: 'released', ok: false })
  assert.deepEqual(set.acquire(), { error: 'capacity', ok: false })
  assert.deepEqual(second.value.release(), { ok: true })
  assert.deepEqual(reused.value.release(), { ok: true })
  assert.deepEqual(set.close(), { ok: true })
  assert.deepEqual(set.acquire(), { error: 'closed', ok: false })
  assert.deepEqual(file.close(), { error: 'closed', ok: false })
})

test('SQLite connection set snapshots close authority and rejects invalid ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-invalid-'))
  const otherRoot = await mkdtemp(join(tmpdir(), 're-sqlite-set-other-'))
  t.after(() => Promise.all([
    rm(root, { force: true, recursive: true }),
    rm(otherRoot, { force: true, recursive: true }),
  ]))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const other = createServerDbSqliteFileHandle({
    database_path: join(otherRoot, 'expense.sqlite'),
    root: otherRoot,
  })
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
  })
  const otherSet = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: other,
  })
  t.after(() => {
    set.close()
    otherSet.close()
  })
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      connection_count: 0,
      file_handle: file,
    }),
    /invalid SQLite connection set/,
  )
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      connection_count: 9,
      file_handle: file,
    }),
    /invalid SQLite connection set/,
  )
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      busy_timeout_ms: 5001,
      connection_count: 1,
      file_handle: file,
    }),
    /invalid SQLite connection set/,
  )
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      connection_count: 1,
      file_handle: file,
      wait_queue_limit: 33,
    }),
    /invalid SQLite connection set/,
  )
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      connection_count: 1,
      file_handle: file,
      timers: { clearTimeout() {} },
      wait_queue_limit: 1,
    }),
    /invalid SQLite connection set/,
  )
  const lease = set.acquire()
  assert.equal(lease.ok, true)
  assert.deepEqual(Object.keys(lease.value), ['release'])
  assert.deepEqual(otherSet.release(lease.value), {
    error: 'invalid lease',
    ok: false,
  })
  assert.deepEqual(set.close(), { ok: true })
  assert.deepEqual(lease.value.release(), { error: 'closed', ok: false })
})

test('SQLite connection set closes on an external file-handle close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-half-close-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const set = createServerDbSqliteConnectionSet({
    connection_count: 2,
    file_handle: file,
  })
  const lease = set.acquire()
  assert.equal(lease.ok, true)
  const adapter = set.bindAgentBusinessAdapter(lease.value, {
    contract: contract(),
    database_name: 'expense',
    profile,
  })
  assert.deepEqual(file.close(), { ok: true })
  assert.deepEqual(set.acquire(), { error: 'closed', ok: false })
  assert.deepEqual(lease.value.release(), { error: 'closed', ok: false })
  assert.deepEqual(invoke(adapter, 'expense-half-close:1').value.outcome, {
    kind: 'host-fault',
  })
  assert.deepEqual(set.close(), { error: 'closed', ok: false })
})

test('SQLite connection set sanitizes busy-timeout configuration failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-busy-fault-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  file.database.exec = () => {
    throw new Error('raw pragma failure')
  }
  assert.throws(
    () => createServerDbSqliteConnectionSet({
      busy_timeout_ms: 25,
      connection_count: 1,
      file_handle: file,
    }),
    (error) => (
      error instanceof TypeError
      && error.message === 'invalid SQLite connection set'
      && !error.message.includes('raw pragma failure')
    ),
  )
  assert.equal(
    typeof file.database.prepare('PRAGMA schema_version').get().schema_version,
    'number',
  )
  assert.deepEqual(file.close(), { ok: true })
})

test('SQLite connection set applies a bounded busy timeout to every connection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-busy-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  file.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text not null,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    );
    insert into expense_review_decisions values (
      'expense-busy:1', '125.00', 'usd', 'ok', 1, 'usd', null
    )
  `)
  const set = createServerDbSqliteConnectionSet({
    busy_timeout_ms: 25,
    connection_count: 2,
    file_handle: file,
  })
  assert.equal(
    file.database.prepare('PRAGMA busy_timeout').get().timeout,
    25,
  )
  t.after(() => set.close())
  const lockLease = set.acquire()
  const readLease = set.acquire()
  assert.equal(lockLease.ok, true)
  assert.equal(readLease.ok, true)
  const adapter = set.bindAgentBusinessAdapter(readLease.value, {
    contract: contract(),
    database_name: 'expense',
    profile,
  })

  file.database.exec('begin exclusive; update expense_review_decisions set approved = 0')
  const started = performance.now()
  assert.deepEqual(invoke(adapter, 'expense-busy:1').value.outcome, {
    error: {
      type: 'agent.expense.intake.error',
      variant: 'transient',
    },
    kind: 'err',
  })
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 15, `busy timeout returned too early: ${elapsed}`)
  assert.ok(elapsed < 500, `busy timeout exceeded its bound: ${elapsed}`)

  file.database.exec('rollback')
  assert.deepEqual(invoke(adapter, 'expense-busy:1').value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.deepEqual(readLease.value.release(), { ok: true })
  assert.deepEqual(lockLease.value.release(), { ok: true })
})

test('SQLite connection set bounds cross-process lock contention and recovers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-process-busy-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const databasePath = join(root, 'expense.sqlite')
  const file = createServerDbSqliteFileHandle({
    database_path: databasePath,
    root,
  })
  file.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text not null,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    );
    insert into expense_review_decisions values (
      'expense-process-busy:1', '125.00', 'usd', 'ok', 1, 'usd', null
    )
  `)
  const set = createServerDbSqliteConnectionSet({
    busy_timeout_ms: 25,
    connection_count: 1,
    file_handle: file,
  })
  t.after(() => set.close())
  const lease = set.acquire()
  assert.equal(lease.ok, true)
  const adapter = set.bindAgentBusinessAdapter(lease.value, {
    contract: contract(),
    database_name: 'expense',
    profile,
  })
  const lock = await holdExclusiveLock(databasePath)
  t.after(() => lock.close())

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = performance.now()
    assert.deepEqual(invoke(adapter, 'expense-process-busy:1').value.outcome, {
      error: {
        type: 'agent.expense.intake.error',
        variant: 'transient',
      },
      kind: 'err',
    })
    const elapsed = performance.now() - started
    assert.ok(
      elapsed >= 15,
      `cross-process busy timeout ${attempt} returned too early: ${elapsed}`,
    )
    assert.ok(
      elapsed < 500,
      `cross-process busy timeout ${attempt} exceeded its bound: ${elapsed}`,
    )
  }

  await lock.release()
  assert.deepEqual(invoke(adapter, 'expense-process-busy:1').value.outcome, {
    kind: 'ok',
    value: { approved: true, currency: { variant: 'usd' } },
  })
  assert.deepEqual(lease.value.release(), { ok: true })
})

test('SQLite connection set isolates cross-process busy failures across leases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-process-isolation-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const databasePath = join(root, 'expense.sqlite')
  const file = createServerDbSqliteFileHandle({
    database_path: databasePath,
    root,
  })
  file.database.exec(`
    create table expense_review_decisions (
      request_id text not null,
      amount text not null,
      request_currency text not null,
      outcome text not null,
      approved integer,
      result_currency text,
      error_variant text
    );
    insert into expense_review_decisions values (
      'expense-process-isolation:1', '125.00', 'usd', 'ok', 1, 'usd', null
    )
  `)
  const set = createServerDbSqliteConnectionSet({
    busy_timeout_ms: 25,
    connection_count: 2,
    file_handle: file,
  })
  t.after(() => set.close())
  const leases = [set.acquire(), set.acquire()]
  assert.equal(leases[0].ok, true)
  assert.equal(leases[1].ok, true)
  assert.deepEqual(set.acquire(), { error: 'capacity', ok: false })
  const adapters = leases.map(({ value }) => (
    set.bindAgentBusinessAdapter(value, {
      contract: contract(),
      database_name: 'expense',
      profile,
    })
  ))
  const lock = await holdExclusiveLock(databasePath)
  t.after(() => lock.close())
  const transient = {
    error: {
      type: 'agent.expense.intake.error',
      variant: 'transient',
    },
    kind: 'err',
  }

  for (let index = 0; index < adapters.length; index += 1) {
    const started = performance.now()
    assert.deepEqual(
      invoke(adapters[index], 'expense-process-isolation:1').value.outcome,
      transient,
    )
    const elapsed = performance.now() - started
    assert.ok(
      elapsed >= 15,
      `cross-lease busy timeout ${index + 1} returned too early: ${elapsed}`,
    )
    assert.ok(
      elapsed < 500,
      `cross-lease busy timeout ${index + 1} exceeded its bound: ${elapsed}`,
    )
  }

  await lock.release()
  for (const adapter of adapters) {
    assert.deepEqual(
      invoke(adapter, 'expense-process-isolation:1').value.outcome,
      {
        kind: 'ok',
        value: { approved: true, currency: { variant: 'usd' } },
      },
    )
  }
  for (const lease of leases) {
    assert.deepEqual(lease.value.release(), { ok: true })
  }
})

test('SQLite connection wait queue is bounded and grants leases in FIFO order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-queue-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 2,
  })
  t.after(() => set.close())
  const active = set.acquire()
  assert.equal(active.ok, true)
  const firstWait = set.acquireWait({ timeout_ms: 100 })
  const secondWait = set.acquireWait({ timeout_ms: 200 })
  assert.deepEqual(await set.acquireWait({ timeout_ms: 300 }), {
    error: 'capacity',
    ok: false,
  })
  assert.deepEqual(clock.delays(), [100, 200])
  assert.deepEqual(active.value.release(), { ok: true })
  const first = await firstWait
  assert.equal(first.ok, true)
  assert.equal(clock.pending(), 1)
  assert.deepEqual(first.value.release(), { ok: true })
  const second = await secondWait
  assert.equal(second.ok, true)
  assert.equal(clock.pending(), 0)
  assert.deepEqual(second.value.release(), { ok: true })
})

test('SQLite connection wait timeout removes the waiter without a late lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-timeout-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const active = set.acquire()
  const waiting = set.acquireWait({ timeout_ms: 25 })
  clock.fireFirst()
  assert.deepEqual(await waiting, { error: 'timeout', ok: false })
  assert.deepEqual(active.value.release(), { ok: true })
  const next = set.acquire()
  assert.equal(next.ok, true)
  assert.deepEqual(next.value.release(), { ok: true })
})

test('SQLite connection wait timeout uses the default Node timer and leaves no late lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-real-timeout-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const active = set.acquire()
  assert.equal(active.ok, true)
  const waiting = set.acquireWait({ timeout_ms: 20 })
  assert.deepEqual(await waiting, { error: 'timeout', ok: false })
  assert.deepEqual(active.value.release(), { ok: true })
  const next = set.acquire()
  assert.equal(next.ok, true)
  assert.deepEqual(next.value.release(), { ok: true })
})

test('SQLite connection wait release clears the default Node timer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-real-release-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const active = set.acquire()
  assert.equal(active.ok, true)
  const waiting = set.acquireWait({ timeout_ms: 100 })
  assert.deepEqual(active.value.release(), { ok: true })
  const granted = await waiting
  assert.equal(granted.ok, true)
  assert.deepEqual(granted.value.release(), { ok: true })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const next = set.acquire()
  assert.equal(next.ok, true)
  assert.deepEqual(next.value.release(), { ok: true })
})

test('SQLite connection wait cancellation never consumes or later receives a lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-cancel-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const cancelled = new AbortController()
  cancelled.abort()
  assert.deepEqual(
    await set.acquireWait({ signal: cancelled.signal, timeout_ms: 100 }),
    { error: 'cancelled', ok: false },
  )
  const active = set.acquire()
  assert.equal(active.ok, true)
  const queued = new AbortController()
  const waiting = set.acquireWait({
    signal: queued.signal,
    timeout_ms: 100,
  })
  assert.equal(clock.pending(), 1)
  queued.abort()
  assert.deepEqual(await waiting, { error: 'cancelled', ok: false })
  assert.equal(clock.pending(), 0)
  assert.deepEqual(active.value.release(), { ok: true })
  const next = set.acquire()
  assert.equal(next.ok, true)
  assert.deepEqual(next.value.release(), { ok: true })
})

test('parent cancellation of a queued SQLite lease cannot grant it after release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-parent-cancel-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const active = set.acquire()
  assert.equal(active.ok, true)

  const plan = lowerConcurrency({
    kind: 'par',
    region: {
      branches: [
        {
          effects: [{
            after: [],
            cancellation: 'cooperative',
            footprint: [{
              handle: null,
              mode: 'read',
              resource: {
                domain_digest: concurrencyDigest('a'),
                segments: [{
                  canonical_hex: 'aa',
                  type_digest: concurrencyDigest('b'),
                }],
              },
            }],
            id: 'acquire',
            operation_digest: concurrencyDigest('c'),
          }],
          id: 'reader',
          output_type: 'unit',
        },
        {
          effects: [],
          id: 'sibling',
          output_type: 'unit',
        },
      ],
      cancel_reason_type: {
        arguments: [],
        declaration_digest: concurrencyDigest('d'),
        kind: 'declared',
      },
      deadline: null,
      handles: [],
      id: 'sqlite_lease',
      join_type: {
        arguments: [],
        declaration_digest: concurrencyDigest('e'),
        kind: 'declared',
      },
      task_outcome_digest: concurrencyDigest('f'),
    },
    schema: 're.concurrency-contract@0.1.0',
  })
  assert.equal(plan.ok, true)

  const parent = new AbortController()
  let markQueued
  let markSiblingStarted
  const waiterQueued = new Promise((resolve) => { markQueued = resolve })
  const siblingStarted = new Promise((resolve) => { markSiblingStarted = resolve })
  let acquiredAfterCancel = false
  const execution = executeConcurrencyPlan(plan.plan, {
    branches: new Map([
      ['reader', async ({ runEffect }) => runEffect('acquire', async ({ signal }) => {
        const result = set.acquireWait({ signal, timeout_ms: 5000 })
        markQueued()
        const lease = await result
        if (lease.ok) {
          acquiredAfterCancel = true
          lease.value.release()
        }
        return lease.error ?? 'acquired'
      })],
      ['sibling', async ({ signal }) => {
        markSiblingStarted()
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
        })
      }],
    ]),
    parentSignal: parent.signal,
  })

  await Promise.all([waiterQueued, siblingStarted])
  parent.abort()
  const result = await execution
  assert.equal(result.ok, true)
  assert.equal(result.branches.reader, undefined)
  assert.equal(result.trace.events.some((event) => (
    event.kind === 'effect-cancelled'
    && event.branch === 'reader'
    && event.effect === 'acquire'
  )), true)
  assert.equal(acquiredAfterCancel, false)

  assert.deepEqual(active.value.release(), { ok: true })
  const next = set.acquire()
  assert.equal(next.ok, true)
  assert.deepEqual(next.value.release(), { ok: true })
})

test('SQLite connection wait snapshots and cleans cancellation authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-cancel-authority-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const cancellation = fakeCancellation()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 1,
  })
  t.after(() => set.close())
  const active = set.acquire()
  const waiting = set.acquireWait({
    signal: cancellation.api,
    timeout_ms: 100,
  })
  assert.deepEqual(cancellation.reads(), {
    aborted: 1,
    addEventListener: 1,
    removeEventListener: 1,
  })
  cancellation.mutate()
  cancellation.abort()
  assert.deepEqual(await waiting, { error: 'cancelled', ok: false })
  assert.equal(cancellation.pending(), 0)
  assert.equal(clock.pending(), 0)
  assert.deepEqual(active.value.release(), { ok: true })
  assert.throws(
    () => set.acquireWait({ signal: {}, timeout_ms: 1 }),
    /invalid SQLite wait request/,
  )
})

test('SQLite connection wait removes cancellation listeners on every terminal path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-cancel-cleanup-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 1,
  })
  const active = set.acquire()
  const releaseCancellation = fakeCancellation()
  const grantedWait = set.acquireWait({
    signal: releaseCancellation.api,
    timeout_ms: 100,
  })
  assert.deepEqual(active.value.release(), { ok: true })
  const granted = await grantedWait
  assert.equal(granted.ok, true)
  assert.equal(releaseCancellation.pending(), 0)
  assert.equal(clock.pending(), 0)

  const timeoutCancellation = fakeCancellation()
  const timedWait = set.acquireWait({
    signal: timeoutCancellation.api,
    timeout_ms: 100,
  })
  clock.fireFirst()
  assert.deepEqual(await timedWait, { error: 'timeout', ok: false })
  assert.equal(timeoutCancellation.pending(), 0)

  const closeCancellation = fakeCancellation()
  const closedWait = set.acquireWait({
    signal: closeCancellation.api,
    timeout_ms: 100,
  })
  assert.deepEqual(file.close(), { ok: true })
  assert.deepEqual(await closedWait, { error: 'closed', ok: false })
  assert.equal(closeCancellation.pending(), 0)
  assert.equal(clock.pending(), 0)
  assert.deepEqual(granted.value.release(), { error: 'closed', ok: false })
})

test('SQLite connection waiters close with the set and timer authority is snapshotted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 're-sqlite-set-wait-close-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const file = createServerDbSqliteFileHandle({
    database_path: join(root, 'expense.sqlite'),
    root,
  })
  const clock = fakeTimers()
  const set = createServerDbSqliteConnectionSet({
    connection_count: 1,
    file_handle: file,
    timers: clock.api,
    wait_queue_limit: 2,
  })
  const active = set.acquire()
  const waiting = set.acquireWait({ timeout_ms: 50 })
  clock.api.setTimeout = () => {
    throw new Error('spoof')
  }
  clock.api.clearTimeout = () => {
    throw new Error('spoof')
  }
  assert.deepEqual(file.close(), { ok: true })
  assert.deepEqual(await waiting, { error: 'closed', ok: false })
  assert.equal(clock.pending(), 0)
  assert.deepEqual(active.value.release(), { error: 'closed', ok: false })
  assert.throws(
    () => set.acquireWait({ timeout_ms: -1 }),
    /invalid SQLite wait request/,
  )
})

function invoke(adapter, requestId) {
  return invokeAgentCapability(
    contract(),
    adapter,
    {
      capability_reference: 'db.read@0.1.0',
      cancellation: null,
      deadline: null,
      input: { amount: '125.00', currency: { variant: 'usd' } },
      member: 'read',
      request_id: requestId,
    },
  )
}

function fakeTimers() {
  let sequence = 0
  const jobs = new Map()
  const api = {
    clearTimeout(id) {
      jobs.delete(id)
    },
    setTimeout(callback, delay) {
      sequence += 1
      jobs.set(sequence, { callback, delay })
      return sequence
    },
  }
  return {
    api,
    delays() {
      return [...jobs.values()].map(({ delay }) => delay)
    },
    fireFirst() {
      const entry = jobs.entries().next().value
      if (entry === undefined) throw new Error('no timer')
      const [id, job] = entry
      jobs.delete(id)
      job.callback()
    },
    pending() {
      return jobs.size
    },
  }
}

function fakeCancellation() {
  let aborted = false
  let listener = null
  const reads = {
    aborted: 0,
    addEventListener: 0,
    removeEventListener: 0,
  }
  const api = {}
  Object.defineProperties(api, {
    aborted: {
      configurable: true,
      enumerable: true,
      get() {
        reads.aborted += 1
        return aborted
      },
    },
    addEventListener: {
      configurable: true,
      enumerable: true,
      get() {
        reads.addEventListener += 1
        return (type, callback) => {
          assert.equal(type, 'abort')
          listener = callback
        }
      },
    },
    removeEventListener: {
      configurable: true,
      enumerable: true,
      get() {
        reads.removeEventListener += 1
        return (type, callback) => {
          assert.equal(type, 'abort')
          if (listener === callback) listener = null
        }
      },
    },
  })
  return {
    abort() {
      aborted = true
      listener?.()
    },
    api,
    mutate() {
      for (const member of ['addEventListener', 'removeEventListener']) {
        Object.defineProperty(api, member, {
          configurable: true,
          enumerable: true,
          value() {
            throw new Error('spoof')
          },
        })
      }
    },
    pending() {
      return listener === null ? 0 : 1
    },
    reads() {
      return { ...reads }
    },
  }
}

function contract() {
  return {
    agent: 'agent.expense.intake',
    capability: {
      instance: '@expense_db',
      member: 'read',
      reference: 'db.read@0.1.0',
    },
    cancellation: { mode: 'cooperative', supported: true },
    deadline: { max_ms: 0, required: false },
    error_type: { kind: 'type', name: 'agent.expense.intake.error' },
    error_variants: ['transient', 'unavailable'],
    features: ['cancellation'],
    input_type: { kind: 'type', name: 'agent.expense.intake.input' },
    module: 'agent.expense.intake',
    node_uid: `${'d'.repeat(25)}e`,
    output_type: { kind: 'type', name: 'agent.expense.intake.result' },
    profile,
    request_type: { kind: 'type', name: 'agent.expense.intake.input' },
    resource: { access: 'read', constructor: 'expense_db' },
    schema: 're.agent-adapter-contract@0.1.0',
  }
}

async function holdExclusiveLock(databasePath) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { DatabaseSync } from 'node:sqlite'
      const database = new DatabaseSync(process.argv[1])
      database.exec("begin exclusive; update expense_review_decisions set approved = 0")
      process.stdout.write("ready\\n")
      process.stdin.setEncoding("utf8")
      process.stdin.once("data", (input) => {
        if (input !== "release\\n") process.exitCode = 2
        else database.exec("rollback")
        database.close()
        process.stdout.write("released\\n")
      })
    `,
    databasePath,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const lines = createInterface({ input: child.stdout })
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal }))
  try {
    assert.equal(
      await childLine(lines, exit, () => stderr),
      'ready',
      'SQLite lock child did not become ready',
    )
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
    lines.close()
    throw error
  }
  let released = false
  return {
    async close() {
      if (!released && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await exit
      lines.close()
    },
    async release() {
      if (released) throw new TypeError('SQLite lock child already released')
      released = true
      const line = childLine(lines, exit, () => stderr)
      child.stdin.end('release\n')
      assert.equal(await line, 'released')
      assert.deepEqual(await exit, { code: 0, signal: null })
      lines.close()
    },
  }
}

async function childLine(lines, exit, stderr) {
  const timeout = AbortSignal.timeout(5_000)
  return Promise.race([
    once(lines, 'line', { signal: timeout }).then(([line]) => line),
    exit.then(({ code, signal }) => {
      throw new Error(
        `SQLite lock child exited before protocol line: code=${code} signal=${signal} stderr=${stderr()}`,
      )
    }),
  ])
}
