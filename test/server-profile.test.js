import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { HostEnvironment } from '../src/host/host-environment.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import {
  ServerHttpClientMemoryAdapter,
  httpClientRequestKey,
} from '../src/host/server-http-client-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import {
  bindServerProfile,
  buildServerProfile,
  SERVER_CONFIG_ADAPTER_CONTRACT,
  SERVER_CONFIG_REFERENCE,
  SERVER_CLOCK_ADAPTER_CONTRACT,
  SERVER_CLOCK_REFERENCE,
  SERVER_RANDOM_ADAPTER_CONTRACT,
  SERVER_RANDOM_REFERENCE,
  SERVER_SECRET_ADAPTER_CONTRACT,
  SERVER_SECRET_REFERENCE,
  SERVER_LOG_ADAPTER_CONTRACT,
  SERVER_LOG_REFERENCE,
  SERVER_TRACE_ADAPTER_CONTRACT,
  SERVER_TRACE_REFERENCE,
  SERVER_JSON_ADAPTER_CONTRACT,
  SERVER_JSON_REFERENCE,
  SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
  SERVER_HTTP_CLIENT_REFERENCE,
  SERVER_DB_SQL_ADAPTER_CONTRACT,
  SERVER_DB_SQL_REFERENCE,
  SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
  SERVER_HTTP_SERVER_REFERENCE,
  SERVER_PROFILE_ID,
  SERVER_PROFILE_SCHEMA,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('minimum Server profile is deterministic and exact-revision pinned', () => {
  const first = buildServerProfile()
  const second = buildServerProfile()

  assert.equal(
    SERVER_CONFIG_ADAPTER_CONTRACT,
    're.server-config-adapter-contract@0.1.0',
  )
  assert.equal(
    SERVER_SECRET_ADAPTER_CONTRACT,
    're.server-secret-adapter-contract@0.1.0',
  )
  assert.equal(
    SERVER_JSON_ADAPTER_CONTRACT,
    're.server-json-adapter-contract@0.1.0',
  )
  assert.equal(
    SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
    're.server-http-client-adapter-contract@0.1.0',
  )
  assert.equal(
    SERVER_DB_SQL_ADAPTER_CONTRACT,
    're.server-db-sql-adapter-contract@0.1.0',
  )
  assert.equal(
    SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
    're.server-http-server-adapter-contract@0.1.0',
  )
  assert.deepEqual(first, second)
  assert.equal(first.ok, true)
  assert.equal(first.value.schema, SERVER_PROFILE_SCHEMA)
  assert.equal(first.value.id, SERVER_PROFILE_ID)
  assert.deepEqual(
    first.value.capabilities.map(({ adapter_contract, reference }) => ({
      adapter_contract,
      reference,
    })),
    [
      {
        adapter_contract: SERVER_CLOCK_ADAPTER_CONTRACT,
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        adapter_contract: SERVER_CONFIG_ADAPTER_CONTRACT,
        reference: SERVER_CONFIG_REFERENCE,
      },
      {
        adapter_contract: SERVER_LOG_ADAPTER_CONTRACT,
        reference: SERVER_LOG_REFERENCE,
      },
      {
        adapter_contract: SERVER_RANDOM_ADAPTER_CONTRACT,
        reference: SERVER_RANDOM_REFERENCE,
      },
      {
        adapter_contract: SERVER_SECRET_ADAPTER_CONTRACT,
        reference: SERVER_SECRET_REFERENCE,
      },
      {
        adapter_contract: SERVER_TRACE_ADAPTER_CONTRACT,
        reference: SERVER_TRACE_REFERENCE,
      },
      {
        adapter_contract: SERVER_JSON_ADAPTER_CONTRACT,
        reference: SERVER_JSON_REFERENCE,
      },
      {
        adapter_contract: SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
        reference: SERVER_HTTP_CLIENT_REFERENCE,
      },
      {
        adapter_contract: SERVER_DB_SQL_ADAPTER_CONTRACT,
        reference: SERVER_DB_SQL_REFERENCE,
      },
      {
        adapter_contract: SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
        reference: SERVER_HTTP_SERVER_REFERENCE,
      },
    ],
  )
  assert.match(first.value.profile_digest, /^sha256:[0-9a-f]{64}$/)
  assert.match(first.value.capabilities[0].content_digest, /^sha256:[0-9a-f]{64}$/)
})

