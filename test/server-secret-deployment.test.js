import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretDeploymentAdapter } from '../src/host/server-secret-deployment-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_SECRET_ADAPTER_CONTRACT,
  SERVER_SECRET_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('Server secret deployment adapter is an explicit host adapter', async () => {
  const module = await import(
    '../src/host/server-secret-deployment-adapter.js'
  )

  assert.equal(typeof module.ServerSecretDeploymentAdapter, 'function')
})

test('Server secret deployment adapter passes the shared secret corpus', () => {
  for (const vector of corpus.secret_vectors) {
    const adapter = new ServerSecretDeploymentAdapter({
      secrets: new Map(vector.values_hex.map(([name, hex]) => [
        name,
        Uint8Array.from(Buffer.from(hex, 'hex')),
      ])),
      unavailable: vector.unavailable === true,
    })
    const expected = vector.expected_hex === undefined
      ? {
          kind: 'value',
          value: {
            error: {
              type: 'secret.read_error',
              variant: vector.expected_error,
            },
            kind: 'err',
          },
        }
      : {
          kind: 'value',
          value: {
            kind: 'ok',
            value: Uint8Array.from(Buffer.from(vector.expected_hex, 'hex')),
          },
        }
    assert.deepEqual(
      checkAdapterVector({
        adapter,
        expectedOutcome: expected,
        expectedState: null,
        invocationId: vector.id,
        observeState: () => null,
        operation: { interface: SERVER_SECRET_REFERENCE, member: 'get' },
        typedArguments: { name: vector.name },
      }),
      { diagnostics: [], ok: true },
      vector.id,
    )
  }
})

test('Server secret deployment adapter copies injected and returned bytes', () => {
  const original = Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74)
  const secrets = new Map([['api.token', original]])
  const adapter = new ServerSecretDeploymentAdapter({ secrets })
  original[0] = 0x00
  secrets.get('api.token')[1] = 0x00

  const first = adapter.invoke(
    { interface: SERVER_SECRET_REFERENCE, member: 'get' },
    { name: 'api.token' },
  )
  assert.deepEqual(first, {
    kind: 'value',
    value: { kind: 'ok', value: Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74) },
  })
  first.value.value[0] = 0x00
  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_SECRET_REFERENCE, member: 'get' },
      { name: 'api.token' },
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74) },
    },
  )
  assert.throws(
    () => new ServerSecretDeploymentAdapter({
      secrets: new Map([['api.token', 'secret']]),
    }),
    /secret values must map text names to Uint8Array/,
  )
  const proxySecret = new Proxy(Uint8Array.of(0x11, 0x22), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  assert.throws(
    () => new ServerSecretDeploymentAdapter({
      secrets: new Map([['proxy', proxySecret]]),
    }),
    /Uint8Array/,
  )
})

test('Server secret deployment adapter ignores overridden registry iteration', () => {
  let spoofCalls = 0
  const secrets = new Map([[
    'api.token',
    Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74),
  ]])
  secrets[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['api.token', Uint8Array.of(0x66, 0x61, 0x6b, 0x65)]
  }
  const adapter = new ServerSecretDeploymentAdapter({ secrets })

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_SECRET_REFERENCE, member: 'get' },
      { name: 'api.token' },
    ),
    {
      kind: 'value',
      value: {
        kind: 'ok',
        value: Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74),
      },
    },
  )
  assert.equal(spoofCalls, 0)
})

test('Server secret deployment adapter closes and revokes its injected snapshot', () => {
  const original = Uint8Array.from(Buffer.from('deployment-token'))
  const adapter = new ServerSecretDeploymentAdapter({
    secrets: new Map([['api.token', original]]),
  })
  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_SECRET_REFERENCE, member: 'get' },
      { name: 'api.token' },
    ),
    {
      kind: 'value',
      value: {
        kind: 'ok',
        value: Uint8Array.from(Buffer.from('deployment-token')),
      },
    },
  )

  assert.deepEqual(adapter.close(), { ok: true })
  assert.deepEqual(adapter.close(), { error: 'closed', ok: false })
  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_SECRET_REFERENCE, member: 'get' },
      { name: 'api.token' },
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'secret.read_error', variant: 'unavailable' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(original, Uint8Array.from(Buffer.from('deployment-token')))
})

test('Server profile accepts shared secret contract and rejects the old identity', () => {
  const adapter = new ServerSecretDeploymentAdapter({
    secrets: new Map([['api.token', Uint8Array.of(0x73, 0x65)]]),
  })
  assert.equal(adapter.adapterContract(), SERVER_SECRET_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_SECRET_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'secret.read')
      .resource_catalog,
  )
  assert.deepEqual(
    adapter.resourceParents(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'secret.read')
      .resource_parents,
  )

  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.invoke('@secret', 'get', { name: 'api.token' }, 'secret-deploy-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: Uint8Array.of(0x73, 0x65) },
    },
  )

  class LegacyContractAdapter extends ServerSecretDeploymentAdapter {
    adapterContract() {
      return 're.server-secret-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter())),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_SECRET_ADAPTER_CONTRACT,
        instance: '@secret',
      }],
      ok: false,
    },
  )
})

function requiredBindings(secretAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter: new ServerConfigMemoryAdapter(),
    dbSqlAdapter: new ServerDbSqlMemoryAdapter(),
    httpClientAdapter: new ServerHttpClientMemoryAdapter(),
    httpServerAdapter: new ServerHttpServerMemoryAdapter(),
    jsonAdapter: new ServerJsonMemoryAdapter(),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter,
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
