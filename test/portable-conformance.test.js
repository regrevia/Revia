import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  PORTABLE_CONFORMANCE_BUNDLE_SCHEMA,
  runPortableConformanceBundle,
  validatePortableConformanceBundle,
} from '../src/toolchain/portable-conformance.js'
import {
  checkSource,
  runSource,
} from '../src/toolchain/demo-toolchain.js'

const repository = new URL('../', import.meta.url)
const bundle = JSON.parse(await readFile(
  new URL('./fixtures/portable-conformance.json', import.meta.url),
  'utf8',
))

test('portable conformance bundle is strict and covers every Demo capability branch', async () => {
  assert.equal(bundle.schema, PORTABLE_CONFORMANCE_BUNDLE_SCHEMA)
  assert.deepEqual(validatePortableConformanceBundle(bundle), { ok: true })
  assert.deepEqual(bundle.required_coverage, [
    'branch:err',
    'branch:ok',
    'capability:fs.read@0.1.0.read_file',
    'capability:fs.write@0.1.0.write_file',
    'capability:process.args@0.1.0.read',
    'capability:process.stdout@0.1.0.write',
    'literal:bytes',
    'arguments:named',
  ])
  assert.equal(bundle.cases.length, 9)

  const result = await runPortableConformanceBundle(bundle, {
    loadGraph: loadGraphCase,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.value.cases.map(({ id, outcome }) => ({ id, outcome })),
    bundle.cases.map(({ expected, id }) => ({ id, outcome: expected.outcome })),
  )
  assert.ok(result.value.cases.every(
    ({ bytecode_artifact_digest }) =>
      /^sha256:[0-9a-f]{64}$/u.test(bytecode_artifact_digest),
  ))
  assert.ok(result.value.cases.every(
    ({ process_request_digest }) =>
      /^sha256:[0-9a-f]{64}$/u.test(process_request_digest),
  ))
  assert.equal(
    result.value.cases[0].bytecode_artifact_digest,
    result.value.cases[1].bytecode_artifact_digest,
  )
  assert.equal(
    result.value.cases[7].bytecode_artifact_digest,
    result.value.cases[8].bytecode_artifact_digest,
  )
})

test('portable conformance bundle runs byte-equivalently twice', async () => {
  const first = await runPortableConformanceBundle(bundle, {
    loadGraph: loadGraphCase,
  })
  const second = await runPortableConformanceBundle(bundle, {
    loadGraph: loadGraphCase,
  })

  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  assert.equal(JSON.stringify(second), JSON.stringify(first))
})

test('portable conformance cases match Node reference host binding outcomes', async () => {
  for (const entry of bundle.cases) {
    const source = await readFile(new URL(entry.graph, repository), 'utf8')
    const fixture = referenceFixture(entry.id)
    const result = runSource(source, {
      argv: fixture.argv,
      file: entry.graph,
      host: fixture.host,
    })

    assert.deepEqual(result.outcome, {
      kind: 'process-status',
      status: { code: entry.expected.outcome.code },
    }, entry.id)
    assert.equal(result.programStdout, fixture.stdout, entry.id)
    fixture.verify()
  }
})

test('portable conformance runner imports no Node builtin or host adapter module', async () => {
  const source = await readFile(
    new URL('../src/toolchain/portable-conformance.js', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes("from 'node:"), false)
  assert.equal(source.includes("from '../host/"), false)
  assert.equal(source.includes('from "../host/'), false)
})

test('portable conformance rejects bundle and case field drift', () => {
  for (const [label, mutate, code] of [
    [
      'bundle field',
      (value) => { value.extra = true },
      'portable-conformance-bundle-unexpected-field',
    ],
    [
      'duplicate id',
      (value) => { value.cases[1].id = value.cases[0].id },
      'portable-conformance-duplicate-case',
    ],
    [
      'case field',
      (value) => { value.cases[0].extra = true },
      'portable-conformance-case-unexpected-field',
    ],
    [
      'graph digest',
      (value) => { value.cases[0].graph_revision = digest('f') },
      'portable-conformance-contract-graph-mismatch',
    ],
    [
      'input digest',
      (value) => { value.cases[0].contract.input_digest = digest('e') },
      'portable-conformance-contract-input-mismatch',
    ],
  ]) {
    const changed = structuredClone(bundle)
    mutate(changed)
    const result = validatePortableConformanceBundle(changed)
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), label)
  }
})

