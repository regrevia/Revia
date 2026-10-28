import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ServerClockMemoryAdapter } from '../src/host/server-clock-memory-adapter.js'
import { ServerConfigMemoryAdapter } from '../src/host/server-config-memory-adapter.js'
import { ServerDbSqlMemoryAdapter } from '../src/host/server-db-sql-memory-adapter.js'
import { ServerHttpClientMemoryAdapter } from '../src/host/server-http-client-memory-adapter.js'
import { ServerHttpServerMemoryAdapter } from '../src/host/server-http-server-memory-adapter.js'
import { ServerJsonMemoryAdapter } from '../src/host/server-json-memory-adapter.js'
import { ServerLogMemoryAdapter } from '../src/host/server-log-memory-adapter.js'
import { ServerRandomMemoryAdapter } from '../src/host/server-random-memory-adapter.js'
import {
  ServerSecretMacosKeychainAdapter,
} from '../src/host/server-secret-macos-keychain-adapter.js'
import { ServerTraceMemoryAdapter } from '../src/host/server-trace-memory-adapter.js'
import {
  bindServerProfile,
  SERVER_SECRET_ADAPTER_CONTRACT,
  SERVER_SECRET_REFERENCE,
  serverProfileSchemaDefinitions,
} from '../src/host/server-profile.js'

const SECURITY_PATH = '/usr/bin/security'
const HAS_REAL_MACOS_KEYCHAIN = hasRealMacosKeychain()

test('macOS Keychain adapter reads explicit accounts through the Server profile', {
  skip: !HAS_REAL_MACOS_KEYCHAIN,
}, (t) => {
  const fixture = createTemporaryKeychainIfAvailable(t)
  if (fixture === null) {
    t.skip('host cannot create and unlock an isolated macOS Keychain fixture')
    return
  }
  addGenericPassword(fixture, {
    account: 'primary-agent',
    secret: 'primary-value\n',
    service: 're.wp39',
  })
  addGenericPassword(fixture, {
    account: 'secondary-agent',
    secret: 'deadbeef',
    service: 're.wp39',
  })
  addGenericPassword(fixture, {
    account: 'unicode-agent',
    secret: '密钥',
    service: 're.wp39',
  })
  const adapter = new ServerSecretMacosKeychainAdapter({
    entries: new Map([
      ['api.primary', {
        account: 'primary-agent',
        keychain: fixture.keychain,
        service: 're.wp39',
      }],
      ['api.secondary', {
        account: 'secondary-agent',
        keychain: fixture.keychain,
        service: 're.wp39',
      }],
      ['api.unicode', {
        account: 'unicode-agent',
        keychain: fixture.keychain,
        service: 're.wp39',
      }],
      ['api.missing', {
        account: 'missing-agent',
        keychain: fixture.keychain,
        service: 're.wp39',
      }],
    ]),
  })
  const bound = bindServerProfile(requiredBindings(adapter))
  assert.equal(bound.ok, true)

  const first = bound.value.invoke(
    '@secret',
    'get',
    { name: 'api.primary' },
    'keychain-primary',
  )
  assert.deepEqual(first, okBytes('primary-value\n'))
  first.value.value[0] = 0x00
  assert.deepEqual(bound.value.invoke(
    '@secret',
    'get',
    { name: 'api.primary' },
    'keychain-primary-again',
  ), okBytes('primary-value\n'))
  assert.deepEqual(bound.value.invoke(
    '@secret',
    'get',
    { name: 'api.secondary' },
    'keychain-secondary',
  ), okBytes('deadbeef'))
  assert.deepEqual(bound.value.invoke(
    '@secret',
    'get',
    { name: 'api.unicode' },
    'keychain-unicode',
  ), okBytes('密钥'))
  assert.deepEqual(bound.value.invoke(
    '@secret',
    'get',
    { name: 'api.missing' },
    'keychain-missing-item',
  ), declaredError('not_found'))
  assert.deepEqual(bound.value.invoke(
    '@secret',
    'get',
    { name: 'unknown' },
    'keychain-unknown-name',
  ), declaredError('not_found'))
})