test('Server profile identity changes when the capability schema changes', () => {
  const baseline = buildServerProfile()
  const changed = serverProfileSchemaDefinitions()
  changed.find(({ identity }) => identity === 'config.read')
    .types['config.read_error'].variants.push('denied')
  const drifted = buildServerProfile(changed)

  assert.equal(baseline.ok, true)
  assert.equal(drifted.ok, true)
  const baselineConfig = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_CONFIG_REFERENCE)
  const driftedConfig = drifted.value.capabilities
    .find(({ reference }) => reference === SERVER_CONFIG_REFERENCE)
  assert.notEqual(
    baselineConfig.content_digest,
    driftedConfig.content_digest,
  )
  assert.notEqual(baseline.value.profile_digest, drifted.value.profile_digest)

  const randomChanged = serverProfileSchemaDefinitions()
  randomChanged.find(({ identity }) => identity === 'random.bytes')
    .types['random.bytes_error'].variants.push('quota_exceeded')
  const randomDrifted = buildServerProfile(randomChanged)
  const baselineRandom = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_RANDOM_REFERENCE)
  const driftedRandom = randomDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_RANDOM_REFERENCE)
  assert.notEqual(baselineRandom.content_digest, driftedRandom.content_digest)
  assert.notEqual(baseline.value.profile_digest, randomDrifted.value.profile_digest)

  const secretChanged = serverProfileSchemaDefinitions()
  secretChanged.find(({ identity }) => identity === 'secret.read')
    .types['secret.read_error'].variants.push('expired')
  const secretDrifted = buildServerProfile(secretChanged)
  const baselineSecret = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_SECRET_REFERENCE)
  const driftedSecret = secretDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_SECRET_REFERENCE)
  assert.notEqual(baselineSecret.content_digest, driftedSecret.content_digest)
  assert.notEqual(baseline.value.profile_digest, secretDrifted.value.profile_digest)

  const logChanged = serverProfileSchemaDefinitions()
  logChanged.find(({ identity }) => identity === 'log.event')
    .types['log.write_error'].variants.push('rate_limited')
  const logDrifted = buildServerProfile(logChanged)
  const baselineLog = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_LOG_REFERENCE)
  const driftedLog = logDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_LOG_REFERENCE)
  assert.notEqual(baselineLog.content_digest, driftedLog.content_digest)
  assert.notEqual(baseline.value.profile_digest, logDrifted.value.profile_digest)

  const traceChanged = serverProfileSchemaDefinitions()
  traceChanged.find(({ identity }) => identity === 'trace.event')
    .types['trace.write_error'].variants.push('rate_limited')
  const traceDrifted = buildServerProfile(traceChanged)
  const baselineTrace = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_TRACE_REFERENCE)
  const driftedTrace = traceDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_TRACE_REFERENCE)
  assert.notEqual(baselineTrace.content_digest, driftedTrace.content_digest)
  assert.notEqual(baseline.value.profile_digest, traceDrifted.value.profile_digest)

  const jsonChanged = serverProfileSchemaDefinitions()
  jsonChanged.find(({ identity }) => identity === 'data.json')
    .types['data.json_error'].variants.push('too_large')
  const jsonDrifted = buildServerProfile(jsonChanged)
  const baselineJson = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_JSON_REFERENCE)
  const driftedJson = jsonDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_JSON_REFERENCE)
  assert.notEqual(baselineJson.content_digest, driftedJson.content_digest)
  assert.notEqual(baseline.value.profile_digest, jsonDrifted.value.profile_digest)

  const httpChanged = serverProfileSchemaDefinitions()
  httpChanged.find(({ identity }) => identity === 'http.client')
    .types['http.client_error'].variants.push('tls_failed')
  const httpDrifted = buildServerProfile(httpChanged)
  const baselineHttp = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_HTTP_CLIENT_REFERENCE)
  const driftedHttp = httpDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_HTTP_CLIENT_REFERENCE)
  assert.notEqual(baselineHttp.content_digest, driftedHttp.content_digest)
  assert.notEqual(baseline.value.profile_digest, httpDrifted.value.profile_digest)

  const sqlChanged = serverProfileSchemaDefinitions()
  sqlChanged.find(({ identity }) => identity === 'db.sql')
    .types['db.sql_error'].variants.push('serialization_failed')
  const sqlDrifted = buildServerProfile(sqlChanged)
  const baselineSql = baseline.value.capabilities
    .find(({ reference }) => reference === SERVER_DB_SQL_REFERENCE)
  const driftedSql = sqlDrifted.value.capabilities
    .find(({ reference }) => reference === SERVER_DB_SQL_REFERENCE)
  assert.notEqual(baselineSql.content_digest, driftedSql.content_digest)
  assert.notEqual(baseline.value.profile_digest, sqlDrifted.value.profile_digest)

  const serverChanged = serverProfileSchemaDefinitions()
  serverChanged.find(({ identity }) => identity === 'http.server')
    .types['http.server_error'].variants.push('listener_closed')
  const serverDrifted = buildServerProfile(serverChanged)
  assert.notEqual(
    baseline.value.capabilities.find(
      ({ reference }) => reference === SERVER_HTTP_SERVER_REFERENCE,
    ).content_digest,
    serverDrifted.value.capabilities.find(
      ({ reference }) => reference === SERVER_HTTP_SERVER_REFERENCE,
    ).content_digest,
  )
  assert.notEqual(baseline.value.profile_digest, serverDrifted.value.profile_digest)
})

