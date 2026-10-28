import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import {
  ServerHttpClientTransportAdapter,
} from '../src/host/server-http-client-transport-adapter.js'
import {
  ServerHttpClientMemoryAdapter,
  httpClientRequestKey,
} from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
  SERVER_HTTP_CLIENT_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('Server HTTP client transport adapter passes the shared HTTP corpus', () => {
  for (const vector of corpus.http_client_vectors) {
    const outcomes = new Map(vector.responses.map((entry) => [
      httpClientRequestKey(requestFromFixture(entry.request)),
      entry.outcome,
    ]))
    const adapter = new ServerHttpClientTransportAdapter({
      transport: (request) => outcomes.get(httpClientRequestKey(request))
        ?? { error: 'invalid_request' },
      unavailable: vector.unavailable === true,
    })
    for (const request of vector.requests) {
      const expected = request.expected_error === undefined
        ? {
            kind: 'value',
            value: { kind: 'ok', value: request.response },
          }
        : declaredError(request.expected_error)
      assert.deepEqual(
        checkAdapterVector({
          adapter,
          expectedOutcome: expected,
          expectedState: null,
          invocationId: `${vector.id}-${request.url}`,
          observeState: () => null,
          operation: {
            interface: SERVER_HTTP_CLIENT_REFERENCE,
            member: 'request',
          },
          typedArguments: requestFromFixture(request),
        }),
        { diagnostics: [], ok: true },
      )
    }
  }
})

test('Server HTTP client transport receives one copied exact request', () => {
  const body = Uint8Array.of(0x7b, 0x7d)
  const seen = []
  const adapter = new ServerHttpClientTransportAdapter({
    transport(request) {
      seen.push(request)
      request.body[0] = 0x00
      return '{"status":201,"body":"ok"}'
    },
  })
  assert.deepEqual(invoke(adapter, {
    body,
    deadline: 2500,
    headers: 'content-type:application/json',
    method: 'POST',
    redirect_policy: 'reject',
    url: 'https://api.example.test/users',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '{"status":201,"body":"ok"}' },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].deadline, 2500)
  assert.equal(seen[0].redirect_policy, 'reject')
  assert.deepEqual(body, Uint8Array.of(0x7b, 0x7d))
})

test('HTTP client request keys use typed array internal bytes', () => {
  class SpoofLengthBytes extends Uint8Array {
    get length() {
      return 0
    }
  }
  const body = new SpoofLengthBytes([0x11, 0x22])
  const request = {
    body,
    deadline: 1000,
    headers: '',
    method: 'POST',
    redirect_policy: 'reject',
    url: 'https://api.example.test/bytes',
  }
  const seen = []
  const adapter = new ServerHttpClientTransportAdapter({
    transport(value) {
      seen.push(value)
      return '{"status":204,"body":""}'
    },
  })

  assert.equal(
    httpClientRequestKey(request),
    '["POST","https://api.example.test/bytes","","1122",1000,"reject"]',
  )
  assert.deepEqual(invoke(adapter, request), {
    kind: 'value',
    value: { kind: 'ok', value: '{"status":204,"body":""}' },
  })
  assert.deepEqual(seen[0].body, Uint8Array.of(0x11, 0x22))

  const memory = new ServerHttpClientMemoryAdapter({
    responses: new Map([[
      httpClientRequestKey(request),
      '{"status":200,"body":"memory"}',
    ]]),
  })
  assert.deepEqual(memory.invoke(
    { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
    request,
  ), {
    kind: 'value',
    value: { kind: 'ok', value: '{"status":200,"body":"memory"}' },
  })

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
  assert.deepEqual(invoke(adapter, { ...request, body: proxyBody }),
    declaredError('invalid_request'))
  assert.deepEqual(memory.invoke(
    { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
    { ...request, body: proxyBody },
  ), declaredError('invalid_request'))
  assert.equal(seen.length, 1)
})

test('Server HTTP client transport fails closed for invalid requests and drivers', () => {
  const request = requestFromFixture({
    body_hex: '',
    deadline: 1000,
    headers: '',
    method: 'GET',
    redirect_policy: 'follow',
    url: 'https://api.example.test/users',
  })
  assert.deepEqual(invoke(new ServerHttpClientTransportAdapter({
    transport: () => {
      throw new Error('network details must not escape')
    },
  }), request), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerHttpClientTransportAdapter({
    transport: () => ({ error: 'unknown' }),
  }), request), declaredError('invalid_request'))
  assert.deepEqual(invoke(new ServerHttpClientTransportAdapter({
    transport: () => 42,
  }), request), declaredError('invalid_request'))
  assert.deepEqual(invoke(new ServerHttpClientTransportAdapter(), request),
    declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerHttpClientTransportAdapter({
    transport: () => 'should-not-run',
  }), { ...request, deadline: 1.5 }), declaredError('invalid_request'))
})

test('Server profile accepts shared HTTP contract and rejects the old identity', () => {
  const adapter = new ServerHttpClientTransportAdapter({
    transport: () => '{"status":204,"body":""}',
  })
  assert.equal(adapter.adapterContract(), SERVER_HTTP_CLIENT_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_HTTP_CLIENT_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'http.client')
      .resource_catalog,
  )
  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)

  class LegacyContractAdapter extends ServerHttpClientTransportAdapter {
    adapterContract() {
      return 're.server-http-client-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter({
      transport: () => 'ok',
    }))),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
        instance: '@http',
      }],
      ok: false,
    },
  )
})

function invoke(adapter, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
    typedArguments,
  )
}

function requestFromFixture(request) {
  return {
    body: Uint8Array.from(Buffer.from(request.body_hex, 'hex')),
    deadline: request.deadline,
    headers: request.headers,
    method: request.method,
    redirect_policy: request.redirect_policy,
    url: request.url,
  }
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
