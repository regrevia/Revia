import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import {
  createServerHttpServerNodeDriver,
} from '../src/host/server-http-server-node-driver.js'
import {
  ServerHttpServerSocketAdapter,
} from '../src/host/server-http-server-socket-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_HTTP_SERVER_REFERENCE,
} from '../src/host/server-profile.js'

test('Node HTTP server driver completes a real loopback lifecycle through the profile', async () => {
  const fixture = await createFixture()
  try {
    const accept = invokeProfile(fixture.bound, 'accept', { listener: 'api' }, 'accept')
    const responsePromise = fetch(`${fixture.url}/users/42`, {
      body: 'ping',
      headers: { 'content-type': 'text/plain', 'x-platform-test': 'node' },
      method: 'POST',
    })
    const requestToken = okValue(await accept)

    assert.equal(okValue(await invokeProfile(
      fixture.bound,
      'method',
      { request: requestToken },
      'method',
    )), 'POST')
    assert.equal(okValue(await invokeProfile(
      fixture.bound,
      'path',
      { request: requestToken },
      'path',
    )), '/users/42')
    const headers = okValue(await invokeProfile(
      fixture.bound,
      'headers',
      { request: requestToken },
      'headers',
    ))
    assert.equal(headers.split('\n').includes('x-platform-test:node'), true)
    assert.equal(okValue(await invokeProfile(
      fixture.bound,
      'route_params',
      { request: requestToken },
      'route-params',
    )), '{}')
    assert.deepEqual(okValue(await invokeProfile(
      fixture.bound,
      'body',
      { limit: 4, request: requestToken },
      'body',
    )), new Uint8Array(Buffer.from('ping')))
    assert.deepEqual(await invokeProfile(fixture.bound, 'respond', {
      body: new Uint8Array(Buffer.from('created')),
      headers: 'content-type:text/plain\nx-driver:node',
      request: requestToken,
      status: 201,
    }, 'respond'), ok(null))

    const response = await responsePromise
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('x-driver'), 'node')
    assert.equal(await response.text(), 'created')
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver rejects invalid response headers without cancelling the request', async () => {
  const fixture = await createFixture()
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/invalid-header`)
    const token = okValue(await accept)

    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: 'x-invalid:\uD800',
      request: token,
      status: 200,
    }), declaredError('invalid_request'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: 'x-invalid:\u0000',
      request: token,
      status: 200,
    }), declaredError('invalid_request'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: '',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_end', {
      request: token,
    }), ok(null))
    assert.equal((await responsePromise).status, 200)
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver rejects malformed request header values', async () => {
  const fixture = await createFixture()
  try {
    fixture.server.prependListener('request', (request) => {
      request.headers['x-null'] = null
      request.headers['x-control'] = 'bad\u0000value'
    })
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/malformed-request-header`)
    const token = okValue(await accept)

    assert.deepEqual(
      invoke(fixture.adapter, 'headers', { request: token }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: token }),
      ok(null),
    )
    await responsePromise.catch(() => {})
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver rejects malformed request method and path', async () => {
  const fixture = await createFixture()
  try {
    fixture.server.prependListener('request', (request) => {
      request.method = 'bad method'
      request.url = '/bad\u0000path'
    })
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/request-metadata`)
    const token = okValue(await accept)

    assert.deepEqual(
      invoke(fixture.adapter, 'method', { request: token }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      invoke(fixture.adapter, 'path', { request: token }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: token }),
      ok(null),
    )
    await responsePromise.catch(() => {})
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver rejects unpaired surrogates without rejecting astral text', async () => {
  const fixture = await createFixture()
  try {
    fixture.server.prependListener('request', (request) => {
      if (request.url === '/invalid-utf8') {
        request.url = '/bad\uD800'
        request.headers['x-text'] = 'bad\uD800'
      } else {
        request.url = '/valid-\u{1F600}'
        request.headers['x-text'] = 'valid-\u{1F600}'
      }
    })

    const invalidAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const invalidResponse = fetch(`${fixture.url}/invalid-utf8`).catch(() => null)
    const invalidToken = okValue(await invalidAccept)
    assert.deepEqual(
      invoke(fixture.adapter, 'path', { request: invalidToken }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      invoke(fixture.adapter, 'headers', { request: invalidToken }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: invalidToken }),
      ok(null),
    )
    await invalidResponse

    const validAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const validResponse = fetch(`${fixture.url}/valid-utf8`).catch(() => null)
    const validToken = okValue(await validAccept)
    assert.deepEqual(
      invoke(fixture.adapter, 'path', { request: validToken }),
      ok('/valid-\u{1F600}'),
    )
    assert.match(
      okValue(invoke(fixture.adapter, 'headers', { request: validToken })),
      /(?:^|\n)x-text:valid-\u{1F600}(?:\n|$)/u,
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: validToken }),
      ok(null),
    )
    await validResponse
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver streams bounded response chunks in order', async () => {
  const fixture = await createFixture({
    driverOptions: {
      maxResponseBytes: 3,
      maxResponseChunkBytes: 2,
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/stream`)
    const token = okValue(await accept)

    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: 'content-type:text/plain',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(1, 2),
      request: token,
    }), ok('ready'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(3),
      request: token,
    }), ok('ready'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_drain', {
      request: token,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_end', {
      request: token,
    }), ok(null))

    const response = await responsePromise
    assert.equal(response.status, 200)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(1, 2, 3))
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver exposes blocked writes and FIFO drain wait', async () => {
  const fixture = await createFixture({
    driverOptions: {
      writeResponse(response, body) {
        response.write(body)
        return false
      },
      waitForResponseDrain: () => new Promise((resolve) => setImmediate(resolve)),
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/stream-blocked`)
    const token = okValue(await accept)

    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: 'content-type:text/plain',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(1),
      request: token,
    }), ok('blocked'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(2),
      request: token,
    }), declaredError('unavailable'))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_drain', {
      request: token,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(2),
      request: token,
    }), ok('blocked'))
    await invoke(fixture.adapter, 'respond_drain', { request: token })
    await invoke(fixture.adapter, 'respond_end', { request: token })

    const response = await responsePromise
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(1, 2))
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver terminates a response stream on bounded overflow', async () => {
  const fixture = await createFixture({
    driverOptions: {
      maxResponseBytes: 2,
      maxResponseChunkBytes: 2,
      waitForResponseDrain: () => new Promise(() => {}),
      writeResponse(response, body) {
        response.write(body)
        return false
      },
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/stream-overflow`).catch(() => null)
    const token = okValue(await accept)

    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: '',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(1),
      request: token,
    }), ok('blocked'))
    const drain = invoke(fixture.adapter, 'respond_drain', { request: token })
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(2, 3),
      request: token,
    }), declaredError('body_too_large'))
    assert.deepEqual(await drain, declaredError('body_too_large'))
    await responsePromise
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver settles a drain waiter when response ends', async () => {
  const fixture = await createFixture({
    driverOptions: {
      waitForResponseDrain: () => new Promise(() => {}),
      writeResponse(response, body) {
        response.write(body)
        return false
      },
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/stream-end-waiter`)
    const token = okValue(await accept)
    await invoke(fixture.adapter, 'respond_start', {
      headers: '',
      request: token,
      status: 200,
    })
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(1),
      request: token,
    }), ok('blocked'))
    const drain = invoke(fixture.adapter, 'respond_drain', { request: token })
    assert.deepEqual(await invoke(fixture.adapter, 'respond_end', {
      request: token,
    }), ok(null))
    assert.deepEqual(await drain, ok(null))
    await responsePromise
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver closes a blocked drain waiter on cancel', async () => {
  const fixture = await createFixture({
    driverOptions: {
      waitForResponseDrain: () => new Promise(() => {}),
      writeResponse(response, body) {
        response.write(body)
        return false
      },
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/stream-cancel`).catch(() => null)
    const token = okValue(await accept)

    assert.deepEqual(await invoke(fixture.adapter, 'respond_start', {
      headers: '',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond_chunk', {
      body: Uint8Array.of(1),
      request: token,
    }), ok('blocked'))
    const drain = invoke(fixture.adapter, 'respond_drain', { request: token })
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: token }),
      ok(null),
    )
    assert.deepEqual(await drain, declaredError('cancelled'))
    await responsePromise
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver enforces body limits and closes repeated terminal calls', async () => {
  const fixture = await createFixture()
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const responsePromise = fetch(`${fixture.url}/upload`, {
      body: 'oversized',
      method: 'POST',
    })
    const requestToken = okValue(await accept)

    assert.deepEqual(
      await invoke(fixture.adapter, 'body', { limit: -1, request: requestToken }),
      declaredError('invalid_request'),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'body', { limit: 3, request: requestToken }),
      declaredError('body_too_large'),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'body', { limit: 100, request: requestToken }),
      declaredError('body_too_large'),
    )
    assert.deepEqual(await invoke(fixture.adapter, 'respond', {
      body: new Uint8Array(),
      headers: '',
      request: requestToken,
      status: 413,
    }), ok(null))
    assert.deepEqual(await invoke(fixture.adapter, 'respond', {
      body: new Uint8Array(),
      headers: '',
      request: requestToken,
      status: 200,
    }), declaredError('invalid_request'))
    assert.equal((await responsePromise).status, 413)
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server byte snapshots use typed array internal authority', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  try {
    const events = new EventEmitter()
    const request = {
      destroy() {},
      headers: {},
      method: 'POST',
      off: events.off.bind(events),
      on: events.on.bind(events),
      once: events.once.bind(events),
      resume() {},
      url: '/request-bytes',
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = driver.accept({ listener: 'api' })
    onRequest(request, responseHandle)
    const token = await tokenPromise
    class SpoofLengthBytes extends Uint8Array {
      get length() {
        return 0
      }
    }

    const body = driver.body({ limit: 1, request: token })
    events.emit('data', new SpoofLengthBytes([0x11, 0x22]))
    events.emit('end')
    assert.deepEqual(await body, { error: 'body_too_large' })

    const proxyBytes = new Proxy(new Uint8Array([0x11, 0x22]), {
      get(target, name, receiver) {
        if (name === Symbol.iterator) {
          return function* spoofBytes() {
            yield 0x33
          }
        }
        return Reflect.get(target, name, receiver)
      },
    })
    assert.deepEqual(driver.respond({
      body: proxyBytes,
      headers: '',
      request: token,
      status: 413,
    }), { error: 'invalid_request' })
    assert.equal(driver.respond_start({
      headers: '',
      request: token,
      status: 413,
    }), null)
    assert.deepEqual(driver.respond_chunk({
      body: proxyBytes,
      request: token,
    }), { error: 'invalid_request' })

    const invalidEvents = new EventEmitter()
    const invalidTokenPromise = driver.accept({ listener: 'api' })
    onRequest({
      ...request,
      off: invalidEvents.off.bind(invalidEvents),
      on: invalidEvents.on.bind(invalidEvents),
      once: invalidEvents.once.bind(invalidEvents),
      url: '/invalid-request-bytes',
    }, responseHandle)
    const invalidToken = await invalidTokenPromise
    const invalidBody = driver.body({ limit: 1, request: invalidToken })
    invalidEvents.emit('data', 'not-bytes')
    assert.deepEqual(await invalidBody, { error: 'unavailable' })
  } finally {
    driver.close()
  }
})

