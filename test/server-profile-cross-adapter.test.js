import assert from 'node:assert/strict'
import test from 'node:test'

import { HostEnvironment } from '../src/host/host-environment.js'
import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigEnvironmentAdapter } from '../src/host/server-config-environment-adapter.js'
import { ServerDbSqlDriverAdapter } from '../src/host/server-db-sql-driver-adapter.js'
import { ServerHttpClientTransportAdapter } from '../src/host/server-http-client-transport-adapter.js'
import { ServerHttpServerSocketAdapter } from '../src/host/server-http-server-socket-adapter.js'
import { ServerJsonCodecAdapter } from '../src/host/server-json-codec-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import { ServerSecretDeploymentAdapter } from '../src/host/server-secret-deployment-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import {
  bindServerProfile,
  buildServerProfile,
  SERVER_CONFIG_ADAPTER_CONTRACT,
  SERVER_CONFIG_REFERENCE,
  SERVER_CLOCK_REFERENCE,
  SERVER_DB_SQL_REFERENCE,
  SERVER_HTTP_CLIENT_REFERENCE,
  SERVER_HTTP_SERVER_REFERENCE,
  SERVER_JSON_REFERENCE,
  SERVER_LOG_REFERENCE,
  SERVER_RANDOM_REFERENCE,
  SERVER_SECRET_REFERENCE,
  SERVER_TRACE_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'

test('mixed Server profile binds all ten capabilities and routes by instance', () => {
  const bindings = mixedBindings()
  const bound = bindServerProfile(bindings)
  assert.equal(bound.ok, true)

  assert.deepEqual(
    bound.value.invoke('@clock', 'now', {}, 'cross-clock'),
    ok(17),
  )
  assert.deepEqual(
    bound.value.invoke('@config', 'get', { key: 'APP_MODE' }, 'cross-config'),
    ok('production'),
  )
  assert.deepEqual(
    bound.value.invoke('@random', 'fill', { length: 2 }, 'cross-random'),
    ok(Uint8Array.of(1, 2)),
  )
  assert.deepEqual(
    bound.value.invoke('@secret', 'get', { name: 'api.token' }, 'cross-secret'),
    ok(Uint8Array.of(0x73, 0x65)),
  )
  assert.deepEqual(
    bound.value.invoke('@json', 'encode', {
      schema: 'example.record@0.1.0',
      value: '{"name":"Ada"}',
    }, 'cross-json'),
    ok('{"name":"Ada"}'),
  )
  assert.deepEqual(
    bound.value.invoke('@http', 'request', {
      body: new Uint8Array(),
      deadline: 1000,
      headers: '',
      method: 'GET',
      redirect_policy: 'follow',
      url: 'https://example.test/',
    }, 'cross-http'),
    ok('{"status":200}'),
  )
  assert.deepEqual(
    bound.value.invoke('@sql', 'begin', { database: 'main' }, 'cross-sql'),
    ok('tx-cross'),
  )
  assert.deepEqual(
    bound.value.invoke('@server', 'accept', { listener: 'api' }, 'cross-server'),
    ok('req-cross'),
  )
})

test('HostEnvironment routes two explicit instances of one capability independently', () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const capabilities = [
    { instance: '@clock-primary', reference: SERVER_CLOCK_REFERENCE },
    { instance: '@clock-secondary', reference: SERVER_CLOCK_REFERENCE },
  ]
  const create = (orderedCapabilities) => {
    const counts = new Map()
    const bindings = [
      {
        adapter: marked(
          new ServerClockMemoryAdapter({ instants: [11] }),
          'primary',
          counts,
        ),
        instance: '@clock-primary',
      },
      {
        adapter: marked(
          new ServerClockMemoryAdapter({ instants: [22] }),
          'secondary',
          counts,
        ),
        instance: '@clock-secondary',
      },
    ]
    return {
      counts,
      result: HostEnvironment.bind({
        bindings,
        capabilities: orderedCapabilities,
        registry,
      }),
    }
  }
  const forward = create(capabilities)
  const reverse = create([...capabilities].reverse())

  assert.equal(forward.result.ok, true)
  assert.equal(reverse.result.ok, true)
  assert.deepEqual(
    forward.result.value.invoke('@clock-primary', 'now', {}, 'multi-primary'),
    ok(11),
  )
  assert.deepEqual(
    forward.result.value.invoke('@clock-secondary', 'now', {}, 'multi-secondary'),
    ok(22),
  )
  assert.deepEqual(
    reverse.result.value.invoke('@clock-primary', 'now', {}, 'multi-primary'),
    ok(11),
  )
  assert.deepEqual(
    reverse.result.value.invoke('@clock-secondary', 'now', {}, 'multi-secondary'),
    ok(22),
  )
  assert.deepEqual([...forward.counts], [['primary', 1], ['secondary', 1]])
  assert.deepEqual([...reverse.counts], [['primary', 1], ['secondary', 1]])
  assert.deepEqual(
    forward.result.value.resourceFootprint('@clock-primary', 'now'),
    reverse.result.value.resourceFootprint('@clock-primary', 'now'),
  )
  assert.deepEqual(
    forward.result.value.resourceLineage('@clock-secondary', 'clock.monotonic'),
    reverse.result.value.resourceLineage('@clock-secondary', 'clock.monotonic'),
  )
})

