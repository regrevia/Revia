import { AgentBusinessSqliteAdapter } from './agent-business-sqlite-adapter.js'
import {
  getServerDbSqliteFileClose,
  getServerDbSqliteFileDatabase,
  openServerDbSqliteFileConnection,
  subscribeServerDbSqliteFileClose,
} from './server-db-sqlite-file.js'

const LEASES = new WeakMap()
const SET_STATE = new WeakMap()
const MAX_CONNECTIONS = 8
const MAX_BUSY_TIMEOUT_MS = 5_000
const MAX_WAIT_QUEUE = 32
const MAX_WAIT_MS = 60_000
const NODE_TIMERS = {
  clearTimeout: globalThis.clearTimeout,
  setTimeout: globalThis.setTimeout,
}

export function createServerDbSqliteConnectionSet({
  busy_timeout_ms = 0,
  connection_count,
  file_handle,
  timers = NODE_TIMERS,
  wait_queue_limit = 0,
} = {}) {
  if (
    !Number.isSafeInteger(busy_timeout_ms)
    || busy_timeout_ms < 0
    || busy_timeout_ms > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new TypeError('invalid SQLite connection set')
  }
  if (
    !Number.isSafeInteger(connection_count)
    || connection_count < 1
    || connection_count > MAX_CONNECTIONS
  ) {
    throw new TypeError('invalid SQLite connection set')
  }
  if (
    !Number.isSafeInteger(wait_queue_limit)
    || wait_queue_limit < 0
    || wait_queue_limit > MAX_WAIT_QUEUE
  ) {
    throw new TypeError('invalid SQLite connection set')
  }
  const timerAuthority = snapshotTimers(timers)
  const first = openExisting(file_handle)
  const connections = [first]
  try {
    configureBusyTimeout(first, busy_timeout_ms)
    for (let index = 1; index < connection_count; index += 1) {
      const connection = openServerDbSqliteFileConnection(file_handle)
      connections.push(connection)
      configureBusyTimeout(connection, busy_timeout_ms)
    }
  } catch {
    for (const connection of connections.slice(1)) closeConnection(connection)
    throw new TypeError('invalid SQLite connection set')
  }

  const state = {
    closed: false,
    connections,
    leases: new Set(),
    timerAuthority,
    unsubscribeFileClose: null,
    waitQueue: [],
    waitQueueLimit: wait_queue_limit,
  }
  const set = {
    acquire() {
      if (state.closed) return { error: 'closed', ok: false }
      const connection = state.connections.find((entry) => !entry.lease)
      if (connection === undefined) return { error: 'capacity', ok: false }
      return { ok: true, value: createLease(set, state, connection) }
    },
    acquireWait(request = {}) {
      const { signalAuthority, timeoutMs } = validateWaitRequest(request)
      if (state.closed) {
        return Promise.resolve({ error: 'closed', ok: false })
      }
      if (signalAuthority?.aborted === true) {
        return Promise.resolve({ error: 'cancelled', ok: false })
      }
      const immediate = set.acquire()
      if (immediate.ok || immediate.error !== 'capacity') {
        return Promise.resolve(immediate)
      }
      if (state.waitQueue.length >= state.waitQueueLimit) {
        return Promise.resolve({ error: 'capacity', ok: false })
      }
      return enqueueWaiter(set, state, timeoutMs, signalAuthority)
    },
    close() {
      if (state.closed) return { error: 'closed', ok: false }
      shutdown(state)
      return { ok: true }
    },
    release(lease) {
      const record = LEASES.get(lease)
      if (record === undefined || record.set !== set) {
        return { error: 'invalid lease', ok: false }
      }
      return releaseLease(set, lease)
    },
    bindAgentBusinessAdapter(lease, options = {}) {
      const record = LEASES.get(lease)
      if (record === undefined || record.set !== set || !isLeaseActive(record)) {
        throw new TypeError('invalid SQLite lease')
      }
      const delegate = new AgentBusinessSqliteAdapter({
        ...options,
        database: record.leaseState.connection.database,
      })
      return Object.freeze({
        adapterContract() {
          return delegate.adapterContract()
        },
        profileIdentity() {
          return delegate.profileIdentity()
        },
        invoke(operation, input, context) {
          if (!isLeaseActive(record)) return { kind: 'host-fault' }
          return delegate.invoke(operation, input, context)
        },
      })
    },
  }
  SET_STATE.set(set, state)
  state.unsubscribeFileClose = subscribeServerDbSqliteFileClose(
    file_handle,
    () => shutdown(state),
  )
  return Object.freeze(set)
}

function createLease(set, state, connection) {
  const leaseState = { connection, released: false }
  const lease = Object.freeze({
    release() {
      return releaseLease(set, lease)
    },
  })
  LEASES.set(lease, { leaseState, set })
  connection.lease = lease
  state.leases.add(lease)
  return lease
}

function openExisting(fileHandle) {
  let database
  let close
  try {
    database = getServerDbSqliteFileDatabase(fileHandle)
    close = getServerDbSqliteFileClose(fileHandle)
    database.prepare('PRAGMA schema_version').get()
  } catch {
    throw new TypeError('invalid SQLite connection set')
  }
  return {
    close,
    database,
  }
}

function releaseLease(set, lease) {
  const record = LEASES.get(lease)
  if (record === undefined || record.set !== set) {
    return { error: 'invalid lease', ok: false }
  }
  if (setClosed(set)) return { error: 'closed', ok: false }
  if (record.leaseState.released) return { error: 'released', ok: false }
  record.leaseState.released = true
  const connection = record.leaseState.connection
  connection.lease = null
  const state = stateFor(set)
  state.leases.delete(lease)
  grantNextWaiter(set, state, connection)
  return { ok: true }
}

