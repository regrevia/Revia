import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import test from 'node:test'

import {
  createServerHttpClientNodeTlsTransport,
} from '../src/host/server-http-client-node-tls-transport.js'
import {
  ServerHttpClientTransportAdapter,
} from '../src/host/server-http-client-transport-adapter.js'
import {
  SERVER_HTTP_CLIENT_REFERENCE,
} from '../src/host/server-profile.js'
import {
  createLoopbackTlsCredentials,
} from '../test-support/loopback-tls-fixture.js'

test('Node TLS transport performs a trusted loopback handshake with bearer auth', async (t) => {
  const credentials = await createLoopbackTlsCredentials()
  if (credentials === null) {
    t.skip('fixed-path openssl unavailable')
    return
  }
  t.after(credentials.close)
  const seen = []
  const server = createServer({
    cert: credentials.cert,
    key: credentials.key,
  }, async (request, response) => {
    const body = await readBody(request)
    seen.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url,
    })
    if (request.headers.authorization !== 'Bearer deployment-token') {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('unauthorized')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"kind":"ok"}')
  })
  const address = await listen(server)
  t.after(() => close(server))

  const adapter = new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientNodeTlsTransport({
      ca: credentials.ca,
    }),
  })
  const body = Uint8Array.from(Buffer.from('{"request":"expense"}'))
  assert.deepEqual(await invoke(adapter, {
    body,
    deadline: 1000,
    headers: 'authorization:Bearer deployment-token\ncontent-type:application/json',
    method: 'POST',
    redirect_policy: 'reject',
    url: `https://localhost:${address.port}/expense/review`,
  }), ok('{"status":200,"body":"{\\"kind\\":\\"ok\\"}"}'))
  assert.deepEqual(seen, [{
    authorization: 'Bearer deployment-token',
    body: Buffer.from('{"request":"expense"}'),
    method: 'POST',
    url: '/expense/review',
  }])
  assert.deepEqual(body, Uint8Array.from(Buffer.from('{"request":"expense"}')))
})

test('Node TLS transport sanitizes auth, trust, deadline, and connection faults', async (t) => {
  const credentials = await createLoopbackTlsCredentials()
  if (credentials === null) {
    t.skip('fixed-path openssl unavailable')
    return
  }
  t.after(credentials.close)
  const server = createServer({
    cert: credentials.cert,
    key: credentials.key,
  }, (request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200)
        response.end('late')
      }, 100)
      return
    }
    response.writeHead(
      request.headers.authorization === 'Bearer deployment-token' ? 200 : 401,
    )
    response.end('closed')
  })
  const address = await listen(server)
  t.after(() => close(server))
  const endpoint = `https://localhost:${address.port}`
  const trusted = new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientNodeTlsTransport({ ca: credentials.ca }),
  })

  assert.deepEqual(await invoke(trusted, request({
    headers: 'authorization:Bearer wrong-token',
    url: `${endpoint}/auth`,
  })), ok('{"status":401,"body":"closed"}'))
  assert.deepEqual(await invoke(trusted, request({
    deadline: 10,
    url: `${endpoint}/slow`,
  })), declaredError('deadline_exceeded'))
  assert.deepEqual(await invoke(new ServerHttpClientTransportAdapter({
    transport: createServerHttpClientNodeTlsTransport({
      ca: Buffer.from('not a certificate'),
    }),
  }), request({ url: `${endpoint}/trust` })), declaredError('unavailable'))
  assert.deepEqual(await invoke(trusted, request({
    url: 'https://user:secret@localhost/private',
  })), declaredError('invalid_request'))
  assert.deepEqual(await invoke(trusted, request({
    url: 'http://127.0.0.1/plaintext',
  })), declaredError('invalid_request'))
})

function request(overrides = {}) {
  return {
    body: new Uint8Array(),
    deadline: 1000,
    headers: '',
    method: 'GET',
    redirect_policy: 'reject',
    url: 'https://localhost/',
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}
