import assert from 'node:assert/strict'
import test from 'node:test'

import { serverProfileSchemaDefinitions } from '../src/host/server-profile.js'

test('http.server schema fixes bounded request lifecycle members', () => {
  const schema = serverProfileSchemaDefinitions()
    .find(({ identity }) => identity === 'http.server')
  assert.equal(schema.revision, '0.1.0')
  assert.deepEqual(Object.keys(schema.members).sort(), [
    'accept', 'body', 'cancel', 'headers', 'method', 'path',
    'respond', 'respond_chunk', 'respond_drain', 'respond_end', 'respond_start',
    'route_params',
  ])
  assert.equal(schema.members.body.cancellation, 'cooperative')
  assert.deepEqual(schema.types['http.server_error'].variants, [
    'body_too_large', 'cancelled', 'invalid_request', 'unavailable',
  ])
})

test('http.server memory adapter exposes fields and closes responded requests', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const requests = [{
    body: Uint8Array.of(0x7b, 0x7d),
    headers: 'content-type:application/json',
    id: 'req-1',
    listener: 'api',
    method: 'POST',
    path: '/users/42',
    route_params: '{"id":"42"}',
  }]
  const adapter = new ServerHttpServerMemoryAdapter({ requests })
  requests[0].method = 'MUTATED'

  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'accept' },
    { listener: 'api' },
  ), { kind: 'value', value: { kind: 'ok', value: 'req-1' } })
  for (const [member, value] of [
    ['method', 'POST'],
    ['path', '/users/42'],
    ['headers', 'content-type:application/json'],
    ['route_params', '{"id":"42"}'],
  ]) {
    assert.deepEqual(adapter.invoke(
      { interface: 'http.server@0.1.0', member },
      { request: 'req-1' },
    ), { kind: 'value', value: { kind: 'ok', value } })
  }
  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 2, request: 'req-1' },
  ), { kind: 'value', value: { kind: 'ok', value: Uint8Array.of(0x7b, 0x7d) } })
  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'respond' },
    { body: Uint8Array.of(0x6f, 0x6b), headers: '', request: 'req-1', status: 201 },
  ), { kind: 'value', value: { kind: 'ok', value: null } })
  assert.equal(adapter.responses()[0].status, 201)
  assert.equal(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'method' },
    { request: 'req-1' },
  ).value.error.variant, 'invalid_request')
})

test('http.server memory adapter ignores overridden request array methods', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  let spoofCalls = 0
  const legitimate = {
    body: Uint8Array.of(1),
    headers: '',
    id: 'req-legitimate',
    listener: 'api',
    method: 'GET',
    path: '/',
    route_params: '{}',
  }
  const requests = [legitimate]
  requests.map = () => {
    spoofCalls += 1
    return [{ ...legitimate, id: 'req-spoof' }]
  }
  const adapter = new ServerHttpServerMemoryAdapter({ requests })

  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'accept' },
    { listener: 'api' },
  ), { kind: 'value', value: { kind: 'ok', value: 'req-legitimate' } })
  assert.equal(spoofCalls, 0)
})

test('http.server memory adapter closes cancellation and body errors', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    requests: [{
      body: Uint8Array.of(1, 2),
      headers: '',
      id: 'req-2',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'accept' },
    { listener: 'api' },
  )
  assert.equal(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 1, request: 'req-2' },
  ).value.error.variant, 'body_too_large')
  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'cancel' },
    { request: 'req-2' },
  ), { kind: 'value', value: { kind: 'ok', value: null } })
  assert.equal(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 2, request: 'req-2' },
  ).value.error.variant, 'cancelled')
})

test('http.server memory adapter freezes the first body read authority', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    requests: [{
      body: Uint8Array.of(1, 2),
      headers: 'content-length:2',
      id: 'req-authority',
      listener: 'api',
      method: 'POST',
      path: '/authority',
      route_params: '{}',
    }],
  })
  adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'accept' },
    { listener: 'api' },
  )

  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 1, request: 'req-authority' },
  ), declaredError('body_too_large'))
  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 2, request: 'req-authority' },
  ), declaredError('body_too_large'))
})

test('invalid body limits do not freeze memory read authority and copies stay isolated', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    requests: [{
      body: Uint8Array.of(1, 2),
      headers: 'content-length:2',
      id: 'req-copy',
      listener: 'api',
      method: 'POST',
      path: '/copy',
      route_params: '{}',
    }],
  })
  adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'accept' },
    { listener: 'api' },
  )

  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: -1, request: 'req-copy' },
  ), declaredError('invalid_request'))
  const first = adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 2, request: 'req-copy' },
  )
  first.value.value[0] = 9
  assert.deepEqual(adapter.invoke(
    { interface: 'http.server@0.1.0', member: 'body' },
    { limit: 2, request: 'req-copy' },
  ), {
    kind: 'value',
    value: { kind: 'ok', value: Uint8Array.of(1, 2) },
  })
})

