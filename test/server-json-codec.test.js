import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonCodecAdapter } from '../src/host/server-json-codec-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretMemoryAdapter } from '../src/host/server-secret-memory-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_JSON_ADAPTER_CONTRACT,
  SERVER_JSON_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/server-profile-conformance.json', import.meta.url),
  'utf8',
))

test('Server JSON codec adapter passes the shared JSON corpus', () => {
  for (const vector of corpus.json_vectors) {
    const codecs = codecsFromVector(vector)
    const adapter = new ServerJsonCodecAdapter({
      codecs,
      unavailable: vector.unavailable === true,
    })
    const first = vector.schemas[0]
    if (first !== undefined) {
      codecs.set(first.reference, {
        decode: () => 'mutated',
        encode: () => ({ mutated: true }),
      })
    }

    for (const operation of vector.operations) {
      const expected = operation.expected_error === undefined
        ? {
            kind: 'value',
            value: { kind: 'ok', value: operation.output },
          }
        : declaredError(operation.expected_error)
      assert.deepEqual(
        checkAdapterVector({
          adapter,
          expectedOutcome: expected,
          expectedState: null,
          invocationId: `${vector.id}-${operation.member}`,
          observeState: () => null,
          operation: {
            interface: SERVER_JSON_REFERENCE,
            member: operation.member,
          },
          typedArguments: {
            schema: operation.schema,
            [operation.member === 'encode' ? 'value' : 'payload']: operation.input,
          },
        }),
        { diagnostics: [], ok: true },
        `${vector.id}-${operation.member}`,
      )
    }
  }
})

test('Server JSON codec adapter sorts object keys and rejects invalid JSON values', () => {
  const adapter = new ServerJsonCodecAdapter({
    codecs: new Map([['example.record@0.1.0', {
      decode(value) {
        if (value?.name !== 'Ada' || value?.age !== 37) {
          throw new TypeError('invalid record')
        }
        return JSON.stringify({ name: value.name, age: value.age })
      },
      encode(value) {
        const parsed = JSON.parse(value)
        if (parsed.name !== 'Ada' || parsed.age !== 37) {
          throw new TypeError('invalid record')
        }
        return {
          name: parsed.name,
          nested: { z: 1, a: 2 },
          age: parsed.age,
        }
      },
    }]]),
  })

  assert.deepEqual(invoke(adapter, 'encode', {
    schema: 'example.record@0.1.0',
    value: '{"name":"Ada","age":37}',
  }), {
    kind: 'value',
    value: {
      kind: 'ok',
      value: '{"age":37,"name":"Ada","nested":{"a":2,"z":1}}',
    },
  })
  assert.deepEqual(invoke(adapter, 'decode', {
    payload: '{"age":37,"name":"Ada"}',
    schema: 'example.record@0.1.0',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '{"name":"Ada","age":37}' },
  })
  assert.deepEqual(invoke(adapter, 'decode', {
    payload: '{not-json}',
    schema: 'example.record@0.1.0',
  }), declaredError('invalid_json'))

  const invalid = new ServerJsonCodecAdapter({
    codecs: new Map([['invalid@0.1.0', {
      decode: () => 42,
      encode: () => ({ value: 1n }),
    }]]),
  })
  assert.deepEqual(invoke(invalid, 'encode', {
    schema: 'invalid@0.1.0',
    value: 'ignored',
  }), declaredError('invalid_json'))
  assert.deepEqual(invoke(invalid, 'decode', {
    payload: '{}',
    schema: 'invalid@0.1.0',
  }), declaredError('invalid_json'))
})

test('Server JSON codec registry ignores an overridden iterator', () => {
  const codecs = new Map([
    ['legit@0.1.0', {
      decode: () => 'legit-decode',
      encode: () => ({ value: 'legit-encode' }),
    }],
  ])
  let spoofCalls = 0
  codecs[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['legit@0.1.0', {
      decode: () => 'spoof-decode',
      encode: () => ({ value: 'spoof-encode' }),
    }]
  }

  const adapter = new ServerJsonCodecAdapter({ codecs })

  assert.deepEqual(invoke(adapter, 'encode', {
    schema: 'legit@0.1.0',
    value: 'ignored',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '{"value":"legit-encode"}' },
  })
  assert.equal(spoofCalls, 0)
})