test('concurrent body calls project the same read through each requested limit', async () => {
  const fixture = await createFixture()
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = httpRequest(`${fixture.url}/concurrent-body`, { method: 'POST' })
    const responsePromise = once(client, 'response').then(([response]) => response)
    client.once('error', () => {})
    client.write('a')
    const requestToken = okValue(await accept)

    const highLimit = invoke(
      fixture.adapter,
      'body',
      { limit: 2, request: requestToken },
    )
    const lowLimit = invoke(
      fixture.adapter,
      'body',
      { limit: 1, request: requestToken },
    )
    client.end('b')

    assert.deepEqual(
      await highLimit,
      ok(new Uint8Array(Buffer.from('ab'))),
    )
    assert.deepEqual(await lowLimit, declaredError('body_too_large'))
    await invoke(fixture.adapter, 'respond', response(requestToken, 'done'))
    const clientResponse = await responsePromise
    clientResponse.resume()
    await once(clientResponse, 'end')
  } finally {
    await fixture.close()
  }
})

test('content length over the first body limit fails before payload data arrives', async () => {
  const fixture = await createFixture()
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = httpRequest(`${fixture.url}/content-length`, {
      headers: { 'content-length': '4' },
      method: 'POST',
    })
    client.once('error', () => {})
    client.flushHeaders()
    const requestToken = okValue(await accept)

    const outcome = await Promise.race([
      invoke(fixture.adapter, 'body', { limit: 2, request: requestToken }),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 20)),
    ])
    assert.deepEqual(outcome, declaredError('body_too_large'))
    assert.deepEqual(
      await invoke(fixture.adapter, 'body', { limit: 4, request: requestToken }),
      declaredError('body_too_large'),
    )
    await invoke(fixture.adapter, 'respond', {
      body: new Uint8Array(),
      headers: '',
      request: requestToken,
      status: 413,
    })
    client.destroy()
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver maps explicit cancel and client disconnect to cancelled', async () => {
  const fixture = await createFixture()
  try {
    const explicitAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const cancelledClient = fetch(`${fixture.url}/cancel`).catch(() => null)
    const explicitToken = okValue(await explicitAccept)
    assert.deepEqual(
      await invoke(fixture.adapter, 'cancel', { request: explicitToken }),
      ok(null),
    )
    assert.deepEqual(
      await invoke(fixture.adapter, 'method', { request: explicitToken }),
      declaredError('cancelled'),
    )
    await cancelledClient

    const disconnectAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = httpRequest(`${fixture.url}/disconnect`, { method: 'POST' })
    client.on('error', () => {})
    client.write('partial')
    const disconnectToken = okValue(await disconnectAccept)
    client.destroy()
    assert.deepEqual(
      await waitForCancelled(fixture.adapter, disconnectToken),
      declaredError('cancelled'),
    )
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver keeps concurrent request tokens and responses isolated', async () => {
  const fixture = await createFixture()
  try {
    const accepts = [
      invoke(fixture.adapter, 'accept', { listener: 'api' }),
      invoke(fixture.adapter, 'accept', { listener: 'api' }),
    ]
    const clients = [
      fetch(`${fixture.url}/one`),
      fetch(`${fixture.url}/two`),
    ]
    const tokens = await Promise.all(accepts).then((results) => results.map(okValue))
    assert.notEqual(tokens[0], tokens[1])
    const byPath = new Map()
    for (const token of tokens) {
      byPath.set(okValue(await invoke(fixture.adapter, 'path', { request: token })), token)
    }

    await invoke(fixture.adapter, 'respond', response(byPath.get('/two'), 'two'))
    await invoke(fixture.adapter, 'respond', response(byPath.get('/one'), 'one'))
    assert.deepEqual(await Promise.all(clients).then(async (responses) => Promise.all(
      responses.map((item) => item.text()),
    )), ['one', 'two'])
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server driver ignores overridden listener registry iteration', () => {
  let spoofCalls = 0
  const legitimate = createServer()
  const spoof = createServer()
  const listeners = new Map([['api', legitimate]])
  listeners[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['api', spoof]
  }

  const driver = createServerHttpServerNodeDriver({ listeners })

  assert.equal(spoofCalls, 0)
  assert.equal(legitimate.listenerCount('request'), 1)
  assert.equal(spoof.listenerCount('request'), 0)
  driver.close()
  assert.equal(legitimate.listenerCount('request'), 0)
})

