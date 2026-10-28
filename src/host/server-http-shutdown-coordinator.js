const DEFAULT_SIGNALS = ['SIGINT', 'SIGTERM']

export function createServerHttpShutdownCoordinator({
  driver,
  gracePeriodMs,
  now = defaultNow,
  servers,
  signals = DEFAULT_SIGNALS,
  signalSource,
} = {}) {
  if (driver === null || typeof driver !== 'object') {
    throw new TypeError('shutdown driver must expose drain')
  }
  const drain = snapshotMethod(driver, 'drain', true)
  const closeDriver = snapshotMethod(driver, 'close', false)
  if (!(servers instanceof Map) || servers.size === 0) {
    throw new TypeError('shutdown servers must be a non-empty Map')
  }
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new TypeError('gracePeriodMs must be non-negative')
  }
  if (typeof now !== 'function'
    || signalSource === null
    || typeof signalSource !== 'object') {
    throw new TypeError('invalid shutdown signal source')
  }
  const signalOn = snapshotMethod(signalSource, 'on', true)
  const signalOff = snapshotMethod(signalSource, 'off', true)
  const signalNames = validateSignals(signals)
  const serverRecords = snapshotServers(servers)
  let started = false
  let shutdownStarted = false
  let resolveResult
  const resultPromise = new Promise((resolve) => { resolveResult = resolve })
  const listeners = new Map(signalNames.map((signal) => [
    signal,
    () => beginShutdown(signal),
  ]))

  const removeListeners = () => {
    if (!started) return false
    for (const [signal, listener] of listeners) signalOff(signal, listener)
    started = false
    return true
  }

  const beginShutdown = (signal) => {
    if (shutdownStarted) return
    shutdownStarted = true
    removeListeners()
    Promise.resolve().then(async () => {
      let controlFailure = false
      let drainOutcome = { cancelled_requests: 0, outcome: 'closed' }
      let deadline
      try {
        const currentTime = now()
        if (!Number.isFinite(currentTime) || currentTime < 0) throw new TypeError()
        deadline = currentTime + gracePeriodMs
        if (!Number.isFinite(deadline) || deadline < 0) throw new TypeError()
      } catch {
        controlFailure = true
      }
      const closing = serverRecords.map(({ close, name }) => closeServer(name, close))
      if (!controlFailure) {
        try {
          const candidate = await drain({ deadline })
          const snapshot = snapshotDrainOutcome(candidate)
          if (snapshot === null) {
            controlFailure = true
          } else {
            drainOutcome = snapshot
          }
        } catch {
          controlFailure = true
        }
      }
      if (controlFailure || ['closed', 'deadline'].includes(drainOutcome.outcome)) {
        for (const { closeAllConnections } of serverRecords) {
          if (closeAllConnections === null) continue
          try {
            closeAllConnections()
          } catch {
            controlFailure = true
          }
        }
      }
      const serverOutcomes = await Promise.all(closing)
      try {
        closeDriver?.()
      } catch {
        controlFailure = true
      }
      const failedServers = serverOutcomes.filter(({ ok }) => !ok).length
      resolveResult({
        cancelled_requests: drainOutcome.cancelled_requests,
        closed_servers: serverOutcomes.length - failedServers,
        failed_servers: failedServers,
        outcome: controlFailure || failedServers > 0 ? 'partial-failure' : 'completed',
        signal,
      })
    })
  }

  return {
    result() {
      return resultPromise
    },
    start() {
      if (started || shutdownStarted) return false
      for (const [signal, listener] of listeners) signalOn(signal, listener)
      started = true
      return true
    },
    stop() {
      return removeListeners()
    },
  }
}

function closeServer(name, close) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      resolve({ name, ok: error === undefined || error?.code === 'ERR_SERVER_NOT_RUNNING' })
    }
    try {
      close(finish)
    } catch {
      finish(new Error('server-close-failed'))
    }
  })
}

function snapshotServers(servers) {
  const handles = new Set()
  const records = []
  const iterator = Map.prototype.entries.call(servers)
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const [name, server] = step.value
    if (typeof name !== 'string'
      || name.length === 0
      || server === null
      || typeof server !== 'object'
      || handles.has(server)) {
      throw new TypeError('invalid shutdown server')
    }
    const close = snapshotMethod(server, 'close', true)
    const closeAllConnections = snapshotMethod(server, 'closeAllConnections', false)
    handles.add(server)
    records.push({ close, closeAllConnections, name })
  }
  return records.sort((left, right) => compareText(left.name, right.name))
}

function snapshotMethod(receiver, member, required) {
  const method = receiver[member]
  if (typeof method !== 'function') {
    if (required) throw new TypeError(`shutdown ${member} must be a function`)
    return null
  }
  return Function.prototype.bind.call(method, receiver)
}

function validateSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new TypeError('shutdown signals must be a non-empty Array')
  }
  const names = new Set()
  for (const signal of signals) {
    if (typeof signal !== 'string'
      || !/^SIG[A-Z0-9]+$/u.test(signal)
      || names.has(signal)) {
      throw new TypeError('invalid shutdown signal')
    }
    names.add(signal)
  }
  return [...names].sort()
}

function snapshotDrainOutcome(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const keys = Object.keys(value).sort()
    if (keys.join(',') !== 'cancelled_requests,outcome') return null
    const snapshot = {
      cancelled_requests: value.cancelled_requests,
      outcome: value.outcome,
    }
    if (
      !Number.isSafeInteger(snapshot.cancelled_requests)
      || snapshot.cancelled_requests < 0
      || !['closed', 'deadline', 'drained'].includes(snapshot.outcome)
    ) return null
    return snapshot
  } catch {
    return null
  }
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function defaultNow() {
  return typeof performance?.now === 'function' ? performance.now() : Date.now()
}
