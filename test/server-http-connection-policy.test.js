import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Agent, createServer, get } from 'node:http'
import test from 'node:test'

import {
  applyServerHttpConnectionPolicy,
} from '../src/host/server-http-connection-policy.js'

const POLICY = Object.freeze({
  connectionsCheckingInterval: 1_000,
  headersTimeout: 5_000,
  keepAliveTimeout: 2_000,
  maxHeadersCount: 64,
  maxRequestsPerSocket: 1,
  requestTimeout: 10_000,
})

test('connection policy validates exact fields, integer bounds, and timeout order', () => {
  const server = createServer()
  const servers = new Map([['api', server]])
  for (const policy of [
    { ...POLICY, extra: 1 },
    { ...POLICY, requestTimeout: -1 },
    { ...POLICY, maxRequestsPerSocket: 1.5 },
    { ...POLICY, connectionsCheckingInterval: 0 },
    { ...POLICY, headersTimeout: 20_000 },
  ]) {
    assert.throws(
      () => applyServerHttpConnectionPolicy({ policy, servers }),
      /invalid http server connection policy/u,
    )
  }
})

test('connection policy rolls every server back when one assignment fails', () => {
  const first = fakeServer()
  const second = fakeServer({ failProperty: 'keepAliveTimeout' })
  const before = snapshot(first)

  assert.throws(() => applyServerHttpConnectionPolicy({
    policy: POLICY,
    servers: new Map([['first', first], ['second', second]]),
  }), /http server connection policy apply failed/u)
  assert.deepEqual(snapshot(first), before)
  assert.deepEqual(snapshot(second), before)
})

test('connection policy orders server summaries by UTF-8 bytes', () => {
  const names = ['中', 'e\u0301', 'é', 'a']
  const servers = new Map(names.map((name) => [name, fakeServer()]))
  const handle = applyServerHttpConnectionPolicy({
    policy: POLICY,
    servers,
  })
  const expected = [...names].sort((left, right) => (
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
  ))

  assert.deepEqual(handle.apply(), {
    applied_servers: expected,
    ok: true,
  })
  assert.deepEqual(handle.restore(), {
    ok: true,
    restored_servers: expected,
  })
})

test('connection policy ignores overridden server registry iteration', () => {
  let spoofCalls = 0
  const legitimate = fakeServer()
  const spoof = fakeServer()
  const servers = new Map([['api', legitimate]])
  servers[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['api', spoof]
  }

  const handle = applyServerHttpConnectionPolicy({
    policy: POLICY,
    servers,
  })

  assert.equal(spoofCalls, 0)
  assert.deepEqual(handle.apply(), {
    applied_servers: ['api'],
    ok: true,
  })
  assert.deepEqual(snapshot(legitimate), POLICY)
  assert.deepEqual(snapshot(spoof), defaults())
  assert.deepEqual(handle.restore(), {
    ok: true,
    restored_servers: ['api'],
  })
})

test('connection policy apply and restore are idempotent and drift-safe', () => {
  const alpha = fakeServer()
  const beta = fakeServer()
  const mutablePolicy = { ...POLICY }
  const handle = applyServerHttpConnectionPolicy({
    policy: mutablePolicy,
    servers: new Map([['beta', beta], ['alpha', alpha]]),
  })
  assert.deepEqual(handle.apply(), {
    applied_servers: ['alpha', 'beta'],
    ok: true,
  })
  assert.deepEqual(snapshot(alpha), POLICY)
  mutablePolicy.keepAliveTimeout = 99
  assert.equal(alpha.keepAliveTimeout, 2_000)

  beta.keepAliveTimeout = 3_000
  assert.deepEqual(handle.restore(), {
    drifted_servers: ['beta'],
    ok: false,
    reason: 'external-drift',
  })
  assert.deepEqual(snapshot(alpha), POLICY)

  beta.keepAliveTimeout = 2_000
  const restored = handle.restore()
  assert.deepEqual(restored, {
    ok: true,
    restored_servers: ['alpha', 'beta'],
  })
  assert.deepEqual(handle.restore(), restored)
  assert.deepEqual(snapshot(alpha), defaults())
  assert.deepEqual(handle.apply(), {
    ok: false,
    reason: 'restored',
  })
})

test('connection policy keeps applied values after restore failure and allows retry', () => {
  const alpha = fakeServer()
  const beta = fakeServer({ failOnceProperty: 'keepAliveTimeout' })
  const handle = applyServerHttpConnectionPolicy({
    policy: POLICY,
    servers: new Map([['beta', beta], ['alpha', alpha]]),
  })

  assert.deepEqual(handle.restore(), {
    drifted_servers: [],
    ok: false,
    reason: 'restore-failed',
  })
  assert.deepEqual(snapshot(alpha), POLICY)
  assert.deepEqual(snapshot(beta), POLICY)

  assert.deepEqual(handle.restore(), {
    ok: true,
    restored_servers: ['alpha', 'beta'],
  })
  assert.deepEqual(snapshot(alpha), defaults())
  assert.deepEqual(snapshot(beta), defaults())
})

test('real Node server applies maxRequestsPerSocket and restores original properties', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const original = snapshot(server)
  const handle = applyServerHttpConnectionPolicy({
    policy: POLICY,
    servers: new Map([['api', server]]),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const agent = new Agent({ keepAlive: true })
  try {
    const response = await request(server, agent)
    assert.equal(response.status, 200)
    assert.equal(response.connection, 'close')
    assert.equal(response.body, 'ok')
  } finally {
    agent.destroy()
    await new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error))
    })
  }
  assert.deepEqual(handle.restore(), {
    ok: true,
    restored_servers: ['api'],
  })
  assert.deepEqual(snapshot(server), original)
})

function fakeServer({ failOnceProperty, failProperty } = {}) {
  const server = defaults()
  if (failOnceProperty !== undefined) {
    let value = server[failOnceProperty]
    let failed = false
    Object.defineProperty(server, failOnceProperty, {
      configurable: true,
      enumerable: true,
      get() {
        return value
      },
      set(next) {
        if (!failed && next === defaults()[failOnceProperty]) {
          failed = true
          throw new Error('transient setter failure')
        }
        value = next
      },
    })
  }
  if (failProperty !== undefined) {
    let value = server[failProperty]
    Object.defineProperty(server, failProperty, {
      configurable: true,
      enumerable: true,
      get() {
        return value
      },
      set(next) {
        if (next === POLICY[failProperty]) throw new Error('private setter failure')
        value = next
      },
    })
  }
  return server
}

function defaults() {
  return {
    connectionsCheckingInterval: 30_000,
    headersTimeout: 60_000,
    keepAliveTimeout: 5_000,
    maxHeadersCount: null,
    maxRequestsPerSocket: 0,
    requestTimeout: 300_000,
  }
}

function snapshot(server) {
  return Object.fromEntries(Object.keys(POLICY).sort().map((key) => [key, server[key]]))
}

async function request(server, agent) {
  const address = server.address()
  return new Promise((resolve, reject) => {
    get({
      agent,
      host: '127.0.0.1',
      path: '/',
      port: address.port,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.once('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        connection: response.headers.connection,
        status: response.statusCode,
      }))
    }).once('error', reject)
  })
}