test('Node HTTP server driver snapshots listener capabilities before later faults', () => {
  let onReads = 0
  let offReads = 0
  let onCalls = 0
  let offCalls = 0
  let onReceiver = null
  let offReceiver = null
  const on = function (event, listener) {
    onCalls += 1
    onReceiver = this
    assert.equal(event, 'request')
    assert.equal(typeof listener, 'function')
  }
  const off = function (event, listener) {
    offCalls += 1
    offReceiver = this
    assert.equal(event, 'request')
    assert.equal(typeof listener, 'function')
  }
  for (const method of [on, off]) {
    Object.defineProperty(method, 'bind', {
      get() {
        throw new Error('method bind fault')
      },
    })
  }
  const server = {
    get off() {
      offReads += 1
      if (offReads > 1) throw new Error('off getter fault')
      return off
    },
    get on() {
      onReads += 1
      if (onReads > 1) throw new Error('on getter fault')
      return on
    },
  }

  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })

  assert.equal(onReads, 1)
  assert.equal(offReads, 1)
  assert.equal(onCalls, 1)
  assert.equal(onReceiver, server)
  driver.close()
  assert.equal(offCalls, 1)
  assert.equal(offReceiver, server)
  assert.equal(onReads, 1)
  assert.equal(offReads, 1)
})

