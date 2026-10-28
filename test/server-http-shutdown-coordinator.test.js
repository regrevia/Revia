import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  createServerHttpServerNodeDriver,
} from '../src/host/server-http-server-node-driver.js'
import {
  ServerHttpServerSocketAdapter,
} from '../src/host/server-http-server-socket-adapter.js'
import {
  createServerHttpShutdownCoordinator,
} from '../src/host/server-http-shutdown-coordinator.js'
import { SERVER_HTTP_SERVER_REFERENCE } from '../src/host/server-profile.js'

test('shutdown coordinator drains a real active request and closes its server', async () => {
  const signalSource = new EventEmitter()
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  const coordinator = createServerHttpShutdownCoordinator({
    driver,
    gracePeriodMs: 1_000,
    now: () => 10,
    servers: new Map([['api', server]]),
    signalSource,
  })
  try {
    const accepted = invoke(adapter, 'accept', { listener: 'api' })
    const address = server.address()
    const client = fetch(`http://127.0.0.1:${address.port}/active`)
    const token = okValue(await accepted)
    assert.equal(coordinator.start(), true)

    signalSource.emit('SIGTERM')
    await invoke(adapter, 'respond', {
      body: new Uint8Array(Buffer.from('finished')),
      headers: 'content-type:text/plain',
      request: token,
      status: 200,
    })
    assert.equal(await (await client).text(), 'finished')
    assert.deepEqual(await coordinator.result(), {
      cancelled_requests: 0,
      closed_servers: 1,
      failed_servers: 0,
      outcome: 'completed',
      signal: 'SIGTERM',
    })
    assert.equal(server.listening, false)
    assert.equal(signalSource.listenerCount('SIGTERM'), 0)
    assert.equal(signalSource.listenerCount('SIGINT'), 0)
  } finally {
    coordinator.stop()
    driver.close()
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve))
    }
  }
})

test('shutdown coordinator registers idempotently and only the first allowed signal wins', async () => {
  const signalSource = new EventEmitter()
  let drainCalls = 0
  const driver = {
    async drain() {
      drainCalls += 1
      return { cancelled_requests: 0, outcome: 'drained' }
    },
  }
  const server = fakeServer()
  const coordinator = createServerHttpShutdownCoordinator({
    driver,
    gracePeriodMs: 50,
    now: () => 5,
    servers: new Map([['api', server]]),
    signalSource,
  })

  assert.equal(coordinator.start(), true)
  assert.equal(coordinator.start(), false)
  signalSource.emit('SIGHUP')
  assert.equal(drainCalls, 0)
  signalSource.emit('SIGINT')
  signalSource.emit('SIGTERM')
  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'completed',
    signal: 'SIGINT',
  })
  assert.equal(drainCalls, 1)
  assert.equal(server.closeCalls, 1)
  assert.equal(coordinator.stop(), false)
})

test('shutdown coordinator snapshots signal and driver capabilities before later faults', async () => {
  const signalListeners = new Map()
  const signalSource = { signalListeners }
  let signalOnReads = 0
  let signalOffReads = 0
  let drainReads = 0
  let closeReads = 0
  let drainCalls = 0
  let closeCalls = 0
  const signalOn = function (signal, listener) {
    assert.equal(this, signalSource)
    signalListeners.set(signal, listener)
  }
  const signalOff = function (signal, listener) {
    assert.equal(this, signalSource)
    assert.equal(signalListeners.get(signal), listener)
    signalListeners.delete(signal)
  }
  const drain = function () {
    assert.equal(this, driver)
    drainCalls += 1
    return { cancelled_requests: 0, outcome: 'drained' }
  }
  const close = function () {
    assert.equal(this, driver)
    closeCalls += 1
  }
  poisonBind(signalOn)
  poisonBind(signalOff)
  poisonBind(drain)
  poisonBind(close)
  Object.defineProperties(signalSource, {
    on: {
      configurable: true,
      get() {
        signalOnReads += 1
        if (signalOnReads > 1) throw new Error('signal on getter fault')
        return signalOn
      },
    },
    off: {
      configurable: true,
      get() {
        signalOffReads += 1
        if (signalOffReads > 1) throw new Error('signal off getter fault')
        return signalOff
      },
    },
  })
  const driver = {}
  Object.defineProperties(driver, {
    drain: {
      configurable: true,
      get() {
        drainReads += 1
        if (drainReads > 1) throw new Error('drain getter fault')
        return drain
      },
    },
    close: {
      configurable: true,
      get() {
        closeReads += 1
        if (closeReads > 1) throw new Error('close getter fault')
        return close
      },
    },
  })
  const server = snapshotServer()

  const coordinator = createServerHttpShutdownCoordinator({
    driver,
    gracePeriodMs: 10,
    now: () => 0,
    servers: new Map([['api', server]]),
    signalSource,
  })
  assert.equal(coordinator.start(), true)
  signalListeners.get('SIGTERM')()

  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'completed',
    signal: 'SIGTERM',
  })
  assert.equal(signalOnReads, 1)
  assert.equal(signalOffReads, 1)
  assert.equal(drainReads, 1)
  assert.equal(closeReads, 1)
  assert.equal(drainCalls, 1)
  assert.equal(closeCalls, 1)
})