test('HostEnvironment rejects duplicate capability instance declarations before dispatch', () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const counts = new Map()
  const adapter = marked(
    new ServerClockMemoryAdapter({ instants: [11] }),
    'clock',
    counts,
  )
  const result = HostEnvironment.bind({
    bindings: [{ adapter, instance: '@clock' }],
    capabilities: [
      { instance: '@clock', reference: SERVER_CLOCK_REFERENCE },
      { instance: '@clock', reference: SERVER_CLOCK_REFERENCE },
    ],
    registry,
  })

  assert.deepEqual(result, {
    diagnostics: [{
      code: 'duplicate-capability-instance',
      instance: '@clock',
      reference: SERVER_CLOCK_REFERENCE,
    }],
    ok: false,
  })
  assert.deepEqual([...counts], [])
})

test('HostEnvironment keeps multi-instance binding diagnostics stable and fail closed', () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const wrongAdapter = new ServerConfigEnvironmentAdapter({
    values: new Map([['APP_MODE', 'production']]),
  })
  const result = HostEnvironment.bind({
    bindings: [
      {
        adapter: wrongAdapter,
        instance: '@clock-mismatch',
      },
      {
        adapter: new ServerClockMemoryAdapter({ instants: [11] }),
        instance: '@clock-ok',
      },
    ],
    capabilities: [
      {
        instance: '@clock-unknown',
        reference: 'clock.monotonic@9.9.9',
      },
      {
        instance: '@clock-missing',
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        instance: '@clock-mismatch',
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        instance: '@clock-ok',
        reference: SERVER_CLOCK_REFERENCE,
      },
    ],
    registry,
  })

  assert.deepEqual(result, {
    diagnostics: [
      {
        code: 'adapter-interface-mismatch',
        instance: '@clock-mismatch',
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        code: 'missing-host-binding',
        instance: '@clock-missing',
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        code: 'missing-schema-revision',
        instance: '@clock-unknown',
        reference: 'clock.monotonic@9.9.9',
      },
    ],
    ok: false,
  })
})

test('HostEnvironment exposes an explicit async invocation boundary', async () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const counts = new Map()
  const clock = new ServerClockMemoryAdapter({ instants: [31, 32] })
  const asyncClock = Object.create(clock)
  asyncClock.invoke = async (...arguments_) => {
    counts.set('clock', (counts.get('clock') ?? 0) + 1)
    return clock.invoke(...arguments_)
  }
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: asyncClock, instance: '@clock' }],
    capabilities: [{ instance: '@clock', reference: SERVER_CLOCK_REFERENCE }],
    registry,
  })
  assert.equal(bound.ok, true)

  assert.deepEqual(
    bound.value.invoke('@clock', 'now', {}, 'sync-promise'),
    {
      fault: {
        capability_instance: '@clock',
        capability_reference: SERVER_CLOCK_REFERENCE,
        code: 'host-contract-violation',
        invocation_id: 'sync-promise',
        member: 'now',
        phase: 'invoke',
        reason: 'return-type-mismatch',
      },
      kind: 'host-fault',
    },
  )
  assert.deepEqual(
    await bound.value.invokeAsync('@clock', 'now', {}, 'async-clock'),
    ok(32),
  )
  assert.deepEqual([...counts], [['clock', 2]])
})