test('Node HTTP server route registry returns stable decoded params and prefers static routes', async () => {
  const routes = new Map([['api', [
    { method: 'GET', pattern: '/users/:id' },
    { method: 'GET', pattern: '/users/new' },
  ]]])
  const fixture = await createFixture({ routes })
  routes.get('api')[0].pattern = '/mutated/:id'
  try {
    const dynamicAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const dynamicClient = fetch(`${fixture.url}/users/alice%20smith?view=full`)
    const dynamicToken = okValue(await dynamicAccept)
    assert.equal(okValue(await invoke(
      fixture.adapter,
      'route_params',
      { request: dynamicToken },
    )), '{"id":"alice smith"}')
    await invoke(fixture.adapter, 'respond', response(dynamicToken, 'dynamic'))
    assert.equal(await (await dynamicClient).text(), 'dynamic')

    const staticAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const staticClient = fetch(`${fixture.url}/users/new`)
    const staticToken = okValue(await staticAccept)
    assert.equal(okValue(await invoke(
      fixture.adapter,
      'route_params',
      { request: staticToken },
    )), '{}')
    await invoke(fixture.adapter, 'respond', response(staticToken, 'static'))
    assert.equal(await (await staticClient).text(), 'static')
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server route registry ignores overridden iteration and array methods', async () => {
  let registrySpoofCalls = 0
  let definitionSpoofCalls = 0
  const definitions = [{ method: 'GET', pattern: '/legitimate' }]
  definitions.map = function () {
    definitionSpoofCalls += 1
    return [{
      method: 'GET',
      pattern: '/spoof',
      segments: [{ kind: 'static', value: 'spoof' }],
      specificity: 1,
    }]
  }
  const routes = new Map([['api', definitions]])
  routes[Symbol.iterator] = function* () {
    registrySpoofCalls += 1
    yield ['api', definitions]
  }
  const fixture = await createFixture({ routes })

  try {
    assert.equal(registrySpoofCalls, 0)
    assert.equal(definitionSpoofCalls, 0)
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = fetch(`${fixture.url}/legitimate`)
    const token = okValue(await accept)
    await invoke(fixture.adapter, 'respond', response(token, 'legitimate'))
    assert.equal(await (await client).text(), 'legitimate')
  } finally {
    await fixture.close()
  }
})

test('Node HTTP server route definitions are snapshotted before later faults', async () => {
  let methodReads = 0
  let patternReads = 0
  const definition = {}
  Object.defineProperties(definition, {
    method: {
      enumerable: true,
      get() {
        methodReads += 1
        if (methodReads > 1) throw new Error('method getter fault')
        return 'GET'
      },
    },
    pattern: {
      enumerable: true,
      get() {
        patternReads += 1
        if (patternReads > 1) throw new Error('pattern getter fault')
        return '/legitimate/:id'
      },
    },
  })
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let driver = null

  try {
    driver = createServerHttpServerNodeDriver({
      listeners: new Map([['api', server]]),
      routes: new Map([['api', [definition]]]),
    })
    const adapter = new ServerHttpServerSocketAdapter({ driver })
    assert.equal(methodReads, 1)
    assert.equal(patternReads, 1)
    const accept = invoke(adapter, 'accept', { listener: 'api' })
    const client = fetch(serverUrl(server, '/legitimate/42'))
    const token = okValue(await accept)
    assert.equal(okValue(await invoke(
      adapter,
      'route_params',
      { request: token },
    )), '{"id":"42"}')
    await invoke(adapter, 'respond', response(token, 'legitimate'))
    assert.equal(await (await client).text(), 'legitimate')
  } finally {
    driver?.close()
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error))
    })
  }
})

test('Node HTTP server request metadata is snapshotted before later faults', async () => {
  let methodReads = 0
  let urlReads = 0
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [{ method: 'GET', pattern: '/legitimate/:id' }]]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const request = {
      destroy() {},
      headers: {},
      get method() {
        methodReads += 1
        if (methodReads > 1) throw new Error('request method getter fault')
        return 'GET'
      },
      off() {},
      on() {},
      once() {},
      resume() {},
      get url() {
        urlReads += 1
        return urlReads === 1 ? '/legitimate/42' : '/spoof/99'
      },
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const accept = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    assert.equal(methodReads, 1)
    assert.equal(urlReads, 1)
    const token = okValue(await accept)
    assert.equal(okValue(await invoke(
      adapter,
      'route_params',
      { request: token },
    )), '{"id":"42"}')
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server accepted request metadata stays frozen after dispatch', async () => {
  let methodReads = 0
  let urlReads = 0
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [{ method: 'GET', pattern: '/legitimate/:id' }]]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const request = {
      destroy() {},
      headers: {},
      get method() {
        methodReads += 1
        return methodReads === 1 ? 'GET' : 'POST'
      },
      off() {},
      on() {},
      once() {},
      resume() {},
      get url() {
        urlReads += 1
        return urlReads === 1 ? '/legitimate/42?source=original' : '/spoof/99'
      },
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const accept = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await accept)

    assert.equal(okValue(await invoke(adapter, 'method', { request: token })), 'GET')
    assert.equal(okValue(await invoke(adapter, 'path', { request: token })),
      '/legitimate/42?source=original')
    assert.equal(methodReads, 1)
    assert.equal(urlReads, 1)
    assert.equal(okValue(await invoke(
      adapter,
      'route_params',
      { request: token },
    )), '{"id":"42"}')
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server accepted request headers stay frozen after dispatch', async () => {
  let headerReads = 0
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [{ method: 'GET', pattern: '/legitimate/:id' }]]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const requestEvents = new EventEmitter()
    const request = {
      destroy() {},
      method: 'GET',
      off: requestEvents.off.bind(requestEvents),
      on: requestEvents.on.bind(requestEvents),
      once: requestEvents.once.bind(requestEvents),
      resume() {},
      url: '/legitimate/42',
      get headers() {
        headerReads += 1
        return headerReads === 1
          ? { 'content-length': '0', 'x-original': 'legitimate' }
          : { 'content-length': '5', 'x-original': 'spoof' }
      },
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.equal(okValue(await invoke(adapter, 'headers', { request: token })),
      'content-length:0\nx-original:legitimate')
    assert.equal(headerReads, 1)
    const body = invoke(adapter, 'body', { limit: 4, request: token })
    requestEvents.emit('end')
    assert.deepEqual(okValue(await body), new Uint8Array())
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server request envelope precedes response capability side effects', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [
      { method: 'GET', pattern: '/legitimate/:id' },
      { method: 'POST', pattern: '/spoof/:id' },
    ]]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const request = {
      destroy() {},
      headers: { 'x-original': 'legitimate' },
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/legitimate/42',
    }
    const responseHandle = {
      statusCode: 0,
      writableEnded: false,
      get destroy() {
        request.method = 'POST'
        request.url = '/spoof/99'
        request.headers = { 'x-original': 'spoof' }
        return function () {}
      },
      end() {},
      once() {},
      setHeader() {},
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.equal(okValue(await invoke(adapter, 'method', { request: token })), 'GET')
    assert.equal(okValue(await invoke(adapter, 'path', { request: token })),
      '/legitimate/42')
    assert.equal(okValue(await invoke(adapter, 'headers', { request: token })),
      'x-original:legitimate')
    assert.equal(okValue(await invoke(adapter, 'route_params', { request: token })),
      '{"id":"42"}')
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server header field descriptors precede getter side effects', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const headers = {}
    Object.defineProperty(headers, 'x-trigger', {
      enumerable: true,
      get() {
        headers['content-length'] = '5'
        return 'legitimate'
      },
    })
    headers['content-length'] = '0'
    const events = new EventEmitter()
    const request = {
      destroy() {},
      headers,
      method: 'GET',
      off: events.off.bind(events),
      on: events.on.bind(events),
      once: events.once.bind(events),
      resume() {},
      url: '/header-field-descriptors',
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.equal(okValue(await invoke(adapter, 'headers', { request: token })),
      'content-length:0\nx-trigger:legitimate')
    const body = invoke(adapter, 'body', { limit: 4, request: token })
    events.emit('end')
    assert.deepEqual(okValue(await body), new Uint8Array())
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server header value lists ignore overridden array methods', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const values = ['legitimate']
    let joinCalls = 0
    let someCalls = 0
    values.join = () => {
      joinCalls += 1
      return 'spoof'
    }
    values.some = () => {
      someCalls += 1
      return false
    }
    const request = {
      destroy() {},
      headers: { 'x-list': values },
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/header-value-list',
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.equal(okValue(await invoke(adapter, 'headers', { request: token })),
      'x-list:legitimate')
    assert.equal(joinCalls, 0)
    assert.equal(someCalls, 0)
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server accepted request capabilities stay frozen after dispatch', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const events = new EventEmitter()
    const reads = { destroy: 0, off: 0, on: 0, once: 0, resume: 0 }
    const calls = { destroy: 0, off: 0, on: 0, once: 0, resume: 0 }
    let methodBindReads = 0
    const capability = (name, operation) => {
      const method = function (...args) {
        assert.equal(this, request)
        calls[name] += 1
        return operation(...args)
      }
      Object.defineProperty(method, 'bind', {
        get() {
          methodBindReads += 1
          throw new Error('method-owned bind getter fault')
        },
      })
      return method
    }
    const request = {
      get destroy() {
        reads.destroy += 1
        if (reads.destroy > 1) throw new Error('destroy getter fault')
        return capability('destroy', () => {})
      },
      headers: {},
      method: 'GET',
      get off() {
        reads.off += 1
        if (reads.off > 1) throw new Error('off getter fault')
        return capability('off', (...args) => events.off(...args))
      },
      get on() {
        reads.on += 1
        if (reads.on > 1) throw new Error('on getter fault')
        return capability('on', (...args) => events.on(...args))
      },
      get once() {
        reads.once += 1
        if (reads.once > 1) throw new Error('once getter fault')
        return capability('once', (...args) => events.once(...args))
      },
      get resume() {
        reads.resume += 1
        if (reads.resume > 1) throw new Error('resume getter fault')
        return capability('resume', () => {})
      },
      url: '/capabilities',
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.deepEqual(reads, { destroy: 1, off: 1, on: 1, once: 1, resume: 1 })
    const body = invoke(adapter, 'body', { limit: 1, request: token })
    events.emit('data', Buffer.from('xx'))
    assert.deepEqual(await body, declaredError('body_too_large'))
    assert.deepEqual(await invoke(adapter, 'cancel', { request: token }), ok(null))
    assert.deepEqual(reads, { destroy: 1, off: 1, on: 1, once: 1, resume: 1 })
    assert.deepEqual(calls, { destroy: 1, off: 4, on: 1, once: 4, resume: 1 })
    assert.equal(methodBindReads, 0)
  } finally {
    driver.close()
  }
})

test('Node HTTP server request capability descriptors precede getter side effects', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    let originalOnceCalls = 0
    let spoofOnceCalls = 0
    const request = {
      get destroy() {
        request.once = function () {
          spoofOnceCalls += 1
        }
        return function () {}
      },
      headers: {},
      method: 'GET',
      off() {},
      on() {},
      once() {
        originalOnceCalls += 1
      },
      resume() {},
      url: '/request-capability-descriptors',
    }
    const responseHandle = {
      destroy() {},
      end() {},
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.equal(originalOnceCalls, 1)
    assert.equal(spoofOnceCalls, 0)
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(),
    }), ok(null))
  } finally {
    driver.close()
  }
})

