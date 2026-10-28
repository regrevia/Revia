import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { checkSource, runSource } from '../src/toolchain/demo-toolchain.js'
import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { checkProgram } from '../src/toolchain/checker.js'
import {
  applyStructuredPatch,
  commitReplaceInput,
  createReplaceInputTransaction,
  graphRevision,
} from '../src/toolchain/structured-patch.js'
import { serializeCanonicalGraph } from '../src/toolchain/canonical.js'

const hello = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
const PATCHED_LITERAL_UID = `zzzzzzz${'a'.repeat(19)}`

function patchableHello() {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const graph = structuredClone(checked.program)
  const main = graph.functions.find((candidate) => candidate.name === '@main')
  main.literals.push({
    kind: 'literal',
    location: { column: 1, file: 'hello.re', line: 1 },
    type: 'text.utf8',
    uid: PATCHED_LITERAL_UID,
    value: 'Hello from patch!\n',
  })
  const prepared = checkProgram(graph, { file: 'hello.re', registry })
  assert.equal(prepared.ok, true)
  return prepared
}

test('replace-input updates exactly one call argument when the expected endpoint matches', () => {
  const checked = patchableHello()
  const main = checked.program.functions.find((candidate) => candidate.name === '@main')
  const letStatement = main.statements.find((statement) => statement.kind === 'let')
  const originalEndpoint = letStatement.value.arguments[0].source.endpoint

  const transaction = createReplaceInputTransaction(checked.program, {
    callUid: letStatement.value.uid,
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    expectedOldEndpoint: originalEndpoint,
    newEndpoint: PATCHED_LITERAL_UID,
    parameterName: 'data',
  })

  const committed = commitReplaceInput(transaction)
  assert.equal(committed.ok, true)
  assert.equal(
    committed.program.functions[0].statements.find((statement) => statement.kind === 'let').value.arguments[0].source.endpoint,
    PATCHED_LITERAL_UID,
  )
  assert.equal(
    runSource(serializeCanonicalGraph(committed.program), { file: 'hello.re' }).programStdout,
    'Hello from patch!\n',
  )
})

test('replace-input rejects a stale old endpoint and rolls back atomically', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)
  const main = checked.program.functions.find((candidate) => candidate.name === '@main')
  const letStatement = main.statements.find((statement) => statement.kind === 'let')

  const transaction = createReplaceInputTransaction(checked.program, {
    callUid: letStatement.value.uid,
    check: () => checked,
    expectedOldEndpoint: 'stale-endpoint',
    newEndpoint: main.literals[0].uid,
    parameterName: 'data',
  })

  const result = commitReplaceInput(transaction)
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'replace-input-old-endpoint-mismatch')
})

test('patched canonical remains checked and executable', () => {
  const checked = patchableHello()
  const main = checked.program.functions.find((candidate) => candidate.name === '@main')
  const letStatement = main.statements.find((statement) => statement.kind === 'let')

  const transaction = createReplaceInputTransaction(checked.program, {
    callUid: letStatement.value.uid,
    check: (graph) => checkProgram(graph, { file: 'hello.re', registry }),
    expectedOldEndpoint: letStatement.value.arguments[0].source.endpoint,
    newEndpoint: PATCHED_LITERAL_UID,
    parameterName: 'data',
  })
  const committed = commitReplaceInput(transaction)
  assert.equal(committed.ok, true)
  const executed = runSource(serializeCanonicalGraph(committed.program), { file: 'hello.re' })
  assert.equal(executed.outcome.kind, 'process-status')
  assert.equal(executed.programStdout, 'Hello from patch!\n')
})