test('Server JSON codec snapshots methods and ignores method-owned bind faults', () => {
  let encodeReads = 0
  let decodeReads = 0
  let encodeCalls = 0
  let decodeCalls = 0
  const codec = {}
  const encode = function (value) {
    assert.equal(this, codec)
    assert.equal(value, 'ignored')
    encodeCalls += 1
    return { value: 'encoded' }
  }
  const decode = function (value) {
    assert.equal(this, codec)
    assert.deepEqual(value, { value: 'decoded' })
    decodeCalls += 1
    return 'decoded'
  }
  Object.defineProperty(encode, 'bind', {
    configurable: true,
    get() {
      throw new Error('private encode bind fault')
    },
  })
  Object.defineProperty(decode, 'bind', {
    configurable: true,
    get() {
      throw new Error('private decode bind fault')
    },
  })
  Object.defineProperty(codec, 'encode', {
    configurable: true,
    get() {
      encodeReads += 1
      if (encodeReads > 1) throw new Error('encode getter fault')
      return encode
    },
  })
  Object.defineProperty(codec, 'decode', {
    configurable: true,
    get() {
      decodeReads += 1
      if (decodeReads > 1) throw new Error('decode getter fault')
      return decode
    },
  })

  const adapter = new ServerJsonCodecAdapter({
    codecs: new Map([['stable@0.1.0', codec]]),
  })

  assert.deepEqual(invoke(adapter, 'encode', {
    schema: 'stable@0.1.0',
    value: 'ignored',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: '{"value":"encoded"}' },
  })
  assert.deepEqual(invoke(adapter, 'decode', {
    payload: '{"value":"decoded"}',
    schema: 'stable@0.1.0',
  }), {
    kind: 'value',
    value: { kind: 'ok', value: 'decoded' },
  })
  assert.equal(encodeReads, 1)
  assert.equal(decodeReads, 1)
  assert.equal(encodeCalls, 1)
  assert.equal(decodeCalls, 1)
})

test('Server profile accepts the shared JSON contract and rejects the old identity', () => {
  const adapter = new ServerJsonCodecAdapter({
    codecs: new Map([['example.record@0.1.0', {
      decode: () => 'record',
      encode: () => ({ ok: true }),
    }]]),
  })
  assert.equal(adapter.adapterContract(), SERVER_JSON_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_JSON_REFERENCE])
  assert.deepEqual(
    adapter.resourceCatalog(),
    serverProfileSchemaDefinitions().find(({ identity }) => identity === 'data.json')
      .resource_catalog,
  )

  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)
  assert.deepEqual(
    bound.value.invoke('@json', 'encode', {
      schema: 'example.record@0.1.0',
      value: 'record',
    }, 'json-codec-1'),
    {
      kind: 'value',
      value: { kind: 'ok', value: '{"ok":true}' },
    },
  )

  class LegacyContractAdapter extends ServerJsonCodecAdapter {
    adapterContract() {
      return 're.server-json-memory-adapter@0.1.0'
    }
  }
  assert.deepEqual(
    bindServerProfile(requiredBindings(new LegacyContractAdapter())),
    {
      diagnostics: [{
        code: 'server-profile-adapter-contract-mismatch',
        expected: SERVER_JSON_ADAPTER_CONTRACT,
        instance: '@json',
      }],
      ok: false,
    },
  )
})

function codecsFromVector(vector) {
  return new Map(vector.schemas.map((schema) => {
    const encoded = new Map(schema.encode)
    const decoded = new Map(schema.decode)
    return [schema.reference, {
      decode(value) {
        const key = stableJson(value)
        if (!decoded.has(key)) throw new TypeError('invalid JSON')
        return decoded.get(key)
      },
      encode(value) {
        if (!encoded.has(value)) throw new TypeError('invalid JSON')
        return JSON.parse(encoded.get(value))
      },
    }]
  }))
}

function invoke(adapter, member, typedArguments) {
  return adapter.invoke(
    { interface: SERVER_JSON_REFERENCE, member },
    typedArguments,
  )
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'data.json_error', variant },
      kind: 'err',
    },
  }
}

function requiredBindings(jsonAdapter) {
  return {
    clockAdapter: new ServerClockMemoryAdapter(),
    configAdapter: new ServerConfigMemoryAdapter(),
    dbSqlAdapter: new ServerDbSqlMemoryAdapter(),
    httpClientAdapter: new ServerHttpClientMemoryAdapter(),
    httpServerAdapter: new ServerHttpServerMemoryAdapter(),
    jsonAdapter,
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter(),
    secretAdapter: new ServerSecretMemoryAdapter(),
    traceAdapter: new ServerTraceMemoryAdapter(),
  }
}