test('Node HTTP server accepted response capabilities stay frozen after dispatch', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const reads = { destroy: 0, end: 0, once: 0, write: 0, writeHead: 0 }
    const calls = { destroy: 0, end: 0, once: 0, write: 0, writeHead: 0 }
    let methodBindReads = 0
    const capability = (name, operation) => {
      const method = function (...args) {
        assert.equal(this, responseHandle)
        calls[name] += 1
        return operation(...args)
      }
      Object.defineProperty(method, 'bind', {
        get() {
          methodBindReads += 1
          throw new Error('method-owned bind getter fault')
        },
      })
      return method
    }
    const responseHandle = {
      get destroy() {
        reads.destroy += 1
        if (reads.destroy > 1) throw new Error('destroy getter fault')
        return capability('destroy', () => {})
      },
      get end() {
        reads.end += 1
        if (reads.end > 1) throw new Error('end getter fault')
        return capability('end', (body) => {
          assert.deepEqual(new Uint8Array(body), new Uint8Array(Buffer.from('legitimate')))
          throw new Error('end host fault')
        })
      },
      get once() {
        reads.once += 1
        if (reads.once > 1) throw new Error('once getter fault')
        return capability('once', () => {})
      },
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      get write() {
        reads.write += 1
        if (reads.write > 1) throw new Error('write getter fault')
        return capability('write', () => true)
      },
      get writeHead() {
        reads.writeHead += 1
        if (reads.writeHead > 1) throw new Error('writeHead getter fault')
        return capability('writeHead', (status, headers) => {
          assert.equal(status, 200)
          assert.deepEqual(headers, { 'content-type': 'text/plain' })
        })
      },
    }
    const request = {
      destroy() {},
      headers: {},
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/response-capabilities',
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.deepEqual(reads, { destroy: 1, end: 1, once: 1, write: 1, writeHead: 1 })
    assert.deepEqual(await invoke(adapter, 'respond', {
      ...response(token, 'legitimate'),
      body: new Uint8Array(Buffer.from('legitimate')),
    }), declaredError('unavailable'))
    assert.deepEqual(reads, { destroy: 1, end: 1, once: 1, write: 1, writeHead: 1 })
    assert.deepEqual(calls, { destroy: 1, end: 1, once: 1, write: 0, writeHead: 1 })
    assert.equal(methodBindReads, 0)
  } finally {
    driver.close()
  }
})

