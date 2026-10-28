import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import {
  createServerHttpClientFetchTransport,
} from '../src/host/server-http-client-fetch-transport.js'
import {
  ServerHttpClientTransportAdapter,
} from '../src/host/server-http-client-transport-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_HTTP_CLIENT_REFERENCE,
} from '../src/host/server-profile.js'

test('Node fetch transport reaches loopback through bindServerProfile invokeAsync', async () => {
  const seen = []
  const server = await listen(async (request, response) => {
    const body = await readBody(request)
    seen.push({
      body,
      header: request.headers['x-platform-test'],
      method: request.method,
      url: request.url,
    })
    response.writeHead(201, { 'content-type': 'text/plain' })
    response.end('created')
  })
  try {
    const adapter = new ServerHttpClientTransportAdapter({
      transport: createServerHttpClientFetchTransport(),
    })
    const bound = bindServerProfile(requiredBindings(adapter))
    assert.equal(bound.ok, true)
    const body = Uint8Array.of(0x70, 0x69, 0x6e, 0x67)

    assert.deepEqual(
      await bound.value.invokeAsync('@http', 'request', {
        body,
        deadline: 1000,
        headers: 'x-platform-test:fetch',
        method: 'POST',
        redirect_policy: 'follow',
        url: `${server.url}/resource`,
      }, 'fetch-loopback'),
      ok('{"status":201,"body":"created"}'),
    )
    assert.deepEqual(seen, [{
      body: Buffer.from('ping'),
      header: 'fetch',
      method: 'POST',
      url: '/resource',
    }])
    assert.deepEqual(body, Uint8Array.of(0x70, 0x69, 0x6e, 0x67))
  } finally {
    await close(server.value)
  }
})

test('Node fetch transport maps redirect and deadline policies to closed errors', async () => {
  const server = await listen((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' })
      response.end()
      return
    }
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200)
        response.end('late')
      }, 50)
      return
    }
    response.writeHead(200)
    response.end('final')
  })
  const adapter = new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientFetchTransport(),
  })
  try {
    assert.deepEqual(
      await invoke(adapter, request({
        redirect_policy: 'follow',
        url: `${server.url}/redirect`,
      })),
      ok('{"status":200,"body":"final"}'),
    )
    assert.deepEqual(
      await invoke(adapter, request({
        redirect_policy: 'reject',
        url: `${server.url}/redirect`,
      })),
      declaredError('redirect_rejected'),
    )
    assert.deepEqual(
      await invoke(adapter, request({
        deadline: 5,
        url: `${server.url}/slow`,
      })),
      declaredError('deadline_exceeded'),
    )
  } finally {
    await close(server.value)
  }
})

test('Node fetch transport validates requests, copies bytes, and closes failures', async () => {
  let calls = 0
  const body = Uint8Array.of(0x41)
  const fetchTransport = createServerHttpClientFetchTransport({
    async fetchImpl(_url, options) {
      calls += 1
      options.body[0] = 0x42
      return {
        status: 202,
        async text() {
          return 'accepted'
        },
      }
    },
  })
  const adapter = new ServerHttpClientTransportAdapter({
    transport: fetchTransport,
  })

  assert.deepEqual(
    await invoke(adapter, request({
      body,
      headers: 'x-one:1\nx-two:2',
      method: 'POST',
    })),
    ok('{"status":202,"body":"accepted"}'),
  )
  assert.deepEqual(body, Uint8Array.of(0x41))
  assert.equal(calls, 1)

  class SpoofLengthBytes extends Uint8Array {
    get length() {
      return 0
    }
  }
  assert.deepEqual(await fetchTransport(request({
    body: new SpoofLengthBytes([0x11, 0x22]),
    method: 'GET',
  })), { error: 'invalid_request' })
  const proxyBody = new Proxy(Uint8Array.of(0x11, 0x22), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  assert.deepEqual(await fetchTransport(request({
    body: proxyBody,
    method: 'POST',
  })), { error: 'invalid_request' })
  assert.equal(calls, 1)

  for (const invalid of [
    request({ url: 'file:///tmp/private' }),
    request({ url: 'http://example.test/\u0000' }),
    request({ url: 'http://example.test/\u007f' }),
    request({ url: 'http://example.test/\uD800' }),
    request({ headers: 'missing-colon' }),
    request({ headers: 'x-duplicate:1\nX-Duplicate:2' }),
    request({ headers: 'x-invalid:\u0000' }),
    request({ headers: 'x-invalid:\u007f' }),
    request({ headers: 'x-invalid:\uD800' }),
    request({ redirect_policy: 'guess' }),
    request({ body: Uint8Array.of(1), method: 'GET' }),
  ]) {
    assert.deepEqual(await invoke(adapter, invalid), declaredError('invalid_request'))
  }
  assert.equal(calls, 1)

  const unavailable = new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientFetchTransport({
      fetchImpl: async () => {
        throw new Error('private network detail')
      },
    }),
  })
  assert.deepEqual(
    await invoke(unavailable, request()),
    declaredError('unavailable'),
  )
  for (const response of [
    { status: '302', async text() { return 'redirect' } },
    { status: 302 },
    { status: 700, async text() { return 'invalid' } },
    { status: 200, async text() { return 'invalid\uD800' } },
  ]) {
    assert.deepEqual(
      await invoke(new ServerHttpClientTransportAdapter({
        transport: createServerHttpClientFetchTransport({
          fetchImpl: async () => response,
        }),
      }), request({ redirect_policy: 'reject' })),
      declaredError('unavailable'),
    )
  }
  assert.deepEqual(
    await invoke(new ServerHttpClientTransportAdapter({
      transport: () => Promise.reject(new Error('private transport detail')),
    }), request()),
    declaredError('unavailable'),
  )
})

test('Node fetch transport snapshots response status and text capabilities', async () => {
  let statusReads = 0
  let textReads = 0
  let textCalls = 0
  const response = {}
  const text = function () {
    assert.equal(this, response)
    textCalls += 1
    return 'stable'
  }
  Object.defineProperty(text, 'bind', {
    configurable: true,
    get() {
      throw new Error('private response bind fault')
    },
  })
  Object.defineProperties(response, {
    status: {
      configurable: true,
      get() {
        statusReads += 1
        if (statusReads > 1) return 302
        return 202
      },
    },
    text: {
      configurable: true,
      get() {
        textReads += 1
        if (textReads > 1) throw new Error('response text getter fault')
        return text
      },
    },
  })
  const adapter = new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientFetchTransport({
      fetchImpl: async () => response,
    }),
  })

  assert.deepEqual(
    await invoke(adapter, request({ redirect_policy: 'reject' })),
    ok('{"status":202,"body":"stable"}'),
  )
  assert.equal(statusReads, 1)
  assert.equal(textReads, 1)
  assert.equal(textCalls, 1)
})

function request(overrides = {}) {
  return {
    body: new Uint8Array(),
    deadline: 1000,
    headers: '',
    method: 'GET',
    redirect_policy: 'follow',
    url: 'https://example.test/',
    ...overrides,
  }
}

function invoke(adapter, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
    typedArguments,
  )
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'http.client_error', variant },
      kind: 'err',
    },
  }
}

async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.destroy()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    value: server,
  }
}

async function close(server) {
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function requiredBindings(httpClientAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter: new ServerConfigMemoryAdapter(),
    dbSqlAdapter: new ServerDbSqlMemoryAdapter(),
    httpClientAdapter,
    httpServerAdapter: new ServerHttpServerMemoryAdapter(),
    jsonAdapter: new ServerJsonMemoryAdapter(),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
