import { createHash } from 'node:crypto'

import { HostEnvironment } from './host-environment.js'
import { SchemaRegistry } from './schema-registry.js'

export const SERVER_PROFILE_SCHEMA = 're.server-profile@0.1.0'
export const SERVER_PROFILE_ID = 'server-minimum@0.1.0'
export const SERVER_CONFIG_REFERENCE = 'config.read@0.1.0'
export const SERVER_CONFIG_ADAPTER_CONTRACT =
  're.server-config-adapter-contract@0.1.0'
export const SERVER_CLOCK_REFERENCE = 'clock.monotonic@0.1.0'
export const SERVER_CLOCK_ADAPTER_CONTRACT =
  're.server-clock-memory-adapter@0.1.0'
export const SERVER_RANDOM_REFERENCE = 'random.bytes@0.1.0'
export const SERVER_RANDOM_ADAPTER_CONTRACT =
  're.server-random-memory-adapter@0.1.0'
export const SERVER_SECRET_REFERENCE = 'secret.read@0.1.0'
export const SERVER_SECRET_ADAPTER_CONTRACT =
  're.server-secret-adapter-contract@0.1.0'
export const SERVER_LOG_REFERENCE = 'log.event@0.1.0'
export const SERVER_LOG_ADAPTER_CONTRACT =
  're.server-log-memory-adapter@0.1.0'
export const SERVER_TRACE_REFERENCE = 'trace.event@0.1.0'
export const SERVER_TRACE_ADAPTER_CONTRACT =
  're.server-trace-memory-adapter@0.1.0'
export const SERVER_JSON_REFERENCE = 'data.json@0.1.0'
export const SERVER_JSON_ADAPTER_CONTRACT =
  're.server-json-adapter-contract@0.1.0'
export const SERVER_HTTP_CLIENT_REFERENCE = 'http.client@0.1.0'
export const SERVER_HTTP_CLIENT_ADAPTER_CONTRACT =
  're.server-http-client-adapter-contract@0.1.0'
export const SERVER_DB_SQL_REFERENCE = 'db.sql@0.1.0'
export const SERVER_DB_SQL_ADAPTER_CONTRACT =
  're.server-db-sql-adapter-contract@0.1.0'
export const SERVER_HTTP_SERVER_REFERENCE = 'http.server@0.1.0'
export const SERVER_HTTP_SERVER_ADAPTER_CONTRACT =
  're.server-http-server-adapter-contract@0.1.0'

const CONFIG_DOMAIN_DIGEST = `sha256:${'5'.repeat(64)}`
const CONFIG_KEY_TYPE_DIGEST = `sha256:${'6'.repeat(64)}`