test('Node HTTP server response transport uses frozen write and drain capabilities', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const events = new EventEmitter()
    let methodBindReads = 0
    let onceReads = 0
    let writeReads = 0
    let onceCalls = 0
    let writeCalls = 0
    const capability = (operation) => {
      const method = function (...args) {
        assert.equal(this, responseHandle)
        return operation(...args)
      }
      Object.defineProperty(method, 'bind', {
        get() {
          methodBindReads += 1
          throw new Error('method-owned bind getter fault')
        },
      })
      return method
    }
    const responseHandle = {
      destroy() {},
      end() {},
      get once() {
        onceReads += 1
        if (onceReads > 1) throw new Error('once getter fault')
        return capability((...args) => {
          onceCalls += 1
          return events.once(...args)
        })
      },
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      get write() {
        writeReads += 1
        if (writeReads > 1) throw new Error('write getter fault')
        return capability((body) => {
          writeCalls += 1
          assert.deepEqual(new Uint8Array(body), new Uint8Array(Buffer.from('chunk')))
          return false
        })
      },
      writeHead() {},
    }
    const request = {
      destroy() {},
      headers: {},
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/response-transport',
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)

    assert.deepEqual(await invoke(adapter, 'respond_start', {
      headers: '',
      request: token,
      status: 200,
    }), ok(null))
    assert.deepEqual(await invoke(adapter, 'respond_chunk', {
      body: new Uint8Array(Buffer.from('chunk')),
      request: token,
    }), ok('blocked'))
    const drain = invoke(adapter, 'respond_drain', { request: token })
    events.emit('drain')
    assert.deepEqual(await drain, ok(null))
    assert.deepEqual(await invoke(adapter, 'respond_end', { request: token }), ok(null))
    assert.equal(onceReads, 1)
    assert.equal(writeReads, 1)
    assert.equal(onceCalls, 2)
    assert.equal(writeCalls, 1)
    assert.equal(methodBindReads, 0)
  } finally {
    driver.close()
  }
})

test('Node HTTP server pre-accept rejection uses one response capability snapshot', () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const handler = onRequest
  driver.close()

  const names = ['destroy', 'end', 'once', 'setHeader', 'write', 'writeHead']
  const reads = Object.fromEntries(names.map((name) => [name, 0]))
  const calls = Object.fromEntries(names.map((name) => [name, 0]))
  let methodBindReads = 0
  const responseHandle = { statusCode: 0, writableEnded: false }
  for (const name of names) {
    Object.defineProperty(responseHandle, name, {
      get() {
        reads[name] += 1
        if (reads[name] > 1) throw new Error(`${name} getter fault`)
        const method = function (...args) {
          assert.equal(this, responseHandle)
          calls[name] += 1
          if (name === 'setHeader') assert.deepEqual(args, ['connection', 'close'])
        }
        Object.defineProperty(method, 'bind', {
          get() {
            methodBindReads += 1
            throw new Error('method-owned bind getter fault')
          },
        })
        return method
      },
    })
  }

  handler({}, responseHandle)
  assert.equal(responseHandle.statusCode, 503)
  assert.deepEqual(reads, {
    destroy: 1,
    end: 1,
    once: 1,
    setHeader: 1,
    write: 1,
    writeHead: 1,
  })
  assert.deepEqual(calls, {
    destroy: 0,
    end: 1,
    once: 0,
    setHeader: 1,
    write: 0,
    writeHead: 0,
  })
  assert.equal(methodBindReads, 0)
})

test('Node HTTP server close uses the frozen writableEnded observer', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  try {
    const events = new EventEmitter()
    let methodBindReads = 0
    let observerCalls = 0
    const responsePrototype = {}
    const writableEndedGetter = function () {
      assert.equal(this, responseHandle)
      observerCalls += 1
      return false
    }
    Object.defineProperty(writableEndedGetter, 'bind', {
      get() {
        methodBindReads += 1
        throw new Error('getter-owned bind fault')
      },
    })
    Object.defineProperty(responsePrototype, 'writableEnded', {
      configurable: true,
      get: writableEndedGetter,
    })
    const responseHandle = Object.assign(Object.create(responsePrototype), {
      destroy() {},
      end() {},
      once: events.once.bind(events),
      setHeader() {},
      statusCode: 0,
      write() {},
      writeHead() {},
    })
    const request = {
      destroy() {},
      headers: {},
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/writable-ended',
    }
    const tokenPromise = invoke(adapter, 'accept', { listener: 'api' })
    onRequest(request, responseHandle)
    const token = okValue(await tokenPromise)
    Object.defineProperty(responseHandle, 'writableEnded', {
      get() {
        throw new Error('shadow writableEnded getter fault')
      },
    })

    events.emit('close')
    assert.deepEqual(await invoke(adapter, 'path', { request: token }),
      declaredError('cancelled'))
    assert.equal(observerCalls, 1)
    assert.equal(methodBindReads, 0)
  } finally {
    driver.close()
  }
})

test('Node HTTP server rejection uses the frozen statusCode writer', () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const handler = onRequest
  driver.close()

  let spoofWrites = 0
  const responseHandle = {
    statusCode: 0,
    writableEnded: false,
    get destroy() {
      Object.defineProperty(responseHandle, 'statusCode', {
        configurable: true,
        set() {
          spoofWrites += 1
        },
      })
      return function () {}
    },
    end() {},
    once() {},
    setHeader() {},
    write() {},
    writeHead() {},
  }
  handler({}, responseHandle)
  assert.equal(responseHandle.statusCode, 503)
  assert.equal(spoofWrites, 0)
})

test('Node HTTP server response method descriptors precede getter side effects', () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
  })
  const handler = onRequest
  driver.close()

  let originalEndCalls = 0
  let spoofEndCalls = 0
  const responseHandle = {
    statusCode: 0,
    writableEnded: false,
    get destroy() {
      responseHandle.end = function () {
        spoofEndCalls += 1
      }
      return function () {}
    },
    end() {
      originalEndCalls += 1
    },
    once() {},
    setHeader() {},
    write() {},
    writeHead() {},
  }
  handler({}, responseHandle)
  assert.equal(responseHandle.statusCode, 503)
  assert.equal(originalEndCalls, 1)
  assert.equal(spoofEndCalls, 0)
})