test('HostEnvironment keeps async completion order isolated by instance', async () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const counts = new Map()
  let resolvePrimary
  let resolveSecondary
  const primaryBase = new ServerClockMemoryAdapter()
  const secondaryBase = new ServerClockMemoryAdapter()
  const primary = Object.create(primaryBase)
  const secondary = Object.create(secondaryBase)
  primary.invoke = () => {
    counts.set('primary', (counts.get('primary') ?? 0) + 1)
    return new Promise((resolve) => {
      resolvePrimary = resolve
    })
  }
  secondary.invoke = () => {
    counts.set('secondary', (counts.get('secondary') ?? 0) + 1)
    return new Promise((resolve) => {
      resolveSecondary = resolve
    })
  }
  const bound = HostEnvironment.bind({
    bindings: [
      { adapter: primary, instance: '@clock-primary' },
      { adapter: secondary, instance: '@clock-secondary' },
    ],
    capabilities: [
      { instance: '@clock-primary', reference: SERVER_CLOCK_REFERENCE },
      { instance: '@clock-secondary', reference: SERVER_CLOCK_REFERENCE },
    ],
    registry,
  })
  assert.equal(bound.ok, true)

  const primaryResult = bound.value.invokeAsync(
    '@clock-primary',
    'now',
    {},
    'async-primary',
  )
  const secondaryResult = bound.value.invokeAsync(
    '@clock-secondary',
    'now',
    {},
    'async-secondary',
  )
  assert.deepEqual([...counts], [['primary', 1], ['secondary', 1]])
  resolveSecondary(ok(52))
  resolvePrimary(ok(51))

  assert.deepEqual(await primaryResult, ok(51))
  assert.deepEqual(await secondaryResult, ok(52))
  assert.deepEqual([...counts], [['primary', 1], ['secondary', 1]])
})

