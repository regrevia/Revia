import assert from 'node:assert/strict'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
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
  SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
  SERVER_HTTP_SERVER_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'

test('Server HTTP server socket adapter preserves the shared request lifecycle', () => {
  const memory = new ServerHttpServerMemoryAdapter({
    requests: [{
      body: Uint8Array.of(0x7b, 0x7d),
      headers: 'content-type:application/json',
      id: 'req-1',
      listener: 'api',
      method: 'POST',
      path: '/users/42',
      route_params: '{"id":"42"}',
    }],
  })
  const adapter = new ServerHttpServerSocketAdapter({
    driver: driverFromAdapter(memory),
  })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-1'))
  assert.deepEqual(invoke(adapter, 'method', { request: 'req-1' }), ok('POST'))
  assert.deepEqual(invoke(adapter, 'path', { request: 'req-1' }), ok('/users/42'))
  assert.deepEqual(invoke(adapter, 'headers', { request: 'req-1' }),
    ok('content-type:application/json'))
  assert.deepEqual(invoke(adapter, 'route_params', { request: 'req-1' }),
    ok('{"id":"42"}'))
  assert.deepEqual(invoke(adapter, 'body', { limit: 2, request: 'req-1' }),
    ok(Uint8Array.of(0x7b, 0x7d)))
  assert.deepEqual(invoke(adapter, 'respond', {
    body: Uint8Array.of(0x6f, 0x6b),
    headers: '',
    request: 'req-1',
    status: 201,
  }), ok(null))
  assert.deepEqual(invoke(adapter, 'method', { request: 'req-1' }),
    declaredError('invalid_request'))
})

test('Server HTTP server socket adapter copies request and response bytes', () => {
  const responseBody = Uint8Array.of(0x6f, 0x6b)
  const requestBody = Uint8Array.of(1, 2)
  let calls = 0
  const adapter = new ServerHttpServerSocketAdapter({
    driver: {
      body() {
        calls += 1
        return requestBody
      },
      respond(request) {
        calls += 1
        request.body[0] = 0x00
        return null
      },
    },
  })
  const first = invoke(adapter, 'body', { limit: 2, request: 'req-1' })
  first.value.value[0] = 0x00
  assert.deepEqual(requestBody, Uint8Array.of(1, 2))
  assert.deepEqual(invoke(adapter, 'respond', {
    body: responseBody,
    headers: '',
    request: 'req-1',
    status: 200,
  }), ok(null))
  assert.deepEqual(responseBody, Uint8Array.of(0x6f, 0x6b))
  assert.equal(calls, 2)
})

test('Server HTTP server socket adapter rejects typed array proxy bytes', () => {
  let responseCalls = 0
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
  const adapter = new ServerHttpServerSocketAdapter({
    driver: {
      body() {
        return proxyBytes
      },
      respond() {
        responseCalls += 1
        return null
      },
      respond_chunk() {
        responseCalls += 1
        return 'ready'
      },
    },
  })

  assert.deepEqual(
    invoke(adapter, 'body', { limit: 2, request: 'req-1' }),
    declaredError('unavailable'),
  )
  assert.deepEqual(invoke(adapter, 'respond', {
    body: proxyBytes,
    headers: '',
    request: 'req-1',
    status: 200,
  }), declaredError('invalid_request'))
  assert.deepEqual(invoke(adapter, 'respond_chunk', {
    body: proxyBytes,
    request: 'req-1',
  }), declaredError('invalid_request'))
  assert.equal(responseCalls, 0)
})

test('Server HTTP server socket driver bind overrides cannot replace method authority', () => {
  let calls = 0
  let spoofBindReads = 0
  let spoofCalls = 0
  const driver = {
    accept(listener) {
      assert.equal(this, driver)
      assert.equal(listener.listener, 'api')
      calls += 1
      return 'req-authority'
    },
  }
  Object.defineProperty(driver.accept, 'bind', {
    configurable: true,
    get() {
      spoofBindReads += 1
      return () => {
        spoofCalls += 1
        return () => 42
      }
    },
  })

  const adapter = new ServerHttpServerSocketAdapter({ driver })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-authority'))
  assert.equal(calls, 1)
  assert.equal(spoofBindReads, 0)
  assert.equal(spoofCalls, 0)
})

test('Server HTTP server socket driver bind accessor faults do not reject a valid method', () => {
  let calls = 0
  const driver = {
    accept(listener) {
      assert.equal(this, driver)
      assert.equal(listener.listener, 'api')
      calls += 1
      return 'req-valid'
    },
  }
  Object.defineProperty(driver.accept, 'bind', {
    configurable: true,
    get() {
      throw new Error('private socket driver bind failure')
    },
  })

  const adapter = new ServerHttpServerSocketAdapter({ driver })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-valid'))
  assert.equal(calls, 1)
})

test('Server HTTP server socket driver member is snapshotted before later spoofing', () => {
  let reads = 0
  let calls = 0
  const driver = {}
  const legitimate = function (request) {
    assert.equal(this, driver)
    assert.equal(request.listener, 'api')
    calls += 1
    return 'req-snapshot'
  }
  Object.defineProperty(driver, 'accept', {
    configurable: true,
    get() {
      reads += 1
      return reads === 1
        ? legitimate
        : () => 'spoof'
    },
  })

  const adapter = new ServerHttpServerSocketAdapter({ driver })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-snapshot'))
  assert.equal(reads, 1)
  assert.equal(calls, 1)
})

