import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigEnvironmentAdapter } from '../src/host/server-config-environment-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_CONFIG_ADAPTER_CONTRACT,
  SERVER_CONFIG_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('Server config environment adapter is an explicit host adapter', async () => {
  const module = await import(
    '../src/host/server-config-environment-adapter.js'
  )

  assert.equal(typeof module.ServerConfigEnvironmentAdapter, 'function')
})

test('Server config environment adapter passes the shared config corpus', () => {
  for (const vector of corpus.config_vectors) {
    const adapter = new ServerConfigEnvironmentAdapter({
      environment: Object.fromEntries(vector.values),
      unavailable: vector.unavailable === true,
    })
    assert.deepEqual(
      checkAdapterVector({
        adapter,
        expectedOutcome: vector.expected,
        expectedState: null,
        invocationId: vector.id,
        observeState: () => null,
        operation: { interface: SERVER_CONFIG_REFERENCE, member: 'get' },
        typedArguments: { key: vector.key },
      }),
      { diagnostics: [], ok: true },
      vector.id,
    )
  }
})

test('Server config environment adapter snapshots only explicit string values', () => {
  const environment = { APP_MODE: 'production' }
  const adapter = new ServerConfigEnvironmentAdapter({ environment })
  environment.APP_MODE = 'development'

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_CONFIG_REFERENCE, member: 'get' },
      { key: 'APP_MODE' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'production' } },
  )
  assert.deepEqual(
    new ServerConfigEnvironmentAdapter().invoke(
      { interface: SERVER_CONFIG_REFERENCE, member: 'get' },
      { key: 'PATH' },
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'config.read_error', variant: 'not_found' },
        kind: 'err',
      },
    },
  )
  assert.throws(
    () => new ServerConfigEnvironmentAdapter({
      environment: { PORT: 8080 },
    }),
    /environment values must be strings/,
  )
})

test('Server profile accepts the shared config contract and rejects the old memory identity', () => {
  const adapter = new ServerConfigEnvironmentAdapter({
    environment: { APP_MODE: 'production' },
  })
  assert.equal(adapter.adapterContract(), SERVER_CONFIG_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_CONFIG_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions()[0].resource_catalog,
  )
  assert.deepEqual(
    adapter.resourceParents(),
    serverProfileSchemaDefinitions()[0].resource_parents,
  )

  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.invoke('@config', 'get', { key: 'APP_MODE' }, 'config-env-1'),
    { kind: 'value', value: { kind: 'ok', value: 'production' } },
  )

  class LegacyContractAdapter extends ServerConfigEnvironmentAdapter {
    adapterContract() {
      return 're.server-config-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter())),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_CONFIG_ADAPTER_CONTRACT,
        instance: '@config',
      }],
      ok: false,
    },
  )
})

function requiredBindings(configAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter,
    dbSqlAdapter: new ServerDbSqlMemoryAdapter(),
    httpClientAdapter: new ServerHttpClientMemoryAdapter(),
    httpServerAdapter: new ServerHttpServerMemoryAdapter(),
    jsonAdapter: new ServerJsonMemoryAdapter(),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