test('Server config memory adapter passes the shared conformance corpus', () => {
  assert.equal(corpus.schema, 're.server-profile-conformance@0.1.0')
  for (const vector of corpus.config_vectors) {
    const adapter = new ServerConfigMemoryAdapter({
      unavailable: vector.unavailable === true,
      values: new Map(vector.values),
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

test('Server config memory adapter ignores overridden registry iteration', () => {
  let spoofCalls = 0
  const values = new Map([['app.mode', 'legitimate']])
  values[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['app.mode', 'spoof']
  }
  const adapter = new ServerConfigMemoryAdapter({ values })

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_CONFIG_REFERENCE, member: 'get' },
      { key: 'app.mode' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'legitimate' } },
  )
  assert.equal(spoofCalls, 0)
})

test('Server monotonic clock adapter replays nondecreasing instants and exhausts closed', () => {
  for (const vector of corpus.clock_vectors) {
    const adapter = new ServerClockMemoryAdapter({ instants: vector.instants })
    if (vector.expected !== undefined) {
      const actual = vector.expected.map((_, index) =>
        adapter.invoke(
          { interface: SERVER_CLOCK_REFERENCE, member: 'now' },
          {},
          `${vector.id}-${index}`,
        ).value.value)
      assert.deepEqual(actual, vector.expected, vector.id)
    } else {
      assert.deepEqual(
        adapter.invoke(
          { interface: SERVER_CLOCK_REFERENCE, member: 'now' },
          {},
          vector.id,
        ),
        {
          kind: 'value',
          value: {
            error: {
              type: 'clock.monotonic_error',
              variant: vector.expected_error,
            },
            kind: 'err',
          },
        },
      )
    }
  }
  assert.throws(
    () => new ServerClockMemoryAdapter({ instants: [2, 1] }),
    /nondecreasing safe integers/,
  )
})

test('Server monotonic clock adapter ignores overridden instant iteration', () => {
  let spoofCalls = 0
  const instants = [11]
  instants[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield spoofCalls === 1 ? 11 : 99
  }
  const adapter = new ServerClockMemoryAdapter({ instants })

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_CLOCK_REFERENCE, member: 'now' },
      {},
    ),
    { kind: 'value', value: { kind: 'ok', value: 11 } },
  )
  assert.equal(spoofCalls, 0)
})