test('shutdown coordinator snapshots server close capabilities before later faults', async () => {
  const signalSource = new EventEmitter()
  let closeReads = 0
  let forceReads = 0
  let closeCalls = 0
  let forceCalls = 0
  const server = {}
  const close = function (callback) {
    assert.equal(this, server)
    closeCalls += 1
    callback()
  }
  const closeAllConnections = function () {
    assert.equal(this, server)
    forceCalls += 1
  }
  Object.defineProperties(server, {
    close: {
      configurable: true,
      get() {
        closeReads += 1
        if (closeReads > 1) throw new Error('server close getter fault')
        return close
      },
    },
    closeAllConnections: {
      configurable: true,
      get() {
        forceReads += 1
        if (forceReads > 1) throw new Error('server force getter fault')
        return closeAllConnections
      },
    },
  })
  const coordinator = createServerHttpShutdownCoordinator({
    driver: {
      async drain() {
        return { cancelled_requests: 0, outcome: 'deadline' }
      },
    },
    gracePeriodMs: 10,
    now: () => 0,
    servers: new Map([['api', server]]),
    signalSource,
  })
  coordinator.start()
  signalSource.emit('SIGTERM')

  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'completed',
    signal: 'SIGTERM',
  })
  assert.equal(closeReads, 1)
  assert.equal(forceReads, 1)
  assert.equal(closeCalls, 1)
  assert.equal(forceCalls, 1)
})

test('deadline drain forces remaining connections before server close settles', async () => {
  const signalSource = new EventEmitter()
  const server = fakeServer({ waitForForce: true })
  const coordinator = createServerHttpShutdownCoordinator({
    driver: {
      async drain({ deadline }) {
        assert.equal(deadline, 25)
        return { cancelled_requests: 2, outcome: 'deadline' }
      },
    },
    gracePeriodMs: 20,
    now: () => 5,
    servers: new Map([['api', server]]),
    signalSource,
  })
  coordinator.start()
  signalSource.emit('SIGTERM')

  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 2,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'completed',
    signal: 'SIGTERM',
  })
  assert.equal(server.forceCalls, 1)
})

test('stop-before-signal is inert and close failures are sanitized', async () => {
  const signalSource = new EventEmitter()
  let drains = 0
  const failing = fakeServer({ closeError: new Error('private close detail') })
  const healthy = fakeServer()
  const coordinator = createServerHttpShutdownCoordinator({
    driver: {
      async drain() {
        drains += 1
        return { cancelled_requests: 0, outcome: 'drained' }
      },
    },
    gracePeriodMs: 10,
    now: () => 0,
    servers: new Map([['failing', failing], ['healthy', healthy]]),
    signalSource,
  })
  coordinator.start()
  assert.equal(coordinator.stop(), true)
  assert.equal(coordinator.stop(), false)
  signalSource.emit('SIGTERM')
  assert.equal(drains, 0)

  coordinator.start()
  signalSource.emit('SIGTERM')
  const result = await coordinator.result()
  assert.deepEqual(result, {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 1,
    outcome: 'partial-failure',
    signal: 'SIGTERM',
  })
  assert.equal(JSON.stringify(result).includes('private close detail'), false)
})