test('a revision-pinned patch applies multiple input replacements atomically', () => {
  const checked = patchableHello()
  const before = serializeCanonicalGraph(checked.program)
  const main = checked.program.functions.find((candidate) => candidate.name === '@main')
  const write = main.statements.find((statement) => statement.kind === 'let').value
  const returned = main.statements.find((statement) => statement.kind === 'return')
  const errorExit = returned.value.branches.find((branch) => branch.variant === 'err').value
  const okExit = returned.value.branches.find((branch) => branch.variant === 'ok').value

  const result = applyStructuredPatch(
    checked.program,
    {
      baseRevision: graphRevision(checked.program),
      operations: [
        {
          callUid: write.uid,
          expectedOldEndpoint: write.arguments[0].source.endpoint,
          kind: 'replace-input',
          newEndpoint: PATCHED_LITERAL_UID,
          parameterName: 'data',
        },
        {
          callUid: errorExit.uid,
          expectedOldEndpoint: errorExit.arguments[0].source.endpoint,
          kind: 'replace-input',
          newEndpoint: okExit.arguments[0].source.endpoint,
          parameterName: 'code',
        },
      ],
      schema: 're.structured-patch@0.1.0',
    },
    { check: (graph) => checkProgram(graph, { file: 'hello.re', registry }) },
  )

  assert.equal(result.ok, true)
  assert.equal(result.receipt.schema, 're.patch-receipt@0.1.0')
  assert.equal(result.receipt.base_revision, graphRevision(checked.program))
  assert.equal(result.receipt.operations.length, 2)
  assert.equal(result.receipt.result_revision, graphRevision(result.program))
  assert.notEqual(result.receipt.result_revision, result.receipt.base_revision)
  assert.equal(serializeCanonicalGraph(checked.program), before)
  assert.equal(
    runSource(serializeCanonicalGraph(result.program), { file: 'hello.re' }).programStdout,
    'Hello from patch!\n',
  )
})

test('a stale graph revision rejects the whole patch before editing', () => {
  const checked = patchableHello()
  const before = serializeCanonicalGraph(checked.program)
  const write = checked.program.functions[0].statements.find(
    (statement) => statement.kind === 'let',
  ).value

  const result = applyStructuredPatch(
    checked.program,
    {
      baseRevision: `sha256:${'0'.repeat(64)}`,
      operations: [{
        callUid: write.uid,
        expectedOldEndpoint: write.arguments[0].source.endpoint,
        kind: 'replace-input',
        newEndpoint: PATCHED_LITERAL_UID,
        parameterName: 'data',
      }],
      schema: 're.structured-patch@0.1.0',
    },
    { check: (graph) => checkProgram(graph, { file: 'hello.re', registry }) },
  )

  assert.deepEqual(result, {
    diagnostics: [{
      actual: graphRevision(checked.program),
      code: 'patch-base-revision-mismatch',
      expected: `sha256:${'0'.repeat(64)}`,
    }],
    ok: false,
  })
  assert.equal(serializeCanonicalGraph(checked.program), before)
})

test('a later operation conflict rolls back earlier operations in the batch', () => {
  const checked = patchableHello()
  const before = serializeCanonicalGraph(checked.program)
  const main = checked.program.functions[0]
  const write = main.statements.find((statement) => statement.kind === 'let').value
  const returned = main.statements.find((statement) => statement.kind === 'return')
  const errorExit = returned.value.branches.find((branch) => branch.variant === 'err').value

  const result = applyStructuredPatch(
    checked.program,
    {
      baseRevision: graphRevision(checked.program),
      operations: [
        {
          callUid: write.uid,
          expectedOldEndpoint: write.arguments[0].source.endpoint,
          kind: 'replace-input',
          newEndpoint: PATCHED_LITERAL_UID,
          parameterName: 'data',
        },
        {
          callUid: errorExit.uid,
          expectedOldEndpoint: 'stale-endpoint',
          kind: 'replace-input',
          newEndpoint: main.literals.find((literal) => literal.value === '0').uid,
          parameterName: 'code',
        },
      ],
      schema: 're.structured-patch@0.1.0',
    },
    { check: (graph) => checkProgram(graph, { file: 'hello.re', registry }) },
  )

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0].code, 'replace-input-old-endpoint-mismatch')
  assert.equal(result.diagnostics[0].operation, 1)
  assert.equal(Object.hasOwn(result, 'program'), false)
  assert.equal(serializeCanonicalGraph(checked.program), before)
})