test('Server random adapter replays exact-length bytes and returns closed errors', () => {
  for (const vector of corpus.random_vectors) {
    const adapter = new ServerRandomMemoryAdapter({
      chunks: vector.chunks_hex.map((hex) => Uint8Array.from(Buffer.from(hex, 'hex'))),
    })
    for (const request of vector.requests) {
      const actual = adapter.invoke(
        { interface: SERVER_RANDOM_REFERENCE, member: 'fill' },
        { length: request.length },
        `${vector.id}-${request.length}`,
      )
      if (request.expected_hex !== undefined) {
        assert.equal(actual.kind, 'value')
        assert.equal(actual.value.kind, 'ok')
        assert.equal(Buffer.from(actual.value.value).toString('hex'), request.expected_hex)
      } else {
        assert.deepEqual(actual, {
          kind: 'value',
          value: {
            error: {
              type: 'random.bytes_error',
              variant: request.expected_error,
            },
            kind: 'err',
          },
        })
      }
    }
  }
  assert.throws(
    () => new ServerRandomMemoryAdapter({ chunks: ['not-bytes'] }),
    /Uint8Array/,
  )
  const proxyChunk = new Proxy(Uint8Array.of(0x11, 0x22), {
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
    () => new ServerRandomMemoryAdapter({ chunks: [proxyChunk] }),
    /Uint8Array/,
  )
  const mismatched = new ServerRandomMemoryAdapter({
    chunks: [Uint8Array.of(1, 2)],
  })
  assert.throws(
    () => mismatched.invoke(
      { interface: SERVER_RANDOM_REFERENCE, member: 'fill' },
      { length: 1 },
      'RANDOM-MISMATCH',
    ),
    /requested length/,
  )
})

test('Server random adapter ignores overridden chunk array methods', () => {
  let spoofCalls = 0
  const chunks = [Uint8Array.of(0x11)]
  chunks.map = () => {
    spoofCalls += 1
    return [Uint8Array.of(0x99)]
  }
  const adapter = new ServerRandomMemoryAdapter({ chunks })

  const result = adapter.invoke(
    { interface: SERVER_RANDOM_REFERENCE, member: 'fill' },
    { length: 1 },
  )
  assert.equal(Buffer.from(result.value.value).toString('hex'), '11')
  assert.equal(spoofCalls, 0)
})

test('Server secret adapter replays immutable bytes and closed errors', () => {
  for (const vector of corpus.secret_vectors) {
    const adapter = new ServerSecretMemoryAdapter({
      unavailable: vector.unavailable === true,
      values: new Map(vector.values_hex.map(([key, hex]) => [
        key,
        Uint8Array.from(Buffer.from(hex, 'hex')),
      ])),
    })
    const actual = adapter.invoke(
      { interface: SERVER_SECRET_REFERENCE, member: 'get' },
      { name: vector.name },
      vector.id,
    )
    if (vector.expected_hex !== undefined) {
      assert.equal(actual.kind, 'value')
      assert.equal(actual.value.kind, 'ok')
      assert.equal(Buffer.from(actual.value.value).toString('hex'), vector.expected_hex)
      actual.value.value[0] = 0
      const replay = adapter.invoke(
        { interface: SERVER_SECRET_REFERENCE, member: 'get' },
        { name: vector.name },
        `${vector.id}-replay`,
      )
      assert.equal(Buffer.from(replay.value.value).toString('hex'), vector.expected_hex)
    } else {
      assert.deepEqual(actual, {
        kind: 'value',
        value: {
          error: {
            type: 'secret.read_error',
            variant: vector.expected_error,
          },
          kind: 'err',
        },
      })
    }
  }
  assert.throws(
    () => new ServerSecretMemoryAdapter({
      values: new Map([['api.token', 'not-bytes']]),
    }),
    /Uint8Array/,
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
    () => new ServerSecretMemoryAdapter({
      values: new Map([['proxy', proxySecret]]),
    }),
    /Uint8Array/,
  )
})

test('Server secret memory adapter ignores overridden registry iteration', () => {
  let spoofCalls = 0
  const values = new Map([['api.token', Uint8Array.of(0x73, 0x65, 0x63, 0x72, 0x65, 0x74)]])
  values[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['api.token', Uint8Array.of(0x66, 0x61, 0x6b, 0x65)]
  }
  const adapter = new ServerSecretMemoryAdapter({ values })

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
  assert.equal(spoofCalls, 0)
})

test('Server log adapter appends exact structured entries or returns unavailable', () => {
  for (const vector of corpus.log_vectors) {
    const adapter = new ServerLogMemoryAdapter({
      unavailable: vector.unavailable === true,
    })
    for (const entry of vector.entries) {
      const actual = adapter.invoke(
        { interface: SERVER_LOG_REFERENCE, member: 'emit' },
        entry,
        `${vector.id}-${entry.attempt}`,
      )
      if (vector.expected_error === undefined) {
        assert.deepEqual(actual, {
          kind: 'value',
          value: { kind: 'ok', value: null },
        })
      } else {
        assert.deepEqual(actual, {
          kind: 'value',
          value: {
            error: {
              type: 'log.write_error',
              variant: vector.expected_error,
            },
            kind: 'err',
          },
        })
      }
    }
    assert.deepEqual(
      adapter.entries(),
      vector.expected_error === undefined ? vector.entries : [],
      vector.id,
    )
  }
})

test('Server trace adapter appends exact structured events or returns unavailable', () => {
  for (const vector of corpus.trace_vectors) {
    const adapter = new ServerTraceMemoryAdapter({
      unavailable: vector.unavailable === true,
    })
    for (const event of vector.events) {
      const actual = adapter.invoke(
        { interface: SERVER_TRACE_REFERENCE, member: 'record' },
        event,
        `${vector.id}-${event.event}`,
      )
      assert.deepEqual(
        actual,
        vector.expected_error === undefined
          ? { kind: 'value', value: { kind: 'ok', value: null } }
          : {
              kind: 'value',
              value: {
                error: {
                  type: 'trace.write_error',
                  variant: vector.expected_error,
                },
                kind: 'err',
              },
            },
      )
    }
    assert.deepEqual(
      adapter.events(),
      vector.expected_error === undefined ? vector.events : [],
      vector.id,
    )
  }
})

test('Server JSON adapter selects an explicit schema for encode/decode', () => {
  for (const vector of corpus.json_vectors) {
    const schemas = new Map(vector.schemas.map((schema) => [
      schema.reference,
      {
        decode: new Map(schema.decode),
        encode: new Map(schema.encode),
      },
    ]))
    const adapter = new ServerJsonMemoryAdapter({
      unavailable: vector.unavailable === true,
      schemas,
    })
    const firstSchema = vector.schemas[0]
    if (firstSchema.encode.length > 0) {
      schemas.get(firstSchema.reference).encode.set(
        firstSchema.encode[0][0],
        'mutated-after-construction',
      )
    }
    for (const operation of vector.operations) {
      const actual = adapter.invoke(
        { interface: SERVER_JSON_REFERENCE, member: operation.member },
        {
          [operation.member === 'encode' ? 'schema' : 'schema']: operation.schema,
          [operation.member === 'encode' ? 'value' : 'payload']: operation.input,
        },
        `${vector.id}-${operation.member}`,
      )
      assert.deepEqual(actual, operation.expected_error === undefined
        ? {
            kind: 'value',
            value: { kind: 'ok', value: operation.output },
          }
        : {
            kind: 'value',
            value: {
              error: {
                type: 'data.json_error',
                variant: operation.expected_error,
              },
              kind: 'err',
            },
          })
    }
  }
})

test('Server JSON memory adapter ignores overridden schema registry iteration', () => {
  let spoofCalls = 0
  const legitimate = {
    decode: new Map([['payload', 'value']]),
    encode: new Map([['value', 'legitimate']]),
  }
  const spoof = {
    decode: new Map([['payload', 'spoof']]),
    encode: new Map([['value', 'spoof']]),
  }
  const schemas = new Map([['example@0.1.0', legitimate]])
  schemas[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['example@0.1.0', spoofCalls === 1 ? legitimate : spoof]
  }
  const adapter = new ServerJsonMemoryAdapter({ schemas })

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_JSON_REFERENCE, member: 'encode' },
      { schema: 'example@0.1.0', value: 'value' },
    ),
    { kind: 'value', value: { kind: 'ok', value: 'legitimate' } },
  )
  assert.equal(spoofCalls, 0)
})