test('macOS Keychain adapter snapshots targets and never invokes a shell', () => {
  const calls = []
  const entries = new Map([['api.token', {
    account: '--account; echo no',
    keychain: '/tmp/keychain; echo no',
    service: 'service; echo no',
  }]])
  const adapter = new ServerSecretMacosKeychainAdapter({
    entries,
    securityPath: '/custom/security',
    statSyncImpl: stableKeychainStat,
    spawnSyncImpl(command, arguments_, options) {
      calls.push({ arguments_, command, options })
      return {
        status: 0,
        stderr: Buffer.from('password: "snapshot-secret"\n'),
        stdout: Buffer.from('keychain metadata must not leak'),
      }
    },
  })
  entries.get('api.token').service = 'mutated'
  entries.set('later', {
    account: 'later',
    keychain: '/tmp/later',
    service: 'later',
  })

  assert.deepEqual(invoke(adapter, 'api.token'), okBytes('snapshot-secret'))
  assert.deepEqual(invoke(adapter, 'later'), declaredError('not_found'))
  assert.deepEqual(calls, [{
    arguments_: [
      'find-generic-password',
      '-a',
      '--account; echo no',
      '-s',
      'service; echo no',
      '-g',
      '/tmp/keychain; echo no',
    ],
    command: '/custom/security',
    options: {
      encoding: null,
      env: { LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  }])
})

test('macOS Keychain adapter ignores overridden registry iteration', () => {
  let spoofCalls = 0
  const calls = []
  const entries = new Map([['api.token', {
    account: 'legit-account',
    keychain: '/tmp/legit-keychain',
    service: 'legit-service',
  }]])
  entries[Symbol.iterator] = function* () {
    spoofCalls += 1
    yield ['api.token', {
      account: 'spoof-account',
      keychain: '/tmp/spoof-keychain',
      service: 'spoof-service',
    }]
  }
  const adapter = new ServerSecretMacosKeychainAdapter({
    entries,
    statSyncImpl: stableKeychainStat,
    spawnSyncImpl(command, arguments_) {
      calls.push({ arguments_, command })
      return {
        status: 0,
        stderr: Buffer.from('password: "snapshot-secret"\n'),
        stdout: Buffer.alloc(0),
      }
    },
  })

  assert.deepEqual(invoke(adapter, 'api.token'), okBytes('snapshot-secret'))
  assert.equal(spoofCalls, 0)
  assert.deepEqual(calls, [{
    arguments_: [
      'find-generic-password',
      '-a',
      'legit-account',
      '-s',
      'legit-service',
      '-g',
      '/tmp/legit-keychain',
    ],
    command: '/usr/bin/security',
  }])
})

test('macOS Keychain adapter closes command and output failures', () => {
  const target = new Map([['api.token', {
    account: 'agent',
    keychain: '/tmp/keychain',
    service: 'service',
  }]])
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 44,
    stderr: Buffer.from('not found'),
    stdout: Buffer.alloc(0),
  }), 'api.token'), declaredError('not_found'))
  assert.deepEqual(invoke(new ServerSecretMacosKeychainAdapter({
    entries: target,
    spawnSyncImpl: () => ({
      status: 44,
      stderr: Buffer.from('not found'),
      stdout: Buffer.alloc(0),
    }),
    statSyncImpl() {
      throw new Error('keychain missing')
    },
  }), 'api.token'), declaredError('unavailable'))
  let statCall = 0
  assert.deepEqual(invoke(new ServerSecretMacosKeychainAdapter({
    entries: target,
    spawnSyncImpl: () => ({
      status: 44,
      stderr: Buffer.from('not found'),
      stdout: Buffer.alloc(0),
    }),
    statSyncImpl() {
      statCall += 1
      return {
        dev: 1,
        ino: statCall,
        isFile: () => true,
      }
    },
  }), 'api.token'), declaredError('unavailable'))
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 1,
    stderr: Buffer.from('secret command detail'),
    stdout: Buffer.from('secret partial output'),
  }), 'api.token'), declaredError('unavailable'))
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 0,
    stderr: Buffer.from('password: ambiguous\n'),
    stdout: Buffer.alloc(0),
  }), 'api.token'), declaredError('unavailable'))
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 0,
    stderr: Buffer.from('password: 0xFF\n'),
    stdout: Buffer.alloc(0),
  }), 'api.token'), declaredError('unavailable'))
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 0,
    stderr: Buffer.from(
      'password: "first"\npassword: "second"\n',
    ),
    stdout: Buffer.alloc(0),
  }), 'api.token'), declaredError('unavailable'))
  const proxyStderr = new Proxy(
    Uint8Array.from(Buffer.from('password: "legitimate"\n')),
    {
      get(target_, name, receiver) {
        if (name === Symbol.iterator) {
          return function* spoofBytes() {
            yield* Buffer.from('password: "spoof"\n')
          }
        }
        return Reflect.get(target_, name, receiver)
      },
    },
  )
  assert.deepEqual(invoke(adapterWithResult(target, {
    status: 0,
    stderr: proxyStderr,
    stdout: Buffer.alloc(0),
  }), 'api.token'), declaredError('unavailable'))
  assert.deepEqual(invoke(new ServerSecretMacosKeychainAdapter({
    entries: target,
    spawnSyncImpl() {
      throw new Error('secret stack detail')
    },
  }), 'api.token'), declaredError('unavailable'))
})