test('shutdown coordinator rejects drain outcomes with extra or unstable fields', async () => {
  for (const invalidOutcome of [
    { cancelled_requests: 0, outcome: 'drained', extra: true },
    { cancelled_requests: 0, outcome: 'drained', signal: 'SIGTERM' },
    { cancelled_requests: 0, outcome: 'unknown' },
  ]) {
    const signalSource = new EventEmitter()
    const server = fakeServer()
    const coordinator = createServerHttpShutdownCoordinator({
      driver: { async drain() { return invalidOutcome } },
      gracePeriodMs: 10,
      now: () => 0,
      servers: new Map([['api', server]]),
      signalSource,
    })
    coordinator.start()
    signalSource.emit('SIGTERM')
    assert.deepEqual(await coordinator.result(), {
      cancelled_requests: 0,
      closed_servers: 1,
      failed_servers: 0,
      outcome: 'partial-failure',
      signal: 'SIGTERM',
    })
    assert.equal(server.forceCalls, 1)
  }
})

test('shutdown coordinator snapshots drain outcome fields before classification and summary', async () => {
  const signalSource = new EventEmitter()
  const server = fakeServer()
  let cancelledReads = 0
  const outcome = new Proxy({}, {
    ownKeys() {
      return ['cancelled_requests', 'outcome']
    },
    getOwnPropertyDescriptor(_target, key) {
      return {
        configurable: true,
        enumerable: true,
      }
    },
    get(_target, key) {
      if (key === 'cancelled_requests') {
        cancelledReads += 1
        return cancelledReads === 1 ? 0 : 99
      }
      if (key === 'outcome') return 'drained'
      return undefined
    },
  })
  const coordinator = createServerHttpShutdownCoordinator({
    driver: { async drain() { return outcome } },
    gracePeriodMs: 10,
    now: () => 0,
    servers: new Map([['api', server]]),
    signalSource,
  })
  coordinator.start()
  signalSource.emit('SIGTERM')

  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'completed',
    signal: 'SIGTERM',
  })
  assert.equal(cancelledReads, 1)
})

test('shutdown coordinator rejects an invalid monotonic clock before draining', async () => {
  const signalSource = new EventEmitter()
  let drainCalls = 0
  const server = fakeServer()
  const coordinator = createServerHttpShutdownCoordinator({
    driver: {
      async drain() {
        drainCalls += 1
        return { cancelled_requests: 0, outcome: 'drained' }
      },
    },
    gracePeriodMs: 20,
    now: () => -1,
    servers: new Map([['api', server]]),
    signalSource,
  })

  coordinator.start()
  signalSource.emit('SIGTERM')
  assert.deepEqual(await coordinator.result(), {
    cancelled_requests: 0,
    closed_servers: 1,
    failed_servers: 0,
    outcome: 'partial-failure',
    signal: 'SIGTERM',
  })
  assert.equal(drainCalls, 0)
  assert.equal(server.forceCalls, 1)
})

function fakeServer({ closeError, waitForForce = false } = {}) {
  return {
    closeCalls: 0,
    forceCalls: 0,
    listening: true,
    pendingClose: null,
    close(callback) {
      this.closeCalls += 1
      this.listening = false
      if (waitForForce) {
        this.pendingClose = callback
      } else {
        callback(closeError)
      }
    },
    closeAllConnections() {
      this.forceCalls += 1
      this.pendingClose?.()
      this.pendingClose = null
    },
  }
}

function snapshotServer() {
  const server = fakeServer()
  const close = server.close
  const closeAllConnections = server.closeAllConnections
  let closeReads = 0
  let forceReads = 0
  Object.defineProperties(server, {
    close: {
      configurable: true,
      get() {
        closeReads += 1
        if (closeReads > 1) throw new Error('server close getter fault')
        return close
      },
    },
    closeAllConnections: {
      configurable: true,
      get() {
        forceReads += 1
        if (forceReads > 1) throw new Error('server force getter fault')
        return closeAllConnections
      },
    },
  })
  return server
}

function poisonBind(method) {
  Object.defineProperty(method, 'bind', {
    configurable: true,
    get() {
      throw new Error('method-owned bind fault')
    },
  })
}

function invoke(adapter, member, args) {
  return adapter.invoke(
    { interface: SERVER_HTTP_SERVER_REFERENCE, member },
    args,
  )
}

function okValue(result) {
  assert.equal(result.kind, 'value')
  assert.equal(result.value.kind, 'ok')
  return result.value.value
}