test('HostEnvironment async invocation preserves declared errors and sanitizes rejection', async () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const unavailableClock = new ServerClockMemoryAdapter()
  const asyncUnavailable = Object.create(unavailableClock)
  asyncUnavailable.invoke = async (...arguments_) => unavailableClock.invoke(...arguments_)
  const rejected = Object.create(unavailableClock)
  rejected.invoke = () => Promise.reject(new Error('private async stack'))
  const unavailableBound = HostEnvironment.bind({
    bindings: [{ adapter: asyncUnavailable, instance: '@clock' }],
    capabilities: [{ instance: '@clock', reference: SERVER_CLOCK_REFERENCE }],
    registry,
  })
  const rejectedBound = HostEnvironment.bind({
    bindings: [{ adapter: rejected, instance: '@clock' }],
    capabilities: [{ instance: '@clock', reference: SERVER_CLOCK_REFERENCE }],
    registry,
  })
  assert.equal(unavailableBound.ok, true)
  assert.equal(rejectedBound.ok, true)

  assert.deepEqual(
    await unavailableBound.value.invokeAsync('@clock', 'now', {}, 'async-error'),
    {
      kind: 'value',
      value: {
        error: { type: 'clock.monotonic_error', variant: 'unavailable' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(
    await rejectedBound.value.invokeAsync('@clock', 'now', {}, 'async-reject'),
    {
      fault: {
        capability_instance: '@clock',
        capability_reference: SERVER_CLOCK_REFERENCE,
        code: 'host-contract-violation',
        invocation_id: 'async-reject',
        member: 'now',
        phase: 'invoke',
        reason: 'adapter-panicked',
      },
      kind: 'host-fault',
    },
  )
})

test('HostEnvironment async front door rejects without calling the adapter', async () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const counts = new Map()
  const clock = new ServerClockMemoryAdapter({ instants: [41] })
  const asyncClock = Object.create(clock)
  asyncClock.invoke = async (...arguments_) => {
    counts.set('clock', (counts.get('clock') ?? 0) + 1)
    return clock.invoke(...arguments_)
  }
  const bound = HostEnvironment.bind({
    bindings: [{ adapter: asyncClock, instance: '@clock' }],
    capabilities: [{ instance: '@clock', reference: SERVER_CLOCK_REFERENCE }],
    registry,
  })
  assert.equal(bound.ok, true)

  assert.deepEqual(
    await bound.value.invokeAsync('@clock', 'missing', {}, 'async-member'),
    {
      diagnostics: [{
        code: 'unknown-capability-member',
        instance: '@clock',
        member: 'missing',
        reference: SERVER_CLOCK_REFERENCE,
      }],
      kind: 'check-failure',
    },
  )
  assert.equal(
    (
      await bound.value.invokeAsync(
        '@clock',
        'now',
        { unexpected: true },
        'async-argument',
      )
    ).kind,
    'check-failure',
  )
  assert.deepEqual([...counts], [])
})

test('mixed Server profile isolates dispatch by instance and adapter marker', () => {
  const bindings = mixedBindings()
  const counts = new Map()
  for (const key of [
    'clockAdapter',
    'configAdapter',
    'logAdapter',
    'randomAdapter',
    'secretAdapter',
    'traceAdapter',
    'jsonAdapter',
    'httpClientAdapter',
    'dbSqlAdapter',
    'httpServerAdapter',
  ]) {
    bindings[key] = marked(bindings[key], key, counts)
  }
  const bound = bindServerProfile(bindings)
  assert.equal(bound.ok, true)

  const calls = [
    ['@clock', 'now', {}, 'clockAdapter'],
    ['@config', 'get', { key: 'APP_MODE' }, 'configAdapter'],
    ['@log', 'emit', {
      attempt: 1,
      level: 'info',
      message: 'ready',
      node_uid: 'node-1',
      request_correlation: 'req-1',
      task_id: 'task-1',
    }, 'logAdapter'],
    ['@random', 'fill', { length: 2 }, 'randomAdapter'],
    ['@secret', 'get', { name: 'api.token' }, 'secretAdapter'],
    ['@trace', 'record', {
      attempt: 1,
      event: 'start',
      node_uid: 'node-1',
      parent_span_id: '',
      request_correlation: 'req-1',
      span_id: 'span-1',
      task_id: 'task-1',
    }, 'traceAdapter'],
    ['@json', 'encode', {
      schema: 'example.record@0.1.0',
      value: '{"name":"Ada"}',
    }, 'jsonAdapter'],
    ['@http', 'request', {
      body: new Uint8Array(),
      deadline: 1000,
      headers: '',
      method: 'GET',
      redirect_policy: 'follow',
      url: 'https://example.test/',
    }, 'httpClientAdapter'],
    ['@sql', 'begin', { database: 'main' }, 'dbSqlAdapter'],
    ['@server', 'accept', { listener: 'api' }, 'httpServerAdapter'],
  ]
  for (const [instance, member, args, marker] of calls) {
    const before = new Map(counts)
    const outcome = bound.value.invoke(instance, member, args, `dispatch-${marker}`)
    assert.equal(outcome.kind, 'value')
    assert.equal(counts.get(marker), (before.get(marker) ?? 0) + 1)
    for (const [other, count] of counts) {
      if (other !== marker) assert.equal(count, before.get(other) ?? 0, other)
    }
  }

  const beforeInvalid = new Map(counts)
  const invalid = bound.value.invoke('@config', 'now', {}, 'dispatch-invalid')
  assert.equal(invalid.kind, 'check-failure')
  assert.deepEqual([...counts], [...beforeInvalid])

  const beforeFootprint = new Map(counts)
  assert.equal(
    bound.value.resourceFootprint('@config', 'get', { key: 'APP_MODE' }).ok,
    true,
  )
  assert.deepEqual([...counts], [...beforeFootprint])
})

test('mixed Server profile sanitizes host faults for every capability', () => {
  const cases = [
    faultCase('clockAdapter', '@clock', 'now', {}, SERVER_CLOCK_REFERENCE,
      'adapter-panicked', () => { throw new Error('clock secret stack') }),
    faultCase('configAdapter', '@config', 'get', { key: 'APP_MODE' },
      SERVER_CONFIG_REFERENCE, 'return-type-mismatch',
      () => Promise.resolve(ok('late'))),
    faultCase('logAdapter', '@log', 'emit', {
      attempt: 1,
      level: 'info',
      message: 'ready',
      node_uid: 'node-1',
      request_correlation: 'req-1',
      task_id: 'task-1',
    }, SERVER_LOG_REFERENCE, 'undeclared-error-variant',
    () => undeclaredError('log.write_error')),
    faultCase('randomAdapter', '@random', 'fill', { length: 2 },
      SERVER_RANDOM_REFERENCE, 'return-type-mismatch', () => ok('not-bytes')),
    faultCase('secretAdapter', '@secret', 'get', { name: 'api.token' },
      SERVER_SECRET_REFERENCE, 'adapter-panicked', () => ({
        fault: { reason: 'driver leaked secret' },
        kind: 'host-fault',
      })),
    faultCase('traceAdapter', '@trace', 'record', {
      attempt: 1,
      event: 'start',
      node_uid: 'node-1',
      parent_span_id: '',
      request_correlation: 'req-1',
      span_id: 'span-1',
      task_id: 'task-1',
    }, SERVER_TRACE_REFERENCE, 'undeclared-error-variant',
    () => undeclaredError('trace.write_error')),
    faultCase('jsonAdapter', '@json', 'encode', {
      schema: 'example.record@0.1.0',
      value: '{"name":"Ada"}',
    }, SERVER_JSON_REFERENCE, 'return-type-mismatch',
    () => ok(Uint8Array.of(1))),
    faultCase('httpClientAdapter', '@http', 'request', {
      body: new Uint8Array(),
      deadline: 1000,
      headers: '',
      method: 'GET',
      redirect_policy: 'follow',
      url: 'https://example.test/',
    }, SERVER_HTTP_CLIENT_REFERENCE, 'return-type-mismatch',
    () => Promise.resolve(ok('late'))),
    faultCase('dbSqlAdapter', '@sql', 'begin', { database: 'main' },
      SERVER_DB_SQL_REFERENCE, 'return-type-mismatch', () => ok(42)),
    faultCase('httpServerAdapter', '@server', 'accept', { listener: 'api' },
      SERVER_HTTP_SERVER_REFERENCE, 'adapter-panicked',
      () => { throw new Error('socket driver details') }),
  ]

  for (const entry of cases) {
    const bindings = mixedBindings()
    const counts = new Map()
    for (const key of [
      'clockAdapter',
      'configAdapter',
      'logAdapter',
      'randomAdapter',
      'secretAdapter',
      'traceAdapter',
      'jsonAdapter',
      'httpClientAdapter',
      'dbSqlAdapter',
      'httpServerAdapter',
    ]) {
      bindings[key] = key === entry.key
        ? faulting(bindings[key], key, counts, entry.outcome)
        : marked(bindings[key], key, counts)
    }
    const bound = bindServerProfile(bindings)
    assert.equal(bound.ok, true)
    const invocationId = `fault-${entry.key}`
    assert.deepEqual(
      bound.value.invoke(
        entry.instance,
        entry.member,
        entry.arguments,
        invocationId,
      ),
      {
        fault: {
          capability_instance: entry.instance,
          capability_reference: entry.reference,
          code: 'host-contract-violation',
          invocation_id: invocationId,
          member: entry.member,
          phase: 'invoke',
          reason: entry.reason,
        },
        kind: 'host-fault',
      },
      entry.key,
    )
    assert.deepEqual([...counts], [[entry.key, 1]], entry.key)
  }
})

test('mixed Server profile rejects every capability at the front door', () => {
  for (const schema of serverProfileSchemaDefinitions()) {
    const member = firstMember(schema)
    const instance = instanceFor(schema.identity)
    const adapterKey = adapterKeyFor(schema.identity)

    for (const [kind, invalidMember, argumentsValue] of [
      ['member', `${member}.unknown`, argumentsFor(schema.members[member].params)],
      ['type', member, invalidArgumentsFor(schema.members[member].params)],
    ]) {
      const bindings = mixedBindings()
      const counts = new Map()
      for (const key of [
        'clockAdapter',
        'configAdapter',
        'logAdapter',
        'randomAdapter',
        'secretAdapter',
        'traceAdapter',
        'jsonAdapter',
        'httpClientAdapter',
        'dbSqlAdapter',
        'httpServerAdapter',
      ]) {
        bindings[key] = marked(bindings[key], key, counts)
      }
      const bound = bindServerProfile(bindings)
      assert.equal(bound.ok, true)

      const result = bound.value.invoke(
        instance,
        invalidMember,
        argumentsValue,
        `front-door-${schema.identity}-${kind}`,
      )
      assert.equal(result.kind, 'check-failure')
      assert.equal(counts.get(adapterKey) ?? 0, 0, schema.identity)
      assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 0)
      assert.equal(
        result.diagnostics.every(({ instance: actual }) => actual === instance),
        true,
      )
    }
  }
})

test('Server profile rejects unknown and drifted schema references before binding', () => {
  assert.equal(bindServerProfile(mixedBindings()).ok, true)

  for (const kind of ['identity', 'revision', 'removed']) {
    const definitions = serverProfileSchemaDefinitions()
    const config = definitions.find(({ identity }) => identity === 'config.read')
    if (kind === 'identity') config.identity = 'config.unknown'
    if (kind === 'revision') config.revision = '9.9.9'
    if (kind === 'removed') definitions.splice(definitions.indexOf(config), 1)

    const built = buildServerProfile(definitions)
    assert.deepEqual(built, {
      diagnostics: [{
        code: 'missing-schema-revision',
        reference: SERVER_CONFIG_REFERENCE,
      }],
      ok: false,
    }, kind)
    assert.deepEqual(
      bindServerProfile({ ...mixedBindings(), definitions }),
      built,
      kind,
    )
  }
})

test('HostEnvironment rejects instance alias and ambiguous adapter bindings', () => {
  const registry = SchemaRegistry.load(serverProfileSchemaDefinitions()).value
  const config = new ServerConfigEnvironmentAdapter({
    environment: { APP_MODE: 'production' },
  })
  const secondConfig = new ServerConfigEnvironmentAdapter({
    environment: { APP_MODE: 'shadow' },
  })

  assert.deepEqual(
    HostEnvironment.bind({
      bindings: [
        { adapter: config, instance: '@config' },
        { adapter: secondConfig, instance: '@config' },
      ],
      capabilities: [{
        instance: '@config',
        reference: SERVER_CONFIG_REFERENCE,
      }],
      registry,
    }),
    {
      diagnostics: [{
        code: 'ambiguous-host-binding',
        instance: '@config',
        reference: SERVER_CONFIG_REFERENCE,
      }],
      ok: false,
    },
  )

  const interfaceMismatch = HostEnvironment.bind({
    bindings: [{ adapter: config, instance: '@shared' }],
    capabilities: [
      { instance: '@shared', reference: SERVER_CONFIG_REFERENCE },
      { instance: '@shared', reference: SERVER_CLOCK_REFERENCE },
    ],
    registry,
  })
  assert.equal(interfaceMismatch.ok, false)
  assert.deepEqual(
    interfaceMismatch.diagnostics,
    [{
      code: 'adapter-interface-mismatch',
      instance: '@shared',
      reference: SERVER_CLOCK_REFERENCE,
    }],
  )

  const alias = HostEnvironment.bind({
    bindings: [
      { adapter: config, instance: '@shared' },
      {
        adapter: new ServerClockMemoryAdapter({ instants: [1] }),
        instance: '@shared',
      },
    ],
    capabilities: [
      { instance: '@shared', reference: SERVER_CONFIG_REFERENCE },
      { instance: '@shared', reference: SERVER_CLOCK_REFERENCE },
    ],
    registry,
  })
  assert.equal(alias.ok, false)
  assert.deepEqual(
    alias.diagnostics,
    [
      {
        code: 'ambiguous-host-binding',
        instance: '@shared',
        reference: SERVER_CLOCK_REFERENCE,
      },
      {
        code: 'ambiguous-host-binding',
        instance: '@shared',
        reference: SERVER_CONFIG_REFERENCE,
      },
    ],
  )
})

test('HostEnvironment sorts every cross-capability alias diagnostic deterministically', () => {
  const schemas = serverProfileSchemaDefinitions()
  const base = mixedBindings()
  for (let leftIndex = 0; leftIndex < schemas.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < schemas.length; rightIndex += 1) {
      const left = schemas[leftIndex]
      const right = schemas[rightIndex]
      const leftReference = `${left.identity}@${left.revision}`
      const rightReference = `${right.identity}@${right.revision}`
      const expected = [
        leftReference,
        rightReference,
      ].sort().map((reference) => ({
        code: 'ambiguous-host-binding',
        instance: '@shared',
        reference,
      }))
      const bindings = [
        {
          adapter: marked(
            bindingsForSchema(base, left.identity),
            leftReference,
            new Map(),
          ),
          instance: '@shared',
        },
        {
          adapter: marked(
            bindingsForSchema(base, right.identity),
            rightReference,
            new Map(),
          ),
          instance: '@shared',
        },
      ]
      const registry = SchemaRegistry.load(schemas).value
      const forward = HostEnvironment.bind({
        bindings,
        capabilities: [
          { instance: '@shared', reference: leftReference },
          { instance: '@shared', reference: rightReference },
        ],
        registry,
      })
      const reverse = HostEnvironment.bind({
        bindings,
        capabilities: [
          { instance: '@shared', reference: rightReference },
          { instance: '@shared', reference: leftReference },
        ],
        registry,
      })
      assert.deepEqual(forward, { diagnostics: expected, ok: false })
      assert.deepEqual(reverse, { diagnostics: expected, ok: false })
    }
  }
})