test('Server HTTP client replays exact requests and closed transport errors', () => {
  for (const vector of corpus.http_client_vectors) {
    const responses = new Map(vector.responses.map((entry) => [
      httpClientRequestKey({
        body: Uint8Array.from(Buffer.from(entry.request.body_hex, 'hex')),
        deadline: entry.request.deadline,
        headers: entry.request.headers,
        method: entry.request.method,
        redirect_policy: entry.request.redirect_policy,
        url: entry.request.url,
      }),
      entry.outcome,
    ]))
    const adapter = new ServerHttpClientMemoryAdapter({
      unavailable: vector.unavailable === true,
      responses,
    })
    const firstResponse = responses.entries().next().value
    if (firstResponse !== undefined) {
      responses.set(firstResponse[0], 'mutated-after-construction')
    }
    for (const request of vector.requests) {
      const actual = adapter.invoke(
        { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
        {
          body: Uint8Array.from(Buffer.from(request.body_hex, 'hex')),
          deadline: request.deadline,
          headers: request.headers,
          method: request.method,
          redirect_policy: request.redirect_policy,
          url: request.url,
        },
        `${vector.id}-${request.url}`,
      )
      assert.deepEqual(
        actual,
        request.expected_error === undefined
          ? { kind: 'value', value: { kind: 'ok', value: request.response } }
          : {
              kind: 'value',
              value: {
                error: {
                  type: 'http.client_error',
                  variant: request.expected_error,
                },
                kind: 'err',
              },
            },
      )
    }
  }
})

test('Server HTTP client memory adapter ignores overridden registry iteration', () => {
  let spoofCalls = 0
  const request = {
    body: new Uint8Array(),
    deadline: 5000,
    headers: 'accept:application/json',
    method: 'GET',
    redirect_policy: 'follow',
    url: 'https://api.example.test/users',
  }
  const responses = new Map([[
    httpClientRequestKey(request),
    '{"status":200,"body":"legit"}',
  ]])
  responses[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield [
      httpClientRequestKey(request),
      '{"status":200,"body":"spoof"}',
    ]
  }
  const adapter = new ServerHttpClientMemoryAdapter({ responses })

  assert.deepEqual(
    adapter.invoke(
      { interface: SERVER_HTTP_CLIENT_REFERENCE, member: 'request' },
      request,
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: '{"status":200,"body":"legit"}' },
    },
  )
  assert.equal(spoofCalls, 0)
})

