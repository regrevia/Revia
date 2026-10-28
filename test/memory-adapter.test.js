import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryAdapter } from '../src/host/memory-adapter.js'

test('ARGS-001 returns an empty list for empty program arguments', () => {
  const adapter = new MemoryAdapter()

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.args@0.1.0', member: 'read' },
      {},
      'invoke-args-1',
    ),
    { kind: 'value', value: { kind: 'ok', value: [] } },
  )
})

test('ARGS-002 exposes only the configured UTF-8 program arguments', () => {
  const adapter = new MemoryAdapter({ argv: ['alpha', 'β'] })

  assert.deepEqual(adapter.supportedInterfaces(), [
    'fs.read@0.1.0',
    'fs.write@0.1.0',
    'process.args@0.1.0',
    'process.stdout@0.1.0',
  ])
  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.args@0.1.0', member: 'read' },
      {},
      'invoke-1',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: ['alpha', 'β'] },
    },
  )
  assert.throws(
    () => new MemoryAdapter({
      argv: [new Proxy(Uint8Array.from([0x41]), {})],
    }),
    TypeError,
  )
})

test('ARGS-003 maps a non-UTF-8 argv byte sequence to a declared error', () => {
  const adapter = new MemoryAdapter({ argv: [Uint8Array.from([0xc3, 0x28])] })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.args@0.1.0', member: 'read' },
      {},
      'invoke-args-3',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'process.args_error', variant: 'invalid_utf8' },
        kind: 'err',
      },
    },
  )
})

test('ARGS-004 snapshots argv indexes and bytes without using the input iterator', () => {
  const original = Uint8Array.from(Buffer.from('β'))
  const argv = new Proxy([original], {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofArguments() {
          yield 'spoofed'
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  const adapter = new MemoryAdapter({ argv })
  argv[0] = 'replaced'
  original[0] = 0x41

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.args@0.1.0', member: 'read' },
      {},
      'invoke-args-4',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: ['β'] },
    },
  )
})

test('READ-001 returns exact UTF-8 text from the memory sandbox', () => {
  const files = new Map([
    ['input.txt', { bytes: Buffer.from('你好\n'), readable: true, writable: true }],
  ])
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'input.txt' },
      'invoke-read-1',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: '你好\n' },
    },
  )
})

test('READ-002 maps a missing file to the declared program error', () => {
  const adapter = new MemoryAdapter()

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'missing.txt' },
      'invoke-read-2',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'not_found' },
        kind: 'err',
      },
    },
  )
})

test('READ-003 maps denied read permission to the declared program error', () => {
  const files = new Map([
    ['secret.txt', { bytes: Buffer.from('secret'), readable: false, writable: true }],
  ])
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'secret.txt' },
      'invoke-read-3',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'permission_denied' },
        kind: 'err',
      },
    },
  )
})

test('READ-004 rejects paths that resolve outside the memory sandbox', () => {
  const adapter = new MemoryAdapter()

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: '../outside.txt' },
      'invoke-read-4',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
  )
})

test('READ-005 maps invalid UTF-8 bytes to the declared program error', () => {
  const files = new Map([
    [
      'invalid.txt',
      { bytes: Uint8Array.from([0xc3, 0x28]), readable: true, writable: true },
    ],
  ])
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'invalid.txt' },
      'invoke-read-5',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'invalid_utf8' },
        kind: 'err',
      },
    },
  )
})

test('WRITE-001 writes exact bytes and returns ok(unit)', () => {
  const files = new Map()
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x41, 0x00, 0x42]), path: 'out.txt' },
      'invoke-write-1',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(files.get('out.txt'), {
    bytes: Uint8Array.from([0x41, 0x00, 0x42]),
    readable: true,
    writable: true,
  })
})

test('WRITE-002 preserves content when write permission is denied', () => {
  const original = Uint8Array.from([0x41])
  const files = new Map([
    ['out.txt', { bytes: original, readable: true, writable: false }],
  ])
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'out.txt' },
      'invoke-write-2',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'permission_denied' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(files.get('out.txt').bytes, original)
})

test('WRITE-003 rejects paths that resolve outside the memory sandbox', () => {
  const files = new Map()
  const adapter = new MemoryAdapter({ files })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: '../out.txt' },
      'invoke-write-3',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
  )
  assert.equal(files.size, 0)
})

test('WRITE-004 rejects proxy bytes before mutating the memory sandbox', () => {
  const files = new Map()
  const adapter = new MemoryAdapter({ files })
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

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: proxyBytes, path: 'out.txt' },
      'invoke-write-4',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'io' },
        kind: 'err',
      },
    },
  )
  assert.equal(files.size, 0)
})

test('WRITE-005 snapshots genuine bytes before storing the file record', () => {
  const files = new Map()
  const adapter = new MemoryAdapter({ files })
  const data = new Uint8Array([0x11, 0x22])
  Object.defineProperty(data, 'length', { value: 0 })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data, path: 'out.txt' },
      'invoke-write-5',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  data[0] = 0x99
  assert.deepEqual(files.get('out.txt').bytes, Uint8Array.of(0x11, 0x22))
})

test('memory adapter snapshots injected files before later map or byte mutation', () => {
  const original = Uint8Array.of(0x41)
  const files = new Map([
    ['input.txt', { bytes: original, readable: true, writable: true }],
  ])
  const adapter = new MemoryAdapter({ files })
  files.set('input.txt', {
    bytes: Uint8Array.of(0x42),
    readable: true,
    writable: true,
  })
  original[0] = 0x43
  files.get = () => ({
    bytes: Uint8Array.of(0x44),
    readable: true,
    writable: true,
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'input.txt' },
      'invoke-read-snapshot',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: 'A' },
    },
  )
})

test('memory adapter rejects proxy file bytes during construction', () => {
  const proxyBytes = new Proxy(Uint8Array.of(0x11), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })

  assert.throws(() => new MemoryAdapter({
    files: new Map([
      ['input.txt', { bytes: proxyBytes, readable: true, writable: true }],
    ]),
  }), {
    name: 'TypeError',
    message: 'files must map paths to file records',
  })
})

test('STDOUT-001 appends exact text without adding a newline', () => {
  const stdout = []
  const adapter = new MemoryAdapter({ stdout })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.stdout@0.1.0', member: 'write' },
      { data: 'ready\n' },
      'invoke-stdout-1',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(stdout, ['ready\n'])
})

test('STDOUT-002 accepts empty text without changing the buffer', () => {
  const stdout = []
  const adapter = new MemoryAdapter({ stdout })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.stdout@0.1.0', member: 'write' },
      { data: '' },
      'invoke-stdout-2',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(stdout, [])
})

test('STDOUT-003 maps broken pipe without appending output', () => {
  const stdout = []
  const adapter = new MemoryAdapter({ stdout, stdoutBroken: true })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'process.stdout@0.1.0', member: 'write' },
      { data: 'partial' },
      'invoke-stdout-3',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'io.write_error', variant: 'broken_pipe' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(stdout, [])
})
