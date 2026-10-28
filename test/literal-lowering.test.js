import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  commit,
  createGraph,
} from '../src/toolchain/creation-transaction.js'
import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { checkProgram } from '../src/toolchain/checker.js'
import { parseProgram } from '../src/toolchain/parser.js'
import { runSource } from '../src/toolchain/demo-toolchain.js'

const source = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value

function createHello() {
  const parsed = parseProgram(source, { file: 'hello.re' })
  assert.equal(parsed.ok, true)
  return commit(
    createGraph(parsed.value, {
      check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    }),
  )
}

function collectLiteralUids(graph) {
  const literals = graph.functions?.[0]?.literals ?? []
  return literals.map((node) => node.uid)
}

function findCallByMember(statements, member) {
  for (const statement of statements) {
    if (statement.value?.target?.member === member) return statement.value
    for (const branch of statement.value?.branches ?? []) {
      if (branch.value?.target?.operation === member) return branch.value
    }
  }
  return undefined
}

test('inline literals are materialized as stable literal graph nodes', () => {
  const created = createHello()
  assert.equal(created.ok, true)

  const main = created.program.functions.find((candidate) => candidate.name === '@main')
  assert.ok(Array.isArray(main.literals))
  assert.ok(main.literals.length > 0)

  for (const literal of main.literals) {
    assert.equal(literal.kind, 'literal')
    assert.match(literal.uid, /^[a-z2-7]{26}$/)
    assert.equal(typeof literal.type, 'string')
  }

  const message = main.literals.find(
    (literal) => literal.type === 'text.utf8',
  )
  assert.deepEqual(message.value, 'Hello, World!\n')
  assert.ok(
    main.literals
      .filter((literal) => literal.type === 'int')
      .every((literal) => typeof literal.value === 'string'),
  )
})

test('production parser preserves decimal scale in the literal type', () => {
  const parsed = parseProgram(
    source.replace('process.exit(0)', 'process.exit(-9007199254740993.00100)'),
    { file: 'decimal.re' },
  )

  assert.equal(parsed.ok, true)
  const returnStatement = parsed.value.functions[0].statements.find(
    (statement) => statement.kind === 'return',
  )
  const okExit = returnStatement.value.branches.find(
    (branch) => branch.variant === 'ok',
  )
  assert.deepEqual(okExit.value.arguments[0].literal, {
    kind: 'literal',
    type: 'decimal<5>',
    value: '-9007199254740993.00100',
  })
})

test('call arguments reference literal nodes through value edges, not raw values', () => {
  const created = createHello()
  assert.equal(created.ok, true)

  const main = created.program.functions.find((candidate) => candidate.name === '@main')
  const write = main.statements.find(
    (statement) => statement.value?.target?.member === 'write',
  ).value
  const dataArgument = write.arguments[0]
  assert.equal(dataArgument.source.kind, 'value-edge')
  assert.match(dataArgument.source.endpoint, /^[a-z2-7]{26}$/)

  const literalUids = new Set(collectLiteralUids(created.program))
  assert.ok(literalUids.has(dataArgument.source.endpoint))
  assert.equal(
    Object.hasOwn(dataArgument, 'value'),
    false,
    'the raw value must not remain the argument semantics source',
  )
})

test('separate compact creation transactions assign the same literal UIDs', () => {
  const first = createHello()
  const second = createHello()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)

  assert.deepEqual(
    collectLiteralUids(first.program).sort(),
    collectLiteralUids(second.program).sort(),
  )
})

test('literal identities and argument endpoints survive re-entering a structured graph', () => {
  const first = createHello()
  assert.equal(first.ok, true)

  const recreated = commit(
    createGraph(first.program, {
      check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    }),
  )
  assert.equal(recreated.ok, true)

  assert.deepEqual(collectLiteralUids(recreated.program), collectLiteralUids(first.program))

  const firstWrite = first.program.functions[0].statements
    .find((statement) => statement.value?.target?.member === 'write')
    .value.arguments[0].source.endpoint
  const recreatedWrite = recreated.program.functions[0].statements
    .find((statement) => statement.value?.target?.member === 'write')
    .value.arguments[0].source.endpoint
  assert.equal(recreatedWrite, firstWrite)
})

test('a broken literal endpoint is rejected atomically at check time', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  // Pre-lower the literals using createGraph but keep the transaction pending-free
  // by constructing the structured shape directly with a dangling endpoint.
  const pending = createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
  })
  // Commit once to materialize literals, then break an endpoint.
  const committed = commit(pending)
  assert.equal(committed.ok, true)

  const broken = structuredClone(committed.program)
  const write = broken.functions[0].statements
    .find((statement) => statement.value?.target?.member === 'write')
  write.value.arguments[0].source.endpoint =
    'aaaaaaaaaaaaaaaaaaaaaaaaaa'

  const transaction = createGraph(broken, {
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
  })
  const rejected = commit(transaction)

  assert.equal(rejected.ok, false)
  assert.equal(rejected.diagnostics[0].code, 'unknown-edge-endpoint')
  assert.equal(rejected.diagnostics[0].endpoint, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(Object.hasOwn(rejected, 'program'), false)
})

test('the evaluator resolves literal values along argument value edges', () => {
  const result = runSource(source.replace('Hello, World!', 'literals attached'), {
    file: 'hello.re',
  })

  assert.deepEqual(result, {
    outcome: { kind: 'process-status', status: { code: 0 } },
    programStdout: 'literals attached\n',
  })
})

test('the checker rejects a literal node whose type does not match the schema', () => {
  const parsed = parseProgram(source, { file: 'hello.re' })
  const committed = commit(
    createGraph(parsed.value, {
      check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    }),
  )
  assert.equal(committed.ok, true)

  const broken = structuredClone(committed.program)
  const main = broken.functions[0]
  const intLiteral = main.literals.find((literal) => literal.type === 'int')
  // Point the text.utf8 data argument at an integer literal endpoint.
  const write = main.statements.find(
    (statement) => statement.value?.target?.member === 'write',
  ).value
  write.arguments[0].source.endpoint = intLiteral.uid

  const checked = checkProgram(broken, { file: 'hello.re', registry })
  assert.equal(checked.ok, false)
  assert.equal(checked.diagnostics[0].code, 'argument-type-mismatch')
})