function isLeaseActive(record) {
  return !record.leaseState.released && !stateFor(record.set).closed
}

function shutdown(state) {
  if (state.closed) return
  state.closed = true
  state.unsubscribeFileClose?.()
  state.unsubscribeFileClose = null
  for (const lease of state.leases) {
    const record = LEASES.get(lease)
    if (record !== undefined) record.leaseState.released = true
  }
  for (const waiter of state.waitQueue) {
    settleWaiter(state, waiter, { error: 'closed', ok: false })
  }
  state.waitQueue.length = 0
  for (const connection of state.connections) closeConnection(connection)
  state.leases.clear()
}

function enqueueWaiter(set, state, timeoutMs, signalAuthority) {
  return new Promise((resolve) => {
    const waiter = {
      active: true,
      abortListener: null,
      abortRegistered: false,
      resolve,
      signalAuthority,
      timer: null,
    }
    state.waitQueue.push(waiter)
    if (signalAuthority !== null) {
      waiter.abortListener = () => {
        if (!waiter.active) return
        removeWaiter(state, waiter)
        settleWaiter(state, waiter, { error: 'cancelled', ok: false })
      }
      try {
        signalAuthority.addEventListener('abort', waiter.abortListener, {
          once: true,
        })
        waiter.abortRegistered = true
        if (!waiter.active) {
          clearWaiterCancellation(waiter)
          return
        }
      } catch {
        removeWaiter(state, waiter)
        settleWaiter(state, waiter, { error: 'unavailable', ok: false })
        return
      }
    }
    try {
      waiter.timer = state.timerAuthority.setTimeout(() => {
        if (!waiter.active) return
        removeWaiter(state, waiter)
        settleWaiter(state, waiter, { error: 'timeout', ok: false })
      }, timeoutMs)
    } catch {
      removeWaiter(state, waiter)
      settleWaiter(state, waiter, { error: 'unavailable', ok: false })
    }
  })
}

function grantNextWaiter(set, state, connection) {
  while (!state.closed && state.waitQueue.length > 0) {
    const waiter = state.waitQueue.shift()
    if (!waiter.active) continue
    const lease = createLease(set, state, connection)
    settleWaiter(state, waiter, { ok: true, value: lease })
    return
  }
}

function settleWaiter(state, waiter, outcome) {
  if (!waiter.active) return
  waiter.active = false
  if (waiter.timer !== null) {
    try {
      state.timerAuthority.clearTimeout(waiter.timer)
    } catch {
      // The waiter terminal outcome remains authoritative.
    }
  }
  clearWaiterCancellation(waiter)
  waiter.resolve(outcome)
}

function validateWaitRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('invalid SQLite wait request')
  }
  let keys
  let signal
  let timeoutMs
  try {
    keys = Object.keys(request).sort()
    if (
      keys.join(',') !== 'timeout_ms'
      && keys.join(',') !== 'signal,timeout_ms'
    ) {
      throw new TypeError('invalid SQLite wait request')
    }
    timeoutMs = request.timeout_ms
    signal = keys.length === 2 ? request.signal : undefined
  } catch {
    throw new TypeError('invalid SQLite wait request')
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > MAX_WAIT_MS
  ) {
    throw new TypeError('invalid SQLite wait request')
  }
  return {
    signalAuthority: snapshotAbortSignal(signal),
    timeoutMs,
  }
}

function snapshotAbortSignal(signal) {
  if (signal === undefined) return null
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new TypeError('invalid SQLite wait request')
  }
  let aborted
  let addEventListener
  let removeEventListener
  try {
    aborted = signal.aborted
    addEventListener = signal.addEventListener
    removeEventListener = signal.removeEventListener
  } catch {
    throw new TypeError('invalid SQLite wait request')
  }
  if (
    typeof aborted !== 'boolean'
    || typeof addEventListener !== 'function'
    || typeof removeEventListener !== 'function'
  ) {
    throw new TypeError('invalid SQLite wait request')
  }
  return {
    aborted,
    addEventListener: Function.prototype.bind.call(addEventListener, signal),
    removeEventListener: Function.prototype.bind.call(
      removeEventListener,
      signal,
    ),
  }
}

function removeWaiter(state, waiter) {
  const index = state.waitQueue.indexOf(waiter)
  if (index !== -1) state.waitQueue.splice(index, 1)
}

function clearWaiterCancellation(waiter) {
  if (!waiter.abortRegistered) return
  waiter.abortRegistered = false
  try {
    waiter.signalAuthority.removeEventListener('abort', waiter.abortListener)
  } catch {
    // The waiter terminal outcome remains authoritative.
  }
}

function snapshotTimers(timers) {
  if (
    timers === null
    || typeof timers !== 'object'
    || Array.isArray(timers)
  ) {
    throw new TypeError('invalid SQLite connection set')
  }
  const authority = {}
  for (const member of ['clearTimeout', 'setTimeout']) {
    const method = timers[member]
    if (typeof method !== 'function') {
      throw new TypeError('invalid SQLite connection set')
    }
    authority[member] = Function.prototype.bind.call(method, timers)
  }
  return authority
}

function stateFor(set) {
  return SET_STATE.get(set)
}

function setClosed(set) {
  return stateFor(set)?.closed === true
}

function closeConnection(connection) {
  try {
    connection.close()
  } catch {
    // The set close result remains sanitized and one-shot.
  }
}

function configureBusyTimeout(connection, busyTimeoutMs) {
  connection.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
}