test('macOS Keychain adapter validates explicit metadata and shared contract', () => {
  assert.throws(
    () => new ServerSecretMacosKeychainAdapter({ entries: {} }),
    /entries must be a Map/,
  )
  for (const entry of [
    { account: '', keychain: '/tmp/keychain', service: 'service' },
    { account: 'agent', keychain: '', service: 'service' },
    { account: 'agent', keychain: '/tmp/keychain', service: '' },
    { account: 'agent\u0000', keychain: '/tmp/keychain', service: 'service' },
  ]) {
    assert.throws(
      () => new ServerSecretMacosKeychainAdapter({
        entries: new Map([['api.token', entry]]),
      }),
      /text account, service, and keychain/,
    )
  }
  assert.throws(
    () => new ServerSecretMacosKeychainAdapter({ securityPath: 'security' }),
    /absolute security executable/,
  )

  const adapter = new ServerSecretMacosKeychainAdapter()
  assert.equal(adapter.adapterContract(), SERVER_SECRET_ADAPTER_CONTRACT)
  assert.deepEqual(adapter.supportedInterfaces(), [SERVER_SECRET_REFERENCE])
  const schema = serverProfileSchemaDefinitions()
    .find(({ identity }) => identity === 'secret.read')
  assert.deepEqual(adapter.resourceCatalog(), schema.resource_catalog)
  assert.deepEqual(adapter.resourceParents(), schema.resource_parents)
})

test('macOS Keychain fixture reports an unavailable host without failing conformance', (t) => {
  const calls = []
  const fixture = createTemporaryKeychainIfAvailable(t, {
    spawnSyncImpl(command, arguments_) {
      calls.push({ arguments_, command })
      return {
        status: 50,
        stderr: Buffer.from('host keychain unavailable'),
        stdout: Buffer.alloc(0),
      }
    },
  })

  assert.equal(fixture, null)
  assert.deepEqual(calls.map(({ arguments_ }) => arguments_[0]), [
    'create-keychain',
  ])
})

test('macOS Keychain fixture sanitizes bootstrap spawn faults as unavailable', (t) => {
  assert.equal(createTemporaryKeychainIfAvailable(t, {
    spawnSyncImpl() {
      throw new Error('host process detail')
    },
  }), null)
})

