import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileSandboxAdapter } from '../src/host/file-sandbox-adapter.js'
import { MemoryAdapter } from '../src/host/memory-adapter.js'
import { checkAdapterVector } from '../test-support/host-adapter-conformance.js'

const SHARED_FILE_VECTORS = [
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'permission_denied' },
        kind: 'err',
      },
    },
    expectedState: null,
    id: 'READ-003',
    operation: { interface: 'fs.read@0.1.0', member: 'read_file' },
    setupFiles: [
      { bytes: Buffer.from('secret'), path: 'secret.txt', readable: false },
    ],
    typedArguments: {
      encoding: 'text.encoding.utf8',
      path: 'secret.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
    expectedState: null,
    id: 'READ-004',
    operation: { interface: 'fs.read@0.1.0', member: 'read_file' },
    setupFiles: [],
    typedArguments: {
      encoding: 'text.encoding.utf8',
      path: '../outside.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: { kind: 'ok', value: '你好\n' },
    },
    expectedState: null,
    id: 'READ-001',
    operation: { interface: 'fs.read@0.1.0', member: 'read_file' },
    setupFiles: [{ bytes: Buffer.from('你好\n'), path: 'input.txt' }],
    typedArguments: {
      encoding: 'text.encoding.utf8',
      path: 'input.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'permission_denied' },
        kind: 'err',
      },
    },
    expectedState: [0x41],
    id: 'WRITE-002',
    observePath: 'out.txt',
    operation: { interface: 'fs.write@0.1.0', member: 'write_file' },
    setupFiles: [
      {
        bytes: Uint8Array.from([0x41]),
        path: 'out.txt',
        writable: false,
      },
    ],
    typedArguments: {
      data: Uint8Array.from([0x42]),
      path: 'out.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.write_error', variant: 'outside_sandbox' },
        kind: 'err',
      },
    },
    expectedState: null,
    id: 'WRITE-003',
    observePath: '../outside.txt',
    operation: { interface: 'fs.write@0.1.0', member: 'write_file' },
    setupFiles: [],
    typedArguments: {
      data: Uint8Array.from([0x42]),
      path: '../outside.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'not_found' },
        kind: 'err',
      },
    },
    expectedState: null,
    id: 'READ-002',
    operation: { interface: 'fs.read@0.1.0', member: 'read_file' },
    setupFiles: [],
    typedArguments: {
      encoding: 'text.encoding.utf8',
      path: 'missing.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: {
        error: { type: 'fs.read_error', variant: 'invalid_utf8' },
        kind: 'err',
      },
    },
    expectedState: null,
    id: 'READ-005',
    operation: { interface: 'fs.read@0.1.0', member: 'read_file' },
    setupFiles: [
      { bytes: Uint8Array.from([0xc3, 0x28]), path: 'invalid.txt' },
    ],
    typedArguments: {
      encoding: 'text.encoding.utf8',
      path: 'invalid.txt',
    },
  },
  {
    expectedOutcome: {
      kind: 'value',
      value: { kind: 'ok', value: null },
    },
    expectedState: [0x41, 0x00, 0x42],
    id: 'WRITE-001',
    observePath: 'out.txt',
    operation: { interface: 'fs.write@0.1.0', member: 'write_file' },
    setupFiles: [],
    typedArguments: {
      data: Uint8Array.from([0x41, 0x00, 0x42]),
      path: 'out.txt',
    },
  },
]

class NewlineAddingAdapter {
  #stdout

  constructor(stdout) {
    this.#stdout = stdout
  }

  invoke(_operation, typedArguments) {
    this.#stdout.push(`${typedArguments.data}\n`)
    return { kind: 'value', value: { kind: 'ok', value: null } }
  }
}

test('STDOUT-004 conformance detects an adapter-added newline', () => {
  const stdout = []
  const result = checkAdapterVector({
    adapter: new NewlineAddingAdapter(stdout),
    expectedOutcome: { kind: 'value', value: { kind: 'ok', value: null } },
    expectedState: ['ready'],
    invocationId: 'stdout-4',
    observeState: () => stdout,
    operation: { interface: 'process.stdout@0.1.0', member: 'write' },
    typedArguments: { data: 'ready' },
  })

  assert.deepEqual(result, {
    diagnostics: [{ code: 'observable-state-mismatch' }],
    ok: false,
  })
})

for (const [adapterName, createHarness] of [
  ['memory', createMemoryHarness],
  ['file sandbox', createFileHarness],
]) {
  for (const vector of SHARED_FILE_VECTORS) {
    test(`${adapterName} adapter passes shared ${vector.id}`, (context) => {
      const harness = createHarness(vector, context)

      assert.deepEqual(
        checkAdapterVector({
          adapter: harness.adapter,
          expectedOutcome: vector.expectedOutcome,
          expectedState: vector.expectedState,
          invocationId: `shared-${adapterName}-${vector.id}`,
          observeState: harness.observeState,
          operation: vector.operation,
          typedArguments: vector.typedArguments,
        }),
        { diagnostics: [], ok: true },
      )
    })
  }
}

function createMemoryHarness(vector) {
  const files = new Map(
    vector.setupFiles.map((file) => [
      file.path,
      {
        bytes: Uint8Array.from(file.bytes),
        readable: file.readable !== false,
        writable: file.writable !== false,
      },
    ]),
  )
  return {
    adapter: new MemoryAdapter({ files }),
    observeState: () => observeMemoryFile(files, vector.observePath),
  }
}

function createFileHarness(vector, context) {
  const parent = mkdtempSync(join(tmpdir(), 're-shared-adapter-'))
  context.after(() => rmSync(parent, { force: true, recursive: true }))
  const root = join(parent, 'sandbox')
  mkdirSync(root)
  for (const file of vector.setupFiles) {
    const path = join(root, file.path)
    writeFileSync(path, file.bytes)
    if (file.readable === false) chmodSync(path, 0o200)
    if (file.writable === false) chmodSync(path, 0o400)
  }
  return {
    adapter: new FileSandboxAdapter({ root }),
    observeState: () => observeLocalFile(root, vector.observePath),
  }
}

function observeMemoryFile(files, path) {
  if (path === undefined) return null
  const file = files.get(path)
  return file === undefined ? null : [...file.bytes]
}

function observeLocalFile(root, path) {
  if (path === undefined) return null
  const file = join(root, path)
  return existsSync(file) ? [...readFileSync(file)] : null
}