test('http.server memory adapter bounds response streaming and copies chunks', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    maxResponseBytes: 3,
    maxResponseChunkBytes: 2,
    requests: [{
      body: new Uint8Array(),
      headers: '',
      id: 'req-stream',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  const operation = (member) => ({ interface: 'http.server@0.1.0', member })
  adapter.invoke(operation('accept'), { listener: 'api' })
  assert.deepEqual(adapter.invoke(operation('respond_start'), {
    headers: '',
    request: 'req-stream',
    status: 200,
  }), ok(null))
  const chunk = Uint8Array.of(1, 2)
  assert.deepEqual(adapter.invoke(operation('respond_chunk'), {
    body: chunk,
    request: 'req-stream',
  }), ok('ready'))
  chunk[0] = 9
  assert.deepEqual(adapter.invoke(operation('respond_chunk'), {
    body: Uint8Array.of(3),
    request: 'req-stream',
  }), ok('ready'))
  assert.deepEqual(await adapter.invoke(operation('respond_drain'), {
    request: 'req-stream',
  }), ok(null))
  assert.deepEqual(adapter.invoke(operation('respond_end'), {
    request: 'req-stream',
  }), ok(null))
  assert.deepEqual(adapter.responses()[0].body, Uint8Array.of(1, 2, 3))
  assert.deepEqual(adapter.invoke(operation('respond_end'), {
    request: 'req-stream',
  }), declaredError('invalid_request'))
})

test('http.server memory adapter closes a response stream on overflow', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    maxResponseBytes: 2,
    maxResponseChunkBytes: 2,
    requests: [{
      body: new Uint8Array(),
      headers: '',
      id: 'req-stream-limit',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  const operation = (member) => ({ interface: 'http.server@0.1.0', member })
  adapter.invoke(operation('accept'), { listener: 'api' })
  adapter.invoke(operation('respond_start'), {
    headers: '',
    request: 'req-stream-limit',
    status: 200,
  })
  assert.deepEqual(adapter.invoke(operation('respond_chunk'), {
    body: Uint8Array.of(1, 2, 3),
    request: 'req-stream-limit',
  }), declaredError('body_too_large'))
  assert.deepEqual(adapter.invoke(operation('respond_end'), {
    request: 'req-stream-limit',
  }), declaredError('cancelled'))
})

test('http.server memory adapter rejects proxy response bytes before recording', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    requests: [{
      body: new Uint8Array(),
      headers: '',
      id: 'req-proxy-response',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  const proxyBytes = new Proxy(Uint8Array.of(0x11, 0x22), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  const operation = (member) => ({ interface: 'http.server@0.1.0', member })
  adapter.invoke(operation('accept'), { listener: 'api' })

  assert.deepEqual(adapter.invoke(operation('respond'), {
    body: proxyBytes,
    headers: '',
    request: 'req-proxy-response',
    status: 200,
  }), declaredError('invalid_request'))
  assert.deepEqual(adapter.responses(), [])
})

test('http.server memory adapter rejects proxy request bytes at construction', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const proxyBytes = new Proxy(Uint8Array.of(0x11, 0x22), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })

  assert.throws(() => new ServerHttpServerMemoryAdapter({
    requests: [{
      body: proxyBytes,
      headers: '',
      id: 'req-proxy-request',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  }), {
    name: 'TypeError',
    message: 'invalid http server request',
  })
})

test('http.server memory adapter uses internal chunk length for limits', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    maxResponseBytes: 1,
    maxResponseChunkBytes: 1,
    requests: [{
      body: new Uint8Array(),
      headers: '',
      id: 'req-shadowed-chunk',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  const shadowedLength = new Uint8Array([1, 2])
  Object.defineProperty(shadowedLength, 'length', { value: 0 })
  const operation = (member) => ({ interface: 'http.server@0.1.0', member })
  adapter.invoke(operation('accept'), { listener: 'api' })
  adapter.invoke(operation('respond_start'), {
    headers: '',
    request: 'req-shadowed-chunk',
    status: 200,
  })

  assert.deepEqual(adapter.invoke(operation('respond_chunk'), {
    body: shadowedLength,
    request: 'req-shadowed-chunk',
  }), declaredError('body_too_large'))
})

test('http.server memory adapter uses internal response length for limits', async () => {
  const { ServerHttpServerMemoryAdapter } = await import(
    '../src/host/server-http-server-memory-adapter.js'
  )
  const adapter = new ServerHttpServerMemoryAdapter({
    maxResponseBytes: 1,
    maxResponseChunkBytes: 1,
    requests: [{
      body: new Uint8Array(),
      headers: '',
      id: 'req-shadowed-response',
      listener: 'api',
      method: 'GET',
      path: '/',
      route_params: '{}',
    }],
  })
  const shadowedLength = new Uint8Array([1, 2])
  Object.defineProperty(shadowedLength, 'length', { value: 0 })
  const operation = (member) => ({ interface: 'http.server@0.1.0', member })
  adapter.invoke(operation('accept'), { listener: 'api' })

  assert.deepEqual(adapter.invoke(operation('respond'), {
    body: shadowedLength,
    headers: '',
    request: 'req-shadowed-response',
    status: 200,
  }), declaredError('body_too_large'))
})

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'http.server_error', variant },
      kind: 'err',
    },
  }
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}