test('Node HTTP server response limits use copied Uint8Array length', async () => {
  let onRequest = null
  const server = {
    off(event, listener) {
      assert.equal(event, 'request')
      assert.equal(listener, onRequest)
      onRequest = null
    },
    on(event, listener) {
      assert.equal(event, 'request')
      onRequest = listener
    },
  }
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    maxResponseBytes: 1,
    maxResponseChunkBytes: 1,
  })
  try {
    let destroyCalls = 0
    let endCalls = 0
    const request = {
      destroy() {},
      headers: {},
      method: 'GET',
      off() {},
      on() {},
      once() {},
      resume() {},
      url: '/response-bytes',
    }
    const responseHandle = {
      destroy() {
        destroyCalls += 1
      },
      end() {
        endCalls += 1
      },
      once() {},
      setHeader() {},
      statusCode: 0,
      writableEnded: false,
      write() {},
      writeHead() {},
    }
    const tokenPromise = driver.accept({ listener: 'api' })
    onRequest(request, responseHandle)
    const token = await tokenPromise
    class SpoofLengthBytes extends Uint8Array {
      get length() {
        return 0
      }
    }

    assert.deepEqual(driver.respond({
      body: new SpoofLengthBytes([0x11, 0x22]),
      headers: '',
      request: token,
      status: 200,
    }), { error: 'body_too_large' })
    assert.equal(destroyCalls, 1)
    assert.equal(endCalls, 0)
  } finally {
    driver.close()
  }
})

test('unmatched and malformed paths do not consume an accept waiter', async () => {
  const fixture = await createFixture({
    routes: new Map([['api', [{ method: 'GET', pattern: '/users/:id' }]]]),
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    assert.equal((await fetch(`${fixture.url}/missing`, {
      signal: AbortSignal.timeout(100),
    })).status, 404)
    assert.equal(await rawStatus(fixture.url, '/users/%ZZ'), 400)
    assert.equal(await rawStatus(fixture.url, '/users/%01'), 400)

    const client = fetch(`${fixture.url}/users/42`)
    const token = okValue(await accept)
    assert.equal(okValue(await invoke(
      fixture.adapter,
      'route_params',
      { request: token },
    )), '{"id":"42"}')
    await invoke(fixture.adapter, 'respond', response(token, 'matched'))
    assert.equal(await (await client).text(), 'matched')
  } finally {
    await fixture.close()
  }
})

test('route registry rejects ambiguous patterns and duplicate parameters', () => {
  const server = createServer()
  assert.throws(() => createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [
      { method: 'GET', pattern: '/a/:x' },
      { method: 'GET', pattern: '/:y/b' },
    ]]]),
  }), /ambiguous http server route/u)
  assert.throws(() => createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    routes: new Map([['api', [
      { method: 'GET', pattern: '/users/:id/:id' },
    ]]]),
  }), /invalid http server route/u)
})

test('concurrent matched routes keep parameter maps isolated', async () => {
  const fixture = await createFixture({
    routes: new Map([['api', [{
      method: 'GET',
      pattern: '/teams/:team/users/:user',
    }]]]),
  })
  try {
    const accepts = [
      invoke(fixture.adapter, 'accept', { listener: 'api' }),
      invoke(fixture.adapter, 'accept', { listener: 'api' }),
    ]
    const clients = [
      fetch(`${fixture.url}/teams/red/users/1`),
      fetch(`${fixture.url}/teams/blue/users/2`),
    ]
    const tokens = await Promise.all(accepts).then((results) => results.map(okValue))
    const byParams = new Map()
    for (const token of tokens) {
      byParams.set(okValue(await invoke(
        fixture.adapter,
        'route_params',
        { request: token },
      )), token)
    }
    assert.deepEqual([...byParams.keys()].sort(), [
      '{"team":"blue","user":"2"}',
      '{"team":"red","user":"1"}',
    ])
    await invoke(fixture.adapter, 'respond', response(
      byParams.get('{"team":"blue","user":"2"}'),
      'blue-2',
    ))
    await invoke(fixture.adapter, 'respond', response(
      byParams.get('{"team":"red","user":"1"}'),
      'red-1',
    ))
    assert.deepEqual(await Promise.all(clients).then(async (responses) => Promise.all(
      responses.map((item) => item.text()),
    )), ['red-1', 'blue-2'])
  } finally {
    await fixture.close()
  }
})

test('requests without accept waiters get 503 and accept saturation is bounded', async () => {
  const fixture = await createFixture()
  try {
    assert.equal((await fetch(`${fixture.url}/no-waiter`)).status, 503)
  } finally {
    await fixture.close()
  }

  const server = createServer()
  const driver = createServerHttpServerNodeDriver({
    listeners: new Map([['api', server]]),
    maxPendingAccepts: 1,
  })
  const first = driver.accept({ listener: 'api' })
  assert.deepEqual(driver.accept({ listener: 'api' }), { error: 'unavailable' })
  driver.close()
  assert.deepEqual(await first, { error: 'unavailable' })
})

test('graceful drain rejects new work and waits active requests to respond', async () => {
  const timer = fakeTimer()
  const fixture = await createFixture({ driverOptions: timer.options })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const activeClient = fetch(`${fixture.url}/active`)
    const token = okValue(await accept)
    const pendingAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const drain = fixture.driver.drain({ deadline: 100 })
    assert.equal(fixture.driver.drain({ deadline: 200 }), drain)

    assert.deepEqual(await pendingAccept, declaredError('unavailable'))
    const rejected = await fetch(`${fixture.url}/new`)
    assert.equal(rejected.status, 503)
    assert.equal(rejected.headers.get('connection'), 'close')
    assert.equal(timer.delay, 100)

    await invoke(fixture.adapter, 'respond', response(token, 'finished'))
    assert.equal(await (await activeClient).text(), 'finished')
    assert.deepEqual(await drain, {
      cancelled_requests: 0,
      outcome: 'drained',
    })
    assert.equal(timer.cleared, true)
  } finally {
    await fixture.close()
  }
})