test('Server profile binds exact adapter metadata and invokes declared errors', () => {
  const adapter = new ServerConfigMemoryAdapter({
    values: new Map([['app.mode', 'production']]),
  })
  const clockAdapter = new ServerClockMemoryAdapter({ instants: [42] })
  const randomAdapter = new ServerRandomMemoryAdapter({
    chunks: [Uint8Array.of(0xde, 0xad)],
  })
  const secretAdapter = new ServerSecretMemoryAdapter({
    values: new Map([['api.token', Uint8Array.of(0x73, 0x65)]]),
  })
  const logAdapter = new ServerLogMemoryAdapter()
  const traceAdapter = new ServerTraceMemoryAdapter()
  const jsonAdapter = new ServerJsonMemoryAdapter({
    schemas: new Map([[
      'example.record@0.1.0',
      {
        decode: new Map([[
          '{"age":37,"name":"Ada"}',
          '{"name":"Ada","age":37}',
        ]]),
        encode: new Map([[
          '{"name":"Ada","age":37}',
          '{"age":37,"name":"Ada"}',
        ]]),
      },
    ]]),
  })
  const httpRequest = {
    body: new Uint8Array(),
    deadline: 5000,
    headers: 'accept:application/json',
    method: 'GET',
    redirect_policy: 'follow',
    url: 'https://api.example.test/users',
  }
  const httpClientAdapter = new ServerHttpClientMemoryAdapter({
    responses: new Map([[
      httpClientRequestKey(httpRequest),
      '{"status":200,"body":"[]"}',
    ]]),
  })
  const dbSqlAdapter = new ServerDbSqlMemoryAdapter({
    transactions: ['tx-profile'],
  })
  const httpServerAdapter = new ServerHttpServerMemoryAdapter()
  const bound = bindServerProfile({
    adapter,
    clockAdapter,
    logAdapter,
    randomAdapter,
    secretAdapter,
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  })

  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.invoke('@config', 'get', { key: 'app.mode' }, 'config-1'),
    { kind: 'value', value: { kind: 'ok', value: 'production' } },
  )
  assert.deepEqual(
    bound.value.invoke('@clock', 'now', {}, 'clock-1'),
    { kind: 'value', value: { kind: 'ok', value: 42 } },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@clock', 'now'),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'7'.repeat(64)}`,
          segments: [],
        },
      }],
    },
  )
  assert.deepEqual(
    bound.value.invoke('@random', 'fill', { length: 2 }, 'random-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: Uint8Array.of(0xde, 0xad) },
    },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@random', 'fill', { length: 2 }),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'8'.repeat(64)}`,
          segments: [],
        },
      }],
    },
  )
  assert.deepEqual(
    bound.value.invoke('@secret', 'get', { name: 'api.token' }, 'secret-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: Uint8Array.of(0x73, 0x65) },
    },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@secret', 'get', { name: 'api.token' }),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'9'.repeat(64)}`,
          segments: [{
            canonical_hex: Buffer.from('api.token').toString('hex'),
            type_digest: `sha256:${'a'.repeat(64)}`,
          }],
        },
      }],
    },
  )
  const logEntry = {
    attempt: 1,
    level: 'info',
    message: 'ready',
    node_uid: '3kf2a2bc4de6fg7h2j4km6np7q',
    request_correlation: 'req-42',
    task_id: 'request-main',
  }
  assert.deepEqual(
    bound.value.invoke('@log', 'emit', logEntry, 'log-1'),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(logAdapter.entries(), [logEntry])
  assert.deepEqual(
    bound.value.resourceFootprint('@log', 'emit', logEntry),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'write',
        resource: {
          domain_digest: `sha256:${'b'.repeat(64)}`,
          segments: [],
        },
      }],
    },
  )
  const traceEvent = {
    attempt: 1,
    event: 'request.start',
    node_uid: '3kf2a2bc4de6fg7h2j4km6np7q',
    parent_span_id: '',
    request_correlation: 'req-42',
    span_id: 'span-1',
    task_id: 'request-main',
  }
  assert.deepEqual(
    bound.value.invoke('@trace', 'record', traceEvent, 'trace-1'),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(traceAdapter.events(), [traceEvent])
  assert.deepEqual(
    bound.value.resourceFootprint('@trace', 'record', traceEvent),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'write',
        resource: {
          domain_digest: `sha256:${'c'.repeat(64)}`,
          segments: [],
        },
      }],
    },
  )
  const jsonArguments = {
    schema: 'example.record@0.1.0',
    value: '{"name":"Ada","age":37}',
  }
  assert.deepEqual(
    bound.value.invoke('@json', 'encode', jsonArguments, 'json-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: '{"age":37,"name":"Ada"}' },
    },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@json', 'encode', jsonArguments),
    {
      ok: true,
      value: [
        {
          handle: null,
          mode: 'read',
          resource: {
            domain_digest: `sha256:${'d'.repeat(64)}`,
            segments: [{
              canonical_hex: Buffer.from('example.record@0.1.0').toString('hex'),
              type_digest: `sha256:${'e'.repeat(64)}`,
            }],
          },
        },
        {
          handle: null,
          mode: 'write',
          resource: {
            domain_digest: `sha256:${'f'.repeat(64)}`,
            segments: [],
          },
        },
      ],
    },
  )
  assert.deepEqual(
    bound.value.invoke('@http', 'request', httpRequest, 'http-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: '{"status":200,"body":"[]"}' },
    },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@http', 'request', httpRequest),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'a'.repeat(64)}`,
          segments: [{
            canonical_hex: Buffer.from(httpRequest.url).toString('hex'),
            type_digest: `sha256:${'b'.repeat(64)}`,
          }],
        },
      }],
    },
  )
  assert.deepEqual(
    bound.value.invoke('@sql', 'begin', { database: 'main' }, 'sql-1'),
    { kind: 'value', value: { kind: 'ok', value: 'tx-profile' } },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@sql', 'query', {
      bound_parameters: new Uint8Array(),
      database: 'main',
      statement: 'select 1',
      transaction: 'tx-profile',
    }),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'c'.repeat(64)}`,
          segments: [{
            canonical_hex: Buffer.from('main').toString('hex'),
            type_digest: `sha256:${'d'.repeat(64)}`,
          }],
        },
      }],
    },
  )
  assert.deepEqual(
    bound.value.invoke('@config', 'get', { key: 'missing' }, 'config-2'),
    {
      kind: 'value',
      value: {
        error: { type: 'config.read_error', variant: 'not_found' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(
    bound.value.resourceFootprint('@config', 'get', { key: 'app.mode' }),
    {
      ok: true,
      value: [{
        handle: null,
        mode: 'read',
        resource: {
          domain_digest: `sha256:${'5'.repeat(64)}`,
          segments: [{
            canonical_hex: Buffer.from('app.mode').toString('hex'),
            type_digest: `sha256:${'6'.repeat(64)}`,
          }],
        },
      }],
    },
  )
})

test('Server profile fails closed on unknown revision and metadata mismatch', () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const adapter = new ServerConfigMemoryAdapter()
  const logAdapter = new ServerLogMemoryAdapter()
  const traceAdapter = new ServerTraceMemoryAdapter()
  const jsonAdapter = new ServerJsonMemoryAdapter()
  const httpClientAdapter = new ServerHttpClientMemoryAdapter()
  const dbSqlAdapter = new ServerDbSqlMemoryAdapter()
  const httpServerAdapter = new ServerHttpServerMemoryAdapter()
  const unknown = HostEnvironment.bind({
    bindings: [{ adapter, instance: '@config' }],
    capabilities: [{ instance: '@config', reference: 'config.read@0.2.0' }],
    registry,
  })
  assert.deepEqual(unknown, {
    diagnostics: [{
      code: 'missing-schema-revision',
      instance: '@config',
      reference: 'config.read@0.2.0',
    }],
    ok: false,
  })

  class MismatchedAdapter extends ServerConfigMemoryAdapter {
    resourceCatalog() {
      return {
        ...super.resourceCatalog(),
        'config.entry': {
          domain_digest: `sha256:${'f'.repeat(64)}`,
          segments: [],
        },
      }
    }
  }
  const mismatched = HostEnvironment.bind({
    bindings: [{ adapter: new MismatchedAdapter(), instance: '@config' }],
    capabilities: [{ instance: '@config', reference: SERVER_CONFIG_REFERENCE }],
    registry,
  })
  assert.equal(mismatched.ok, false)
  assert.equal(
    mismatched.diagnostics[0].code,
    'adapter-resource-catalog-mismatch',
  )

  class WrongContractAdapter extends ServerConfigMemoryAdapter {
    adapterContract() {
      return 're.other-adapter@0.1.0'
    }
  }
  assert.deepEqual(bindServerProfile({
    adapter: new WrongContractAdapter(),
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'server-profile-adapter-contract-mismatch',
      expected: SERVER_CONFIG_ADAPTER_CONTRACT,
      instance: '@config',
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@clock',
      reference: SERVER_CLOCK_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@secret',
      reference: SERVER_SECRET_REFERENCE,
    }],
    ok: false,
  })

  class WrongRandomContractAdapter extends ServerRandomMemoryAdapter {
    adapterContract() {
      return 're.other-random-adapter@0.1.0'
    }
  }
  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new WrongRandomContractAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'server-profile-adapter-contract-mismatch',
      expected: SERVER_RANDOM_ADAPTER_CONTRACT,
      instance: '@random',
    }],
    ok: false,
  })

  class MismatchedRandomAdapter extends ServerRandomMemoryAdapter {
    resourceCatalog() {
      return {
        'random.entropy': {
          domain_digest: `sha256:${'f'.repeat(64)}`,
          segments: [],
        },
      }
    }
  }
  const randomMetadataMismatch = HostEnvironment.bind({
    bindings: [{
      adapter: new MismatchedRandomAdapter(),
      instance: '@random',
    }],
    capabilities: [{
      instance: '@random',
      reference: SERVER_RANDOM_REFERENCE,
    }],
    registry,
  })
  assert.equal(randomMetadataMismatch.ok, false)
  assert.equal(
    randomMetadataMismatch.diagnostics[0].code,
    'adapter-resource-catalog-mismatch',
  )

  const unknownRandom = HostEnvironment.bind({
    bindings: [{
      adapter: new ServerRandomMemoryAdapter(),
      instance: '@random',
    }],
    capabilities: [{
      instance: '@random',
      reference: 'random.bytes@0.2.0',
    }],
    registry,
  })
  assert.deepEqual(unknownRandom, {
    diagnostics: [{
      code: 'missing-schema-revision',
      instance: '@random',
      reference: 'random.bytes@0.2.0',
    }],
    ok: false,
  })

  class WrongSecretContractAdapter extends ServerSecretMemoryAdapter {
    adapterContract() {
      return 're.other-secret-adapter@0.1.0'
    }
  }
  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new WrongSecretContractAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'server-profile-adapter-contract-mismatch',
      expected: SERVER_SECRET_ADAPTER_CONTRACT,
      instance: '@secret',
    }],
    ok: false,
  })

  class MismatchedSecretAdapter extends ServerSecretMemoryAdapter {
    resourceCatalog() {
      return {
        ...super.resourceCatalog(),
        'secret.entry': {
          domain_digest: `sha256:${'f'.repeat(64)}`,
          segments: [],
        },
      }
    }
  }
  const secretMetadataMismatch = HostEnvironment.bind({
    bindings: [{
      adapter: new MismatchedSecretAdapter(),
      instance: '@secret',
    }],
    capabilities: [{
      instance: '@secret',
      reference: SERVER_SECRET_REFERENCE,
    }],
    registry,
  })
  assert.equal(secretMetadataMismatch.ok, false)
  assert.equal(
    secretMetadataMismatch.diagnostics[0].code,
    'adapter-resource-catalog-mismatch',
  )

  const unknownSecret = HostEnvironment.bind({
    bindings: [{
      adapter: new ServerSecretMemoryAdapter(),
      instance: '@secret',
    }],
    capabilities: [{
      instance: '@secret',
      reference: 'secret.read@0.2.0',
    }],
    registry,
  })
  assert.deepEqual(unknownSecret, {
    diagnostics: [{
      code: 'missing-schema-revision',
      instance: '@secret',
      reference: 'secret.read@0.2.0',
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@log',
      reference: SERVER_LOG_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    jsonAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@trace',
      reference: SERVER_TRACE_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    httpClientAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@json',
      reference: SERVER_JSON_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    dbSqlAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@http',
      reference: SERVER_HTTP_CLIENT_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
    httpServerAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@sql',
      reference: SERVER_DB_SQL_REFERENCE,
    }],
    ok: false,
  })

  assert.deepEqual(bindServerProfile({
    adapter,
    clockAdapter: new ServerClockMemoryAdapter(),
    dbSqlAdapter,
    logAdapter,
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter,
    jsonAdapter,
    httpClientAdapter,
  }), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@server',
      reference: SERVER_HTTP_SERVER_REFERENCE,
    }],
    ok: false,
  })
})