test('Server HTTP server socket driver member is snapshotted before later faults', () => {
  let reads = 0
  let calls = 0
  const driver = {}
  const legitimate = function (request) {
    assert.equal(this, driver)
    assert.equal(request.listener, 'api')
    calls += 1
    return 'req-stable'
  }
  Object.defineProperty(driver, 'accept', {
    configurable: true,
    get() {
      reads += 1
      if (reads > 1) throw new Error('private driver member fault')
      return legitimate
    },
  })

  const adapter = new ServerHttpServerSocketAdapter({ driver })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-stable'))
  assert.equal(reads, 1)
  assert.equal(calls, 1)
})

test('Server HTTP server socket adapter preserves bounded response streaming', async () => {
  const memory = new ServerHttpServerMemoryAdapter({
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
  const adapter = new ServerHttpServerSocketAdapter({
    driver: driverFromAdapter(memory),
  })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-stream'))
  assert.deepEqual(invoke(adapter, 'respond_start', {
    headers: '',
    request: 'req-stream',
    status: 200,
  }), ok(null))
  assert.deepEqual(invoke(adapter, 'respond_chunk', {
    body: Uint8Array.of(1, 2),
    request: 'req-stream',
  }), ok('ready'))
  assert.deepEqual(invoke(adapter, 'respond_chunk', {
    body: Uint8Array.of(3),
    request: 'req-stream',
  }), ok('ready'))
  assert.deepEqual(await invoke(adapter, 'respond_drain', {
    request: 'req-stream',
  }), ok(null))
  assert.deepEqual(invoke(adapter, 'respond_end', {
    request: 'req-stream',
  }), ok(null))
  assert.deepEqual(memory.responses()[0].body, Uint8Array.of(1, 2, 3))
})

test('Server HTTP server socket adapter closes invalid driver outcomes', () => {
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter(), 'accept', {
    listener: 'api',
  }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter({
    driver: { accept: () => 42 },
  }), 'accept', { listener: 'api' }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter({
    driver: {
      cancel: () => {
        throw new Error('socket details')
      },
    },
  }), 'cancel', { request: 'req-1' }), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter({
    driver: { body: () => ({ error: 'body_too_large' }) },
  }), 'body', { limit: 1, request: 'req-1' }),
  declaredError('body_too_large'))
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter({
    driver: { body: () => Uint8Array.of(1) },
  }), 'body', { limit: -1, request: 'req-1' }),
  declaredError('invalid_request'))
  assert.deepEqual(invoke(new ServerHttpServerSocketAdapter({
    driver: { body: () => ({ error: 'body_too_large', extra: true }) },
  }), 'body', { limit: 1, request: 'req-1' }),
  declaredError('unavailable'))
})

test('Server HTTP server socket adapter normalizes Promise driver outcomes', async () => {
  const adapter = new ServerHttpServerSocketAdapter({
    driver: {
      accept: async () => 'req-async',
      body: async () => Uint8Array.of(1, 2),
      cancel: async () => null,
    },
  })

  assert.deepEqual(
    await invoke(adapter, 'accept', { listener: 'api' }),
    ok('req-async'),
  )
  assert.deepEqual(
    await invoke(adapter, 'body', { limit: 2, request: 'req-async' }),
    ok(Uint8Array.of(1, 2)),
  )
  assert.deepEqual(
    await invoke(adapter, 'cancel', { request: 'req-async' }),
    ok(null),
  )
  assert.deepEqual(
    await invoke(new ServerHttpServerSocketAdapter({
      driver: { accept: async () => { throw new Error('private') } },
    }), 'accept', { listener: 'api' }),
    declaredError('unavailable'),
  )
})

test('Server HTTP server socket adapter preserves first body read authority', () => {
  const memory = new ServerHttpServerMemoryAdapter({
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
  const adapter = new ServerHttpServerSocketAdapter({
    driver: driverFromAdapter(memory),
  })

  assert.deepEqual(invoke(adapter, 'accept', { listener: 'api' }), ok('req-authority'))
  assert.deepEqual(
    invoke(adapter, 'body', { limit: 1, request: 'req-authority' }),
    declaredError('body_too_large'),
  )
  assert.deepEqual(
    invoke(adapter, 'body', { limit: 2, request: 'req-authority' }),
    declaredError('body_too_large'),
  )
})

test('Server profile accepts shared HTTP server contract and rejects old identity', () => {
  const adapter = new ServerHttpServerSocketAdapter({
    driver: { accept: () => 'req-1' },
  })
  assert.equal(adapter.adapterContract(), SERVER_HTTP_SERVER_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_HTTP_SERVER_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'http.server')
      .resource_catalog,
  )
  assert.equal(bindServerProfile(requiredBindings(adapter)).ok, true)

  class LegacyContractAdapter extends ServerHttpServerSocketAdapter {
    adapterContract() {
      return 're.server-http-server-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter({
      driver: { accept: () => 'req-1' },
    }))),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
        instance: '@server',
      }],
      ok: false,
    },
  )
})

function driverFromAdapter(adapter) {
  return Object.fromEntries(
    [
      'accept', 'body', 'cancel', 'headers', 'method', 'path',
      'respond', 'respond_chunk', 'respond_drain', 'respond_end',
      'respond_start', 'route_params',
    ]
      .map((member) => [
        member,
        member === 'respond_drain'
          ? async (request) => {
            const result = (await adapter.invoke(
              { interface: SERVER_HTTP_SERVER_REFERENCE, member },
              request,
            )).value
            return result.kind === 'ok'
              ? result.value
              : { error: result.error.variant }
          }
          : (request) => {
            const result = adapter.invoke(
            { interface: SERVER_HTTP_SERVER_REFERENCE, member },
            request,
          ).value
          return result.kind === 'ok'
            ? result.value
            : { error: result.error.variant }
        },
      ]),
  )
}

function invoke(adapter, member, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_HTTP_SERVER_REFERENCE, member },
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
      error: { type: 'http.server_error', variant },
      kind: 'err',
    },
  }
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