test('graceful drain rejects an invalid clock before entering draining', async () => {
  const timer = fakeTimer()
  let currentTime = Number.NaN
  const fixture = await createFixture({
    driverOptions: {
      ...timer.options,
      now: () => currentTime,
    },
  })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = fetch(`${fixture.url}/invalid-clock`).catch(() => null)
    const token = okValue(await accept)

    assert.throws(
      () => fixture.driver.drain({ deadline: 25 }),
      /invalid http server drain clock/,
    )
    currentTime = 0
    const drain = fixture.driver.drain({ deadline: 25 })
    assert.equal(timer.delay, 25)

    fixture.driver.close()
    assert.deepEqual(await drain, {
      cancelled_requests: 1,
      outcome: 'closed',
    })
    assert.deepEqual(
      await invoke(fixture.adapter, 'path', { request: token }),
      declaredError('cancelled'),
    )
    await client
  } finally {
    await fixture.close()
  }
})

test('graceful drain cancels remaining requests at an injected monotonic deadline', async () => {
  const timer = fakeTimer()
  const fixture = await createFixture({ driverOptions: timer.options })
  try {
    const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
    const client = fetch(`${fixture.url}/slow`).catch(() => null)
    const token = okValue(await accept)
    const drain = fixture.driver.drain({ deadline: 25 })
    assert.equal(timer.delay, 25)

    timer.fire()
    assert.deepEqual(await drain, {
      cancelled_requests: 1,
      outcome: 'deadline',
    })
    assert.deepEqual(
      await invoke(fixture.adapter, 'path', { request: token }),
      declaredError('cancelled'),
    )
    await client
  } finally {
    await fixture.close()
  }
})

test('driver close wins a drain race, cancels requests, and removes listeners', async () => {
  const timer = fakeTimer()
  const fixture = await createFixture({ driverOptions: timer.options })
  const accept = invoke(fixture.adapter, 'accept', { listener: 'api' })
  const client = fetch(`${fixture.url}/close-race`).catch(() => null)
  const token = okValue(await accept)
  const pendingAccept = invoke(fixture.adapter, 'accept', { listener: 'api' })
  const drain = fixture.driver.drain({ deadline: 50 })

  fixture.driver.close()
  assert.deepEqual(await pendingAccept, declaredError('unavailable'))
  assert.deepEqual(await drain, {
    cancelled_requests: 1,
    outcome: 'closed',
  })
  assert.deepEqual(
    await invoke(fixture.adapter, 'method', { request: token }),
    declaredError('cancelled'),
  )
  assert.equal(fixture.server.listenerCount('request'), 0)
  await client
  await fixture.close()
})

test('graceful drain waits active requests across multiple listeners', async () => {
  const timer = fakeTimer()
  const api = createServer()
  const admin = createServer()
  api.listen(0, '127.0.0.1')
  admin.listen(0, '127.0.0.1')
  await Promise.all([once(api, 'listening'), once(admin, 'listening')])
  const driver = createServerHttpServerNodeDriver({
    ...timer.options,
    listeners: new Map([['admin', admin], ['api', api]]),
  })
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  const apiAccept = invoke(adapter, 'accept', { listener: 'api' })
  const adminAccept = invoke(adapter, 'accept', { listener: 'admin' })
  const apiClient = fetch(serverUrl(api, '/api'))
  const adminClient = fetch(serverUrl(admin, '/admin'))
  try {
    const [apiToken, adminToken] = await Promise.all([apiAccept, adminAccept])
      .then((results) => results.map(okValue))
    const drain = driver.drain({ deadline: 100 })
    await invoke(adapter, 'respond', response(adminToken, 'admin'))
    await invoke(adapter, 'respond', response(apiToken, 'api'))

    assert.deepEqual(await drain, {
      cancelled_requests: 0,
      outcome: 'drained',
    })
    assert.deepEqual(await Promise.all([apiClient, adminClient]).then(async (responses) => (
      Promise.all(responses.map((item) => item.text()))
    )), ['api', 'admin'])
  } finally {
    driver.close()
    for (const server of [api, admin]) {
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    }
  }
})

async function createFixture({ driverOptions = {}, routes } = {}) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const driverConfig = {
    ...driverOptions,
    listeners: new Map([['api', server]]),
  }
  if (routes !== undefined) driverConfig.routes = routes
  const driver = createServerHttpServerNodeDriver(driverConfig)
  const adapter = new ServerHttpServerSocketAdapter({ driver })
  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)
  return {
    adapter,
    bound: bound.value,
    driver,
    async close() {
      driver.close()
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    },
    server,
    url: `http://127.0.0.1:${address.port}`,
  }
}

function serverUrl(server, path) {
  const address = server.address()
  return `http://127.0.0.1:${address.port}${path}`
}

async function rawStatus(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${path}`, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end()
  })
}

function invokeProfile(bound, member, args, invocation) {
  return bound.invokeAsync('@server', member, args, invocation)
}

function invoke(adapter, member, args) {
  return adapter.invoke(
    { interface: SERVER_HTTP_SERVER_REFERENCE, member },
    args,
  )
}

function response(request, text) {
  return {
    body: new Uint8Array(Buffer.from(text)),
    headers: 'content-type:text/plain',
    request,
    status: 200,
  }
}

function okValue(result) {
  assert.equal(result.kind, 'value')
  assert.equal(result.value.kind, 'ok')
  return result.value.value
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'http.server_error', variant },
      kind: 'err',
    },
  }
}

async function waitForCancelled(adapter, request) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await invoke(adapter, 'path', { request })
    if (result.value?.error?.variant === 'cancelled') return result
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return invoke(adapter, 'path', { request })
}

function fakeTimer() {
  const timer = {
    callback: null,
    cleared: false,
    delay: null,
    options: {
      clearTimeoutImpl() {
        timer.cleared = true
        timer.callback = null
      },
      now: () => 0,
      setTimeoutImpl(callback, delay) {
        timer.callback = callback
        timer.delay = delay
        return { id: 'drain-timer' }
      },
    },
  }
  timer.fire = () => {
    const callback = timer.callback
    timer.callback = null
    callback()
  }
  return timer
}

function requiredBindings(httpServerAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter: new ServerConfigMemoryAdapter(),
    dbSqlAdapter: new ServerDbSqlMemoryAdapter(),
    httpClientAdapter: new ServerHttpClientMemoryAdapter(),
    httpServerAdapter,
    jsonAdapter: new ServerJsonMemoryAdapter(),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