test('mixed Server profile exposes exact metadata and isolated resource routing', () => {
  const bindings = mixedBindings()
  const bound = bindServerProfile(bindings)
  assert.equal(bound.ok, true)
  const definitions = serverProfileSchemaDefinitions()

  for (const schema of definitions) {
    const instance = instanceFor(schema.identity)
    const adapter = bindingsForSchema(bindings, schema.identity)
    assert.deepEqual(
      adapter.supportedInterfaces(),
      [`${schema.identity}@${schema.revision}`],
    )
    assert.deepEqual(adapter.resourceCatalog(), schema.resource_catalog)
    if (schema.resource_parents !== undefined) {
      assert.deepEqual(adapter.resourceParents(), schema.resource_parents)
    }
    const member = firstMember(schema)
    const footprint = bound.value.resourceFootprint(
      instance,
      member,
      argumentsFor(schema.members[member].params),
    )
    assert.equal(footprint.ok, true)
    for (const [index, access] of schema.members[member].access.entries()) {
      const constructor = access.slice(access.indexOf(' ') + 1).replace(/\(.*/, '')
      assert.equal(
        footprint.value[index].resource.domain_digest,
        schema.resource_catalog[constructor].domain_digest,
      )
    }
  }
})

test('cross-profile binding fails closed for missing, legacy, contract and resource drift', () => {
  const missing = mixedBindings()
  delete missing.httpClientAdapter
  assert.deepEqual(bindServerProfile(missing), {
    diagnostics: [{
      code: 'missing-server-profile-adapter',
      instance: '@http',
      reference: SERVER_HTTP_CLIENT_REFERENCE,
    }],
    ok: false,
  })

  const legacy = mixedBindings()
  legacy.jsonAdapter = {
    ...legacy.jsonAdapter,
    adapterContract: () => 're.server-json-memory-adapter@0.1.0',
  }
  assert.deepEqual(bindServerProfile(legacy), {
    diagnostics: [{
      code: 'server-profile-adapter-contract-mismatch',
      expected: 're.server-json-adapter-contract@0.1.0',
      instance: '@json',
    }],
    ok: false,
  })

  const contractDrift = mixedBindings()
  contractDrift.configAdapter = Object.create(contractDrift.configAdapter)
  contractDrift.configAdapter.adapterContract = () => 're.wrong@0.1.0'
  assert.deepEqual(bindServerProfile(contractDrift), {
    diagnostics: [{
      code: 'server-profile-adapter-contract-mismatch',
      expected: SERVER_CONFIG_ADAPTER_CONTRACT,
      instance: '@config',
    }],
    ok: false,
  })

  const resourceDrift = mixedBindings()
  resourceDrift.secretAdapter = Object.create(resourceDrift.secretAdapter)
  resourceDrift.secretAdapter.resourceCatalog = () => ({})
  assert.deepEqual(bindServerProfile(resourceDrift), {
    diagnostics: [
      {
        code: 'adapter-resource-catalog-mismatch',
        constructor: 'secret.entry',
        instance: '@secret',
        reference: SERVER_SECRET_REFERENCE,
      },
      {
        code: 'adapter-resource-catalog-mismatch',
        constructor: 'secret.store',
        instance: '@secret',
        reference: SERVER_SECRET_REFERENCE,
      },
    ],
    ok: false,
  })
})

test('profile digest changes on schema drift before adapter invocation', () => {
  const first = buildServerProfile()
  const definitions = serverProfileSchemaDefinitions()
  definitions.find(({ identity }) => identity === 'clock.monotonic')
    .members.now.description = 'drifted metadata'
  const drifted = buildServerProfile(definitions)
  assert.equal(first.ok, true)
  assert.equal(drifted.ok, true)
  assert.notEqual(drifted.value.profile_digest, first.value.profile_digest)
})

function mixedBindings() {
  return {
    adapter: new ServerClockMemoryAdapter({ instants: [17] }),
    clockAdapter: new ServerClockMemoryAdapter({ instants: [17] }),
    configAdapter: new ServerConfigEnvironmentAdapter({
      environment: { APP_MODE: 'production' },
    }),
    logAdapter: new ServerLogMemoryAdapter(),
    randomAdapter: new ServerRandomMemoryAdapter({
      chunks: [Uint8Array.of(1, 2)],
    }),
    secretAdapter: new ServerSecretDeploymentAdapter({
      secrets: new Map([['api.token', Uint8Array.of(0x73, 0x65)]]),
    }),
    traceAdapter: new ServerTraceMemoryAdapter(),
    jsonAdapter: new ServerJsonCodecAdapter({
      codecs: new Map([[
        'example.record@0.1.0',
        {
          decode: () => '{"name":"Ada"}',
          encode: () => ({ name: 'Ada' }),
        },
      ]]),
    }),
    httpClientAdapter: new ServerHttpClientTransportAdapter({
      transport: () => '{"status":200}',
    }),
    dbSqlAdapter: new ServerDbSqlDriverAdapter({
      driver: { begin: () => 'tx-cross' },
    }),
    httpServerAdapter: new ServerHttpServerSocketAdapter({
      driver: { accept: () => 'req-cross' },
    }),
  }
}

function bindingsForSchema(bindings, identity) {
  return {
    'clock.monotonic': bindings.clockAdapter,
    'config.read': bindings.configAdapter,
    'log.event': bindings.logAdapter,
    'random.bytes': bindings.randomAdapter,
    'secret.read': bindings.secretAdapter,
    'trace.event': bindings.traceAdapter,
    'data.json': bindings.jsonAdapter,
    'http.client': bindings.httpClientAdapter,
    'db.sql': bindings.dbSqlAdapter,
    'http.server': bindings.httpServerAdapter,
  }[identity]
}

function adapterKeyFor(identity) {
  return {
    'clock.monotonic': 'clockAdapter',
    'config.read': 'configAdapter',
    'log.event': 'logAdapter',
    'random.bytes': 'randomAdapter',
    'secret.read': 'secretAdapter',
    'trace.event': 'traceAdapter',
    'data.json': 'jsonAdapter',
    'http.client': 'httpClientAdapter',
    'db.sql': 'dbSqlAdapter',
    'http.server': 'httpServerAdapter',
  }[identity]
}

function instanceFor(identity) {
  return {
    'clock.monotonic': '@clock',
    'config.read': '@config',
    'log.event': '@log',
    'random.bytes': '@random',
    'secret.read': '@secret',
    'trace.event': '@trace',
    'data.json': '@json',
    'http.client': '@http',
    'db.sql': '@sql',
    'http.server': '@server',
  }[identity]
}

function firstMember(schema) {
  return Object.keys(schema.members)[0]
}

function argumentsFor(parameters) {
  return Object.fromEntries(parameters.map(({ name, type }) => [
    name,
    type === 'int'
      ? 1
      : type === 'bytes'
        ? new Uint8Array()
        : name,
  ]))
}

function invalidArgumentsFor(parameters) {
  if (parameters.length === 0) return { unexpected: true }
  return {
    ...argumentsFor(parameters),
    [parameters[0].name]: parameters[0].type === 'bytes'
      ? 'wrong-bytes'
      : parameters[0].type === 'int'
        ? 'wrong-int'
        : 7,
  }
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
}

function marked(adapter, marker, counts) {
  const wrapped = Object.create(adapter)
  wrapped.invoke = (...args) => {
    counts.set(marker, (counts.get(marker) ?? 0) + 1)
    return adapter.invoke(...args)
  }
  return wrapped
}

function faulting(adapter, marker, counts, outcome) {
  const wrapped = Object.create(adapter)
  wrapped.invoke = () => {
    counts.set(marker, (counts.get(marker) ?? 0) + 1)
    return outcome()
  }
  return wrapped
}

function faultCase(key, instance, member, args, reference, reason, outcome) {
  return {
    arguments: args,
    instance,
    key,
    member,
    outcome,
    reason,
    reference,
  }
}

function undeclaredError(type) {
  return {
    kind: 'value',
    value: {
      error: { type, variant: 'driver_private_error' },
      kind: 'err',
    },
  }
}