test('macOS Keychain fixture cleans a keychain whose unlock is unavailable', (t) => {
  const calls = []
  const statuses = [0, 50, 0]
  assert.equal(createTemporaryKeychainIfAvailable(t, {
    spawnSyncImpl(command, arguments_) {
      calls.push({ arguments_, command })
      return {
        status: statuses.shift(),
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      }
    },
  }), null)
  assert.deepEqual(calls.map(({ arguments_ }) => arguments_[0]), [
    'create-keychain',
    'unlock-keychain',
    'delete-keychain',
  ])
})

test('macOS Keychain fixture keeps post-bootstrap command regressions visible', (t) => {
  const calls = []
  const fixture = createTemporaryKeychainIfAvailable(t, {
    spawnSyncImpl(command, arguments_) {
      calls.push({ arguments_, command })
      return {
        status: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      }
    },
  })

  assert.ok(fixture)
  assert.deepEqual(calls.map(({ arguments_ }) => arguments_[0]), [
    'create-keychain',
    'unlock-keychain',
  ])
  assert.throws(
    () => addGenericPassword(fixture, {
      account: 'agent',
      secret: 'secret',
      service: 'service',
    }, {
      spawnSyncImpl: () => ({
        status: 51,
        stderr: Buffer.from('regression'),
        stdout: Buffer.alloc(0),
      }),
    }),
    /security command failed/u,
  )
})

function createTemporaryKeychainIfAvailable(t, {
  spawnSyncImpl = spawnSync,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 're-wp39-'))
  const keychain = join(directory, 'fixture.keychain-db')
  const password = randomUUID()
  if (!securitySucceeded([
    'create-keychain',
    '-p',
    password,
    keychain,
  ], spawnSyncImpl)) {
    rmSync(directory, { force: true, recursive: true })
    return null
  }
  if (!securitySucceeded([
    'unlock-keychain',
    '-p',
    password,
    keychain,
  ], spawnSyncImpl)) {
    spawnSyncImpl(SECURITY_PATH, ['delete-keychain', keychain], {
      encoding: null,
      shell: false,
    })
    rmSync(directory, { force: true, recursive: true })
    return null
  }
  t.after(() => {
    spawnSyncImpl(SECURITY_PATH, ['delete-keychain', keychain], {
      encoding: null,
      shell: false,
    })
    rmSync(directory, { force: true, recursive: true })
  })
  return { keychain }
}

function hasRealMacosKeychain() {
  if (process.platform !== 'darwin') return false
  try {
    accessSync(SECURITY_PATH, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function addGenericPassword(
  { keychain },
  { account, secret, service },
  { spawnSyncImpl = spawnSync } = {},
) {
  assertSecurity([
    'add-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
    secret,
    keychain,
  ], spawnSyncImpl)
}

function assertSecurity(arguments_, spawnSyncImpl = spawnSync) {
  if (!securitySucceeded(arguments_, spawnSyncImpl)) {
    throw new Error('security command failed')
  }
}

function securitySucceeded(arguments_, spawnSyncImpl) {
  try {
    const result = spawnSyncImpl(SECURITY_PATH, arguments_, {
      encoding: null,
      shell: false,
    })
    return result?.status === 0
  } catch {
    return false
  }
}

function adapterWithResult(entries, result) {
  return new ServerSecretMacosKeychainAdapter({
    entries,
    spawnSyncImpl: () => result,
    statSyncImpl: stableKeychainStat,
  })
}

function stableKeychainStat() {
  return {
    dev: 1,
    ino: 2,
    isFile: () => true,
  }
}

function invoke(adapter, name) {
  return adapter.invoke(
    { interface: SERVER_SECRET_REFERENCE, member: 'get' },
    { name },
  )
}

function okBytes(text) {
  return {
    kind: 'value',
    value: {
      kind: 'ok',
      value: new TextEncoder().encode(text),
    },
  }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'secret.read_error', variant },
      kind: 'err',
    },
  }
}

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