test('portable conformance rejects invocation identity, arguments, response and expected result drift', async () => {
  for (const [label, mutate, code] of [
    [
      'identity',
      (value) => { value.cases[0].invocations[0].member = 'read' },
      'portable-conformance-invocation-mismatch',
    ],
    [
      'arguments',
      (value) => { value.cases[0].invocations[0].arguments.data = 'changed' },
      'portable-conformance-invocation-arguments-mismatch',
    ],
    [
      'response',
      (value) => {
        value.cases[0].invocations[0].response.value.kind = 'err'
        value.cases[0].invocations[0].response.value.value = null
      },
      'portable-conformance-expected-outcome-mismatch',
    ],
    [
      'expected outcome',
      (value) => { value.cases[0].expected.outcome.code = 7 },
      'portable-conformance-expected-outcome-mismatch',
    ],
    [
      'expected receipt',
      (value) => { value.cases[0].expected.receipt.invocations[0].outcome = 'err' },
      'portable-conformance-expected-receipt-mismatch',
    ],
  ]) {
    const changed = structuredClone(bundle)
    mutate(changed)
    const result = await runPortableConformanceBundle(changed, {
      loadGraph: loadGraphCase,
    })
    assert.equal(result.ok, false, label)
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), label)
  }
})

async function loadGraphCase(entry) {
  const source = await readFile(new URL(entry.graph, repository), 'utf8')
  const checked = checkSource(source, { file: entry.graph })
  assert.equal(checked.ok, true, entry.id)
  return { ...checked.program, graph_revision: entry.graph_revision }
}

function digest(character) {
  return `sha256:${character.repeat(64)}`
}

function referenceFixture(id) {
  if (id === 'PORTABLE-STDOUT-OK') {
    return fixture({ stdout: 'Hello, World!\n' })
  }
  if (id === 'PORTABLE-STDOUT-ERR') {
    return fixture({ host: { stdoutBroken: true } })
  }
  if (id === 'PORTABLE-ARGS-OK') {
    return fixture({ argv: ['alpha', 'β'] })
  }
  if (id === 'PORTABLE-ARGS-ERR') {
    return fixture({ argv: [Uint8Array.from([0xc0, 0x80])] })
  }
  if (id === 'PORTABLE-READ-OK') {
    return fixture({
      host: {
        files: new Map([[
          'input.txt',
          fileRecord(new TextEncoder().encode('hello')),
        ]]),
      },
    })
  }
  if (id === 'PORTABLE-READ-ERR') {
    return fixture({ host: { files: new Map() } })
  }
  if (id === 'PORTABLE-READ-NAMED-OK') {
    return fixture({
      host: {
        files: new Map([[
          'input.txt',
          fileRecord(new TextEncoder().encode('β')),
        ]]),
      },
    })
  }
  if (id === 'PORTABLE-WRITE-OK') {
    const files = new Map()
    return fixture({
      host: { files },
      verify() {
        assert.deepEqual(
          files.get('output.txt').bytes,
          Uint8Array.from([0x41, 0x00, 0x42]),
        )
      },
    })
  }
  if (id === 'PORTABLE-WRITE-ERR') {
    const original = Uint8Array.from([0x7a])
    const files = new Map([[
      'output.txt',
      { bytes: original, readable: true, writable: false },
    ]])
    return fixture({
      host: { files },
      verify() {
        assert.deepEqual(files.get('output.txt').bytes, original)
      },
    })
  }
  throw new Error(`unknown portable conformance case: ${id}`)
}

function fixture({
  argv = [],
  host = {},
  stdout = '',
  verify = () => {},
} = {}) {
  return { argv, host, stdout, verify }
}

function fileRecord(bytes) {
  return { bytes, readable: true, writable: true }
}
