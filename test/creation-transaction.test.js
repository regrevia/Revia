import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  commit,
  createGraph,
  rollback,
} from '../src/toolchain/creation-transaction.js'
import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { checkProgram } from '../src/toolchain/checker.js'
import { isValidUid } from '../src/toolchain/graph-identity.js'
import { parseProgram } from '../src/toolchain/parser.js'

const source = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
const COLLIDING_UID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'

function createHello() {
  const parsed = parseProgram(source, { file: 'hello.re' })
  assert.equal(parsed.ok, true)
  return commit(
    createGraph(parsed.value, {
      check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    }),
  )
}

function collectUids(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUids(item, found)
  } else if (value !== null && typeof value === 'object') {
    if (typeof value.uid === 'string') found.push(value.uid)
    for (const child of Object.values(value)) collectUids(child, found)
  }
  return found
}

test('separate compact creation transactions assign the same stable identities', () => {
  const first = createHello()
  const second = createHello()

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  const firstUids = collectUids(first.program)
  const secondUids = collectUids(second.program)
  assert.ok(firstUids.length > 0)
  assert.ok(firstUids.every(isValidUid))
  assert.equal(new Set(firstUids).size, firstUids.length)
  assert.deepEqual(firstUids, secondUids)
})

test('committed value edges persist the producer UID, not parse order', () => {
  const created = createHello()

  assert.equal(created.ok, true)
  const main = created.program.functions.find(
    (candidate) => candidate.name === '@main',
  )
  const producer = main.statements.find((statement) => statement.kind === 'let')
  const returned = main.statements.find(
    (statement) => statement.kind === 'return',
  )
  assert.equal(returned.value.input.kind, 'value-edge')
  assert.equal(returned.value.input.producer, producer.uid)
  assert.equal(Object.hasOwn(producer, 'id'), false)
})

test('a UID collision rejects the whole creation transaction once', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    uidFactory: () => COLLIDING_UID,
  })

  const rejected = commit(transaction)

  assert.deepEqual(rejected, {
    diagnostics: [{ code: 'uid-collision', uid: COLLIDING_UID }],
    ok: false,
  })
  assert.equal(Object.hasOwn(rejected, 'program'), false)
  assert.deepEqual(commit(transaction), {
    diagnostics: [{ code: 'creation-transaction-not-pending' }],
    ok: false,
  })
})

test('creation rejects an identity already present in the destination graph', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  let next = 0
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const uidFactory = () => `${alphabet[next++]}${'a'.repeat(25)}`
  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    occupiedUids: [COLLIDING_UID],
    uidFactory,
  })

  const rejected = commit(transaction)

  assert.deepEqual(rejected, {
    diagnostics: [{ code: 'uid-collision', uid: COLLIDING_UID }],
    ok: false,
  })
})

test('creation rejects distinct UIDs with the same canonical label', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const colliding = [
    `abcdefg${'a'.repeat(19)}`,
    `abcdefg${'b'.repeat(18)}e`,
  ]
  let next = 0
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const uidFactory = () =>
    colliding[next++] ?? `${alphabet[next]}${'c'.repeat(24)}i`
  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    uidFactory,
  })

  const rejected = commit(transaction)

  assert.equal(rejected.ok, false)
  assert.deepEqual(rejected.diagnostics[0], {
    code: 'ambiguous-label',
    label: 'abcdefg',
    uids: colliding,
  })
})

test('a broken value edge fails without exposing a partial graph', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const returned = parsed.value.functions[0].statements.find(
    (statement) => statement.kind === 'return',
  )
  returned.value.input = {
    kind: 'value-edge',
    location: returned.value.input.location,
    producer: COLLIDING_UID,
  }
  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
  })

  const rejected = commit(transaction)

  assert.equal(rejected.ok, false)
  assert.equal(rejected.diagnostics[0].code, 'unknown-edge-endpoint')
  assert.equal(rejected.diagnostics[0].endpoint, COLLIDING_UID)
  assert.equal(Object.hasOwn(rejected, 'program'), false)
})

test('rollback discards a pending graph and leaves its input untouched', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
  })

  rollback(transaction)

  assert.deepEqual(collectUids(parsed.value), [])
  assert.deepEqual(commit(transaction), {
    diagnostics: [{ code: 'creation-transaction-not-pending' }],
    ok: false,
  })
})

test('an invalid UID factory result becomes one stable diagnostic', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })

  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    uidFactory: () => 42,
  })

  assert.deepEqual(commit(transaction), {
    diagnostics: [{ actual: 42, code: 'invalid-uid' }],
    ok: false,
  })
})

test('a 26-character base32 UID with non-zero padding bits is invalid', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const invalid = `${'a'.repeat(25)}b`

  const transaction = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    uidFactory: () => invalid,
  })

  assert.deepEqual(commit(transaction), {
    diagnostics: [{ actual: invalid, code: 'invalid-uid' }],
    ok: false,
  })
})

test('checker rejects duplicate graph identity without repairing it', () => {
  const created = createHello()
  const graph = structuredClone(created.program)
  graph.functions[0].uid = graph.capabilities[0].uid

  const checked = checkProgram(graph, { file: 'hello.re', registry })

  assert.deepEqual(checked, {
    diagnostics: [
      { code: 'uid-collision', uid: graph.capabilities[0].uid },
    ],
    ok: false,
  })
  assert.equal(graph.functions[0].uid, graph.capabilities[0].uid)
})

test('creation preserves identities already carried by a structured graph', () => {
  const first = createHello()
  const recreated = commit(
    createGraph(first.program, {
      check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    }),
  )

  assert.equal(recreated.ok, true)
  assert.deepEqual(collectUids(recreated.program), collectUids(first.program))
  const firstReturn = first.program.functions[0].statements.find(
    (statement) => statement.kind === 'return',
  )
  const recreatedReturn = recreated.program.functions[0].statements.find(
    (statement) => statement.kind === 'return',
  )
  assert.equal(
    recreatedReturn.value.input.producer,
    firstReturn.value.input.producer,
  )
})

test('committed graph identities cannot be mutated in place', () => {
  const created = createHello()
  const producer = created.program.functions[0].statements.find(
    (statement) => statement.kind === 'let',
  )
  const originalUid = producer.uid

  assert.throws(() => {
    producer.uid = COLLIDING_UID
  }, TypeError)
  assert.equal(producer.uid, originalUid)
})