export function serverProfileSchemaDefinitions() {
  return [{
    identity: 'config.read',
    members: {
      get: {
        access: ['read config.entry(key)'],
        params: [{ name: 'key', primary: true, type: 'text.utf8' }],
        returns: 'result<text.utf8, config.read_error>',
      },
    },
    resource_catalog: {
      'config.entry': {
        domain_digest: CONFIG_DOMAIN_DIGEST,
        segments: [{
          parameter: 'key',
          type_digest: CONFIG_KEY_TYPE_DIGEST,
        }],
      },
      'config.store': {
        domain_digest: CONFIG_DOMAIN_DIGEST,
        segments: [],
      },
    },
    resource_parents: {
      'config.entry': 'config.store',
    },
    revision: '0.1.0',
    types: {
      'config.read_error': {
        kind: 'error-sum',
        variants: ['not_found', 'unavailable'],
      },
    },
  }, {
    identity: 'clock.monotonic',
    members: {
      now: {
        access: ['read clock.monotonic'],
        params: [],
        returns: 'result<int, clock.monotonic_error>',
      },
    },
    resource_catalog: {
      'clock.monotonic': {
        domain_digest: `sha256:${'7'.repeat(64)}`,
        segments: [],
      },
    },
    revision: '0.1.0',
    types: {
      'clock.monotonic_error': {
        kind: 'error-sum',
        variants: ['unavailable'],
      },
    },
  }, {
    identity: 'random.bytes',
    members: {
      fill: {
        access: ['read random.entropy'],
        params: [{ name: 'length', primary: true, type: 'int' }],
        returns: 'result<bytes, random.bytes_error>',
      },
    },
    resource_catalog: {
      'random.entropy': {
        domain_digest: `sha256:${'8'.repeat(64)}`,
        segments: [],
      },
    },
    revision: '0.1.0',
    types: {
      'random.bytes_error': {
        kind: 'error-sum',
        variants: ['invalid_length', 'unavailable'],
      },
    },
  }, {
    identity: 'secret.read',
    members: {
      get: {
        access: ['read secret.entry(name)'],
        params: [{ name: 'name', primary: true, type: 'text.utf8' }],
        returns: 'result<bytes, secret.read_error>',
      },
    },
    resource_catalog: {
      'secret.entry': {
        domain_digest: `sha256:${'9'.repeat(64)}`,
        segments: [{
          parameter: 'name',
          type_digest: `sha256:${'a'.repeat(64)}`,
        }],
      },
      'secret.store': {
        domain_digest: `sha256:${'9'.repeat(64)}`,
        segments: [],
      },
    },
    resource_parents: {
      'secret.entry': 'secret.store',
    },
    revision: '0.1.0',
    types: {
      'secret.read_error': {
        kind: 'error-sum',
        variants: ['not_found', 'unavailable'],
      },
    },
  }, {
    identity: 'log.event',
    members: {
      emit: {
        access: ['write log.stream'],
        params: [
          { name: 'attempt', type: 'int' },
          { name: 'level', type: 'text.utf8' },
          { name: 'message', primary: true, type: 'text.utf8' },
          { name: 'node_uid', type: 'text.utf8' },
          { name: 'request_correlation', type: 'text.utf8' },
          { name: 'task_id', type: 'text.utf8' },
        ],
        returns: 'result<unit, log.write_error>',
      },
    },
    resource_catalog: {
      'log.stream': {
        domain_digest: `sha256:${'b'.repeat(64)}`,
        segments: [],
      },
    },
    revision: '0.1.0',
    types: {
      'log.write_error': {
        kind: 'error-sum',
        variants: ['unavailable'],
      },
    },
  }, {
    identity: 'trace.event',
    members: {
      record: {
        access: ['write trace.stream'],
        params: [
          { name: 'attempt', type: 'int' },
          { name: 'event', primary: true, type: 'text.utf8' },
          { name: 'node_uid', type: 'text.utf8' },
          { name: 'parent_span_id', type: 'text.utf8' },
          { name: 'request_correlation', type: 'text.utf8' },
          { name: 'span_id', type: 'text.utf8' },
          { name: 'task_id', type: 'text.utf8' },
        ],
        returns: 'result<unit, trace.write_error>',
      },
    },
    resource_catalog: {
      'trace.stream': {
        domain_digest: `sha256:${'c'.repeat(64)}`,
        segments: [],
      },
    },
    revision: '0.1.0',
    types: {
      'trace.write_error': {
        kind: 'error-sum',
        variants: ['unavailable'],
      },
    },
  }, {
    identity: 'data.json',
    members: {
      encode: {
        access: ['read data.schema(schema)', 'write data.json'],
        params: [
          { name: 'schema', primary: true, type: 'text.utf8' },
          { name: 'value', type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, data.json_error>',
      },
      decode: {
        access: ['read data.schema(schema)', 'read data.json'],
        params: [
          { name: 'schema', primary: true, type: 'text.utf8' },
          { name: 'payload', type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, data.json_error>',
      },
    },
    resource_catalog: {
      'data.schema': {
        domain_digest: `sha256:${'d'.repeat(64)}`,
        segments: [{
          parameter: 'schema',
          type_digest: `sha256:${'e'.repeat(64)}`,
        }],
      },
      'data.json': {
        domain_digest: `sha256:${'f'.repeat(64)}`,
        segments: [],
      },
    },
    revision: '0.1.0',
    types: {
      'data.json_error': {
        kind: 'error-sum',
        variants: ['invalid_json', 'invalid_schema', 'unavailable'],
      },
    },
  }, {
    identity: 'http.client',
    members: {
      request: {
        access: ['read network.http(url)'],
        params: [
          { name: 'body', type: 'bytes' },
          { name: 'deadline', type: 'int' },
          { name: 'headers', type: 'text.utf8' },
          { name: 'method', type: 'text.utf8' },
          { name: 'redirect_policy', type: 'text.utf8' },
          { name: 'url', primary: true, type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, http.client_error>',
      },
    },
    resource_catalog: {
      'network.http': {
        domain_digest: `sha256:${'a'.repeat(64)}`,
        segments: [{
          parameter: 'url',
          type_digest: `sha256:${'b'.repeat(64)}`,
        }],
      },
    },
    revision: '0.1.0',
    types: {
      'http.client_error': {
        kind: 'error-sum',
        variants: [
          'deadline_exceeded',
          'invalid_request',
          'redirect_rejected',
          'unavailable',
        ],
      },
    },
  }, {
    identity: 'db.sql',
    members: {
      begin: {
        access: ['write db.database(database)'],
        params: [
          { name: 'database', primary: true, type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, db.sql_error>',
      },
      commit: {
        access: ['write db.database(database)'],
        params: [
          { name: 'database', primary: true, type: 'text.utf8' },
          { name: 'transaction', type: 'text.utf8' },
        ],
        returns: 'result<unit, db.sql_error>',
      },
      execute: {
        access: ['write db.database(database)'],
        params: [
          { name: 'bound_parameters', type: 'bytes' },
          { name: 'database', primary: true, type: 'text.utf8' },
          { name: 'statement', type: 'text.utf8' },
          { name: 'transaction', type: 'text.utf8' },
        ],
        returns: 'result<int, db.sql_error>',
      },
      query: {
        access: ['read db.database(database)'],
        params: [
          { name: 'bound_parameters', type: 'bytes' },
          { name: 'database', primary: true, type: 'text.utf8' },
          { name: 'statement', type: 'text.utf8' },
          { name: 'transaction', type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, db.sql_error>',
      },
      rollback: {
        access: ['write db.database(database)'],
        params: [
          { name: 'database', primary: true, type: 'text.utf8' },
          { name: 'transaction', type: 'text.utf8' },
        ],
        returns: 'result<unit, db.sql_error>',
      },
    },
    resource_catalog: {
      'db.database': {
        domain_digest: `sha256:${'c'.repeat(64)}`,
        segments: [{
          parameter: 'database',
          type_digest: `sha256:${'d'.repeat(64)}`,
        }],
      },
    },
    revision: '0.1.0',
    types: {
      'db.sql_error': {
        kind: 'error-sum',
        variants: [
          'conflict',
          'invalid_statement',
          'invalid_transaction',
          'unavailable',
        ],
      },
    },
  }, {
    identity: 'http.server',
    members: {
      accept: {
        access: ['read network.listener(listener)'],
        cancellation: 'cooperative',
        params: [{ name: 'listener', primary: true, type: 'text.utf8' }],
        returns: 'result<text.utf8, http.server_error>',
      },
      body: {
        access: ['read network.request(request)'],
        cancellation: 'cooperative',
        params: [
          { name: 'limit', type: 'int' },
          { name: 'request', primary: true, type: 'text.utf8' },
        ],
        returns: 'result<bytes, http.server_error>',
      },
      cancel: {
        access: ['write network.request(request)'],
        params: [{ name: 'request', primary: true, type: 'text.utf8' }],
        returns: 'result<unit, http.server_error>',
      },
      headers: requestTextMember(),
      method: requestTextMember(),
      path: requestTextMember(),
      respond: {
        access: ['write network.request(request)'],
        params: [
          { name: 'body', type: 'bytes' },
          { name: 'headers', type: 'text.utf8' },
          { name: 'request', primary: true, type: 'text.utf8' },
          { name: 'status', type: 'int' },
        ],
        returns: 'result<unit, http.server_error>',
      },
      respond_chunk: {
        access: ['write network.request(request)'],
        params: [
          { name: 'body', type: 'bytes' },
          { name: 'request', primary: true, type: 'text.utf8' },
        ],
        returns: 'result<text.utf8, http.server_error>',
      },
      respond_drain: {
        access: ['write network.request(request)'],
        cancellation: 'cooperative',
        params: [{ name: 'request', primary: true, type: 'text.utf8' }],
        returns: 'result<unit, http.server_error>',
      },
      respond_end: {
        access: ['write network.request(request)'],
        params: [{ name: 'request', primary: true, type: 'text.utf8' }],
        returns: 'result<unit, http.server_error>',
      },
      respond_start: {
        access: ['write network.request(request)'],
        params: [
          { name: 'headers', type: 'text.utf8' },
          { name: 'request', primary: true, type: 'text.utf8' },
          { name: 'status', type: 'int' },
        ],
        returns: 'result<unit, http.server_error>',
      },
      route_params: requestTextMember(),
    },
    resource_catalog: {
      'network.listener': {
        domain_digest: `sha256:${'e'.repeat(64)}`,
        segments: [{
          parameter: 'listener',
          type_digest: `sha256:${'f'.repeat(64)}`,
        }],
      },
      'network.request': {
        domain_digest: `sha256:${'1'.repeat(64)}`,
        segments: [{
          parameter: 'request',
          type_digest: `sha256:${'2'.repeat(64)}`,
        }],
      },
    },
    revision: '0.1.0',
    types: {
      'http.server_error': {
        kind: 'error-sum',
        variants: [
          'body_too_large',
          'cancelled',
          'invalid_request',
          'unavailable',
        ],
      },
    },
  }]
}

export function buildServerProfile(
  definitions = serverProfileSchemaDefinitions(),
) {
  const loaded = SchemaRegistry.load(definitions)
  if (!loaded.ok) return loaded
  const capabilities = [
    [SERVER_CLOCK_REFERENCE, SERVER_CLOCK_ADAPTER_CONTRACT],
    [SERVER_CONFIG_REFERENCE, SERVER_CONFIG_ADAPTER_CONTRACT],
    [SERVER_LOG_REFERENCE, SERVER_LOG_ADAPTER_CONTRACT],
    [SERVER_RANDOM_REFERENCE, SERVER_RANDOM_ADAPTER_CONTRACT],
    [SERVER_SECRET_REFERENCE, SERVER_SECRET_ADAPTER_CONTRACT],
    [SERVER_TRACE_REFERENCE, SERVER_TRACE_ADAPTER_CONTRACT],
    [SERVER_JSON_REFERENCE, SERVER_JSON_ADAPTER_CONTRACT],
    [SERVER_HTTP_CLIENT_REFERENCE, SERVER_HTTP_CLIENT_ADAPTER_CONTRACT],
    [SERVER_DB_SQL_REFERENCE, SERVER_DB_SQL_ADAPTER_CONTRACT],
    [SERVER_HTTP_SERVER_REFERENCE, SERVER_HTTP_SERVER_ADAPTER_CONTRACT],
  ].map(([reference, adapterContract]) => {
    const digest = loaded.value.contentDigest(reference)
    return digest.ok
      ? {
          adapter_contract: adapterContract,
          content_digest: digest.value,
          reference,
        }
      : { error: digest.error }
  })
  const failed = capabilities.find(({ error }) => error !== undefined)
  if (failed !== undefined) return { diagnostics: [failed.error], ok: false }
  const identity = {
    capabilities,
    id: SERVER_PROFILE_ID,
    schema: SERVER_PROFILE_SCHEMA,
  }
  return {
    ok: true,
    value: {
      ...identity,
      profile_digest: sha256(canonicalJson(identity)),
    },
  }
}

export function bindServerProfile({
  adapter,
  clockAdapter,
  configAdapter = adapter,
  definitions = serverProfileSchemaDefinitions(),
  logAdapter,
  randomAdapter,
  secretAdapter,
  traceAdapter,
  jsonAdapter,
  httpClientAdapter,
  dbSqlAdapter,
  httpServerAdapter,
} = {}) {
  const profile = buildServerProfile(definitions)
  if (!profile.ok) return profile
  const bindings = [
    {
      adapter: clockAdapter,
      contract: SERVER_CLOCK_ADAPTER_CONTRACT,
      instance: '@clock',
      reference: SERVER_CLOCK_REFERENCE,
    },
    {
      adapter: configAdapter,
      contract: SERVER_CONFIG_ADAPTER_CONTRACT,
      instance: '@config',
      reference: SERVER_CONFIG_REFERENCE,
    },
    {
      adapter: logAdapter,
      contract: SERVER_LOG_ADAPTER_CONTRACT,
      instance: '@log',
      reference: SERVER_LOG_REFERENCE,
    },
    {
      adapter: randomAdapter,
      contract: SERVER_RANDOM_ADAPTER_CONTRACT,
      instance: '@random',
      reference: SERVER_RANDOM_REFERENCE,
    },
    {
      adapter: secretAdapter,
      contract: SERVER_SECRET_ADAPTER_CONTRACT,
      instance: '@secret',
      reference: SERVER_SECRET_REFERENCE,
    },
    {
      adapter: traceAdapter,
      contract: SERVER_TRACE_ADAPTER_CONTRACT,
      instance: '@trace',
      reference: SERVER_TRACE_REFERENCE,
    },
    {
      adapter: jsonAdapter,
      contract: SERVER_JSON_ADAPTER_CONTRACT,
      instance: '@json',
      reference: SERVER_JSON_REFERENCE,
    },
    {
      adapter: httpClientAdapter,
      contract: SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
      instance: '@http',
      reference: SERVER_HTTP_CLIENT_REFERENCE,
    },
    {
      adapter: dbSqlAdapter,
      contract: SERVER_DB_SQL_ADAPTER_CONTRACT,
      instance: '@sql',
      reference: SERVER_DB_SQL_REFERENCE,
    },
    {
      adapter: httpServerAdapter,
      contract: SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
      instance: '@server',
      reference: SERVER_HTTP_SERVER_REFERENCE,
    },
  ]
  const diagnostics = []
  for (const binding of bindings) {
    if (binding.adapter === undefined) {
      diagnostics.push({
        code: 'missing-server-profile-adapter',
        instance: binding.instance,
        reference: binding.reference,
      })
    } else if (
      typeof binding.adapter.adapterContract !== 'function'
      || binding.adapter.adapterContract() !== binding.contract
    ) {
      diagnostics.push({
        code: 'server-profile-adapter-contract-mismatch',
        expected: binding.contract,
        instance: binding.instance,
      })
    }
  }
  if (diagnostics.length > 0) return { diagnostics, ok: false }
  const registry = SchemaRegistry.load(definitions)
  if (!registry.ok) return registry
  return HostEnvironment.bind({
    bindings: bindings.map(({ adapter, instance }) => ({ adapter, instance })),
    capabilities: bindings.map(({ instance, reference }) => ({
      instance,
      reference,
    })),
    registry: registry.value,
  })
}

function requestTextMember() {
  return {
    access: ['read network.request(request)'],
    params: [{ name: 'request', primary: true, type: 'text.utf8' }],
    returns: 'result<text.utf8, http.server_error>',
  }
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
