import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileSandboxAdapter } from '../src/host/file-sandbox-adapter.js'

test('file sandbox READ-001 returns exact UTF-8 text', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  writeFileSync(join(root, 'input.txt'), Buffer.from('你好\n'))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'input.txt' },
      'file-read-1',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: '你好\n' },
    },
  )
})

test('file sandbox READ-002 maps a missing file to the declared error', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'missing.txt' },
      'file-read-2',
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

test('file sandbox READ-003 maps denied permission to the declared error', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const path = join(root, 'secret.txt')
  writeFileSync(path, Buffer.from('secret'))
  chmodSync(path, 0o000)
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'secret.txt' },
      'file-read-3',
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

test('file sandbox READ-004 rejects a path outside its root', (context) => {
  const parent = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  mkdirSync(root)
  writeFileSync(join(parent, 'outside.txt'), Buffer.from('secret'))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: '../outside.txt' },
      'file-read-4',
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

test('file sandbox rejects a symlink that escapes its root', (context) => {
  const parent = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  mkdirSync(root)
  writeFileSync(join(parent, 'outside.txt'), Buffer.from('secret'))
  symlinkSync(join(parent, 'outside.txt'), join(root, 'link.txt'))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'link.txt' },
      'file-read-symlink',
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

test('file sandbox READ-005 maps invalid UTF-8 to the declared error', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  writeFileSync(join(root, 'invalid.txt'), Uint8Array.from([0xc3, 0x28]))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'invalid.txt' },
      'file-read-5',
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

test('file sandbox maps proxy read bytes to io before UTF-8 decoding', () => {
  const proxyBytes = new Proxy(Uint8Array.of(0x41), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x42
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  const adapter = new FileSandboxAdapter({
    fileSystem: {
      readFileSync() {
        return proxyBytes
      },
      realpathSync(path) {
        return path
      },
      writeFileSync() {},
    },
    root: '/sandbox',
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'input.txt' },
      'file-read-proxy-bytes',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'io' },
        kind: 'err',
      },
    },
  )
})

test('file sandbox maps other read failures to fs.read_error.io', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: '.' },
      'file-read-io',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'io' },
        kind: 'err',
      },
    },
  )
})

test('file sandbox WRITE-001 writes exact bytes and returns ok(unit)', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x41, 0x00, 0x42]), path: 'out.txt' },
      'file-write-1',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.deepEqual(
    readFileSync(join(root, 'out.txt')),
    Buffer.from([0x41, 0x00, 0x42]),
  )
})

test('file sandbox WRITE-002 preserves content when permission is denied', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const path = join(root, 'out.txt')
  writeFileSync(path, Uint8Array.from([0x41]))
  chmodSync(path, 0o400)
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'out.txt' },
      'file-write-2',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'permission_denied' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(readFileSync(path), Buffer.from([0x41]))
})

test('file sandbox WRITE-003 rejects a path outside its root', (context) => {
  const parent = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  mkdirSync(root)
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: '../outside.txt' },
      'file-write-3',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
  )
  assert.equal(existsSync(join(parent, 'outside.txt')), false)
})

test('file sandbox rejects writing through a symlink outside its root', (context) => {
  const parent = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  mkdirSync(root)
  const outside = join(parent, 'outside.txt')
  writeFileSync(outside, Uint8Array.from([0x41]))
  symlinkSync(outside, join(root, 'link.txt'))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'link.txt' },
      'file-write-symlink',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
  )
  assert.deepEqual(readFileSync(outside), Buffer.from([0x41]))
})

test('file sandbox rejects creating through an escaping parent symlink', (context) => {
  const parent = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  const outside = join(parent, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  symlinkSync(outside, join(root, 'linked-dir'))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'linked-dir/new.txt' },
      'file-write-parent-symlink',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
  )
  assert.equal(existsSync(join(outside, 'new.txt')), false)
})

test('file sandbox maps a missing parent directory to parent_not_found', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'missing/out.txt' },
      'file-write-parent-missing',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'parent_not_found' },
        kind: 'err',
      },
    },
  )
})

test('file sandbox maps other write failures to fs.write_error.io', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({ root })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: '.' },
      'file-write-io',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'io' },
        kind: 'err',
      },
    },
  )
})

test('file sandbox maps ENOSPC to fs.write_error.no_space', (context) => {
  const root = mkdtempSync(join(tmpdir(), 're-file-adapter-'))
  context.after(() => rmSync(root, { force: true, recursive: true }))
  const adapter = new FileSandboxAdapter({
    fileSystem: {
      readFileSync,
      realpathSync,
      writeFileSync() {
        const error = new Error('simulated full disk')
        error.code = 'ENOSPC'
        throw error
      },
    },
    root,
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'out.txt' },
      'file-write-no-space',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'no_space' },
        kind: 'err',
      },
    },
  )
})

test('file sandbox snapshots filesystem method authority before root resolution', () => {
  let rootResolved = false
  let readCalls = 0
  const legitimateRead = function (path) {
    assert.equal(this, fileSystem)
    readCalls += 1
    assert.equal(path, '/sandbox/input.txt')
    return Buffer.from('legitimate')
  }
  const spoofRead = function () {
    throw new Error('spoofed read method')
  }
  const fileSystem = {
    realpathSync(path) {
      assert.equal(this, fileSystem)
      rootResolved = true
      return path
    },
    get readFileSync() {
      return rootResolved ? spoofRead : legitimateRead
    },
    writeFileSync(path, bytes) {
      assert.equal(this, fileSystem)
      assert.equal(path, '/sandbox/output.txt')
      assert.deepEqual([...bytes], [0x42])
    },
  }
  const adapter = new FileSandboxAdapter({
    fileSystem,
    root: '/sandbox',
  })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.read@0.1.0', member: 'read_file' },
      { encoding: 'text.encoding.utf8', path: 'input.txt' },
      'file-read-snapshot',
    ),
    {
      kind: 'value',
      value: { kind: 'ok', value: 'legitimate' },
    },
  )
  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: Uint8Array.from([0x42]), path: 'output.txt' },
      'file-write-snapshot',
    ),
    { kind: 'value', value: { kind: 'ok', value: null } },
  )
  assert.equal(readCalls, 1)
})

test('file sandbox rejects proxy write bytes before filesystem dispatch', () => {
  let writeCalls = 0
  const fileSystem = {
    readFileSync() {
      throw new Error('unused')
    },
    realpathSync(path) {
      if (path === '/sandbox/out.txt') {
        const error = new Error('missing output')
        error.code = 'ENOENT'
        throw error
      }
      return path
    },
    writeFileSync() {
      writeCalls += 1
    },
  }
  const proxyBytes = new Proxy(Uint8Array.from([0x11, 0x22]), {
    get(target, name, receiver) {
      if (name === Symbol.iterator) {
        return function* spoofBytes() {
          yield 0x33
        }
      }
      return Reflect.get(target, name, receiver)
    },
  })
  const adapter = new FileSandboxAdapter({ fileSystem, root: '/sandbox' })

  assert.deepEqual(
    adapter.invoke(
      { interface: 'fs.write@0.1.0', member: 'write_file' },
      { data: proxyBytes, path: 'out.txt' },
      'file-write-proxy-bytes',
    ),
    {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'io' },
        kind: 'err',
      },
    },
  )
  assert.equal(writeCalls, 0)
})
