import assert from 'node:assert/strict'
import test from 'node:test'

import { checkSource } from '../src/toolchain/demo-toolchain.js'
import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import { checkProgram } from '../src/toolchain/checker.js'
import {
  commit,
  createGraph,
} from '../src/toolchain/creation-transaction.js'
import { evaluateProgram } from '../src/toolchain/evaluator.js'
import {
  loadCanonicalGraph,
  serializeCanonicalGraph,
} from '../src/toolchain/canonical.js'

import { readFile } from 'node:fs/promises'

const hello = await readFile(new URL('../examples/hello.re', import.meta.url), 'utf8')
const argsCheck = await readFile(
  new URL('../examples/args-check.re', import.meta.url),
  'utf8',
)
const readCheck = await readFile(
  new URL('../examples/read-check.re', import.meta.url),
  'utf8',
)
const readEncoding = await readFile(
  new URL('../examples/read-encoding.re', import.meta.url),
  'utf8',
)
const writeCheck = await readFile(
  new URL('../examples/write-check.re', import.meta.url),
  'utf8',
)
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value

function collectGraphIdentity(value, collected = { endpoints: [], uids: [] }) {
  if (Array.isArray(value)) {
    for (const item of value) collectGraphIdentity(item, collected)
  } else if (value !== null && typeof value === 'object') {
    if (typeof value.uid === 'string') collected.uids.push(value.uid)
    if (value.kind === 'value-edge') {
      if (typeof value.endpoint === 'string') {
        collected.endpoints.push(`argument:${value.endpoint}`)
      }
      if (typeof value.producer === 'string') {
        collected.endpoints.push(`match:${value.producer}`)
      }
    }
    for (const child of Object.values(value)) {
      collectGraphIdentity(child, collected)
    }
  }
  return {
    endpoints: collected.endpoints.sort(),
    uids: collected.uids.sort(),
  }
}

test('canonical serializer round-trips the hello graph byte-identically', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  assert.equal(checked.ok, true)

  const serialized = serializeCanonicalGraph(checked.program)
  const reloaded = loadCanonicalGraph(serialized)
  assert.equal(reloaded.ok, true)

  assert.deepEqual(
    collectGraphIdentity(reloaded.value),
    collectGraphIdentity(checked.program),
  )

  const reserialized = serializeCanonicalGraph(reloaded.value)
  assert.equal(reserialized, serialized)
})

test('canonical serializer round-trips a zero-argument capability call', () => {
  const checked = checkSource(argsCheck, { file: 'args-check.re' })
  assert.equal(checked.ok, true)

  const serialized = serializeCanonicalGraph(checked.program)
  const reloaded = loadCanonicalGraph(serialized)

  assert.equal(reloaded.ok, true)
  assert.equal(serializeCanonicalGraph(reloaded.value), serialized)
})

test('canonical serializer round-trips an fs path literal', () => {
  const checked = checkSource(readCheck, { file: 'read-check.re' })
  assert.equal(checked.ok, true)

  const serialized = serializeCanonicalGraph(checked.program)
  const reloaded = loadCanonicalGraph(serialized)

  assert.equal(reloaded.ok, true)
  assert.match(serialized, /literal .* fs\.path = "input\.txt"/)
  assert.equal(serializeCanonicalGraph(reloaded.value), serialized)
})

test('canonical multi-argument calls sort parameters and round-trip', () => {
  const checked = checkSource(readEncoding, { file: 'read-encoding.re' })
  assert.equal(checked.ok, true)
  const reordered = structuredClone(checked.program)
  reordered.functions[0].statements[0].value.arguments.reverse()

  const serialized = serializeCanonicalGraph(reordered)
  const reloaded = loadCanonicalGraph(serialized)

  assert.equal(reloaded.ok, true)
  assert.match(serialized, /read_file\(encoding: .*?, path: .*?\)/)
  assert.equal(serializeCanonicalGraph(reloaded.value), serialized)
})

test('canonical serializer round-trips a bytes source literal', () => {
  const checked = checkSource(writeCheck, { file: 'write-check.re' })
  assert.equal(checked.ok, true)

  const serialized = serializeCanonicalGraph(checked.program)
  const reloaded = loadCanonicalGraph(serialized)

  assert.equal(reloaded.ok, true)
  assert.match(serialized, /literal .* bytes = hex:410042/)
  assert.equal(serializeCanonicalGraph(reloaded.value), serialized)
})

test('checked bytes values cannot mutate canonical graph identity in place', () => {
  const checked = checkSource(writeCheck, { file: 'write-check.re' })
  const canonical = serializeCanonicalGraph(checked.program)
  const bytes = checked.program.functions[0].literals.find(
    (literal) => literal.type === 'bytes',
  )

  try {
    bytes.value[0] = 0xff
  } catch {}

  assert.equal(serializeCanonicalGraph(checked.program), canonical)
})

test('canonical loader rejects non-lowercase or odd bytes', () => {
  const checked = checkSource(writeCheck, { file: 'write-check.re' })
  const canonical = serializeCanonicalGraph(checked.program)

  for (const value of ['hex:41004', 'hex:41004A']) {
    const loaded = loadCanonicalGraph(canonical.replace('hex:410042', value))
    assert.equal(loaded.ok, false, value)
    assert.equal(loaded.diagnostics[0].code, 'invalid-literal-value', value)
  }
})

test('canonical zero-argument calls reject partial argument syntax', () => {
  const checked = checkSource(argsCheck, { file: 'args-check.re' })
  assert.equal(checked.ok, true)
  const canonical = serializeCanonicalGraph(checked.program)

  for (const malformed of [
    '@args.read(:)',
    '@args.read(data:)',
    '@args.read(: %uaaaaaai)',
  ]) {
    const loaded = loadCanonicalGraph(
      canonical.replace('@args.read()', malformed),
    )
    assert.equal(loaded.ok, false, malformed)
    assert.equal(loaded.diagnostics[0].code, 'invalid-call', malformed)
  }
})

test('canonical loader rejects malformed canonical text', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const malformed = serializeCanonicalGraph(checked.program).replace(
    /^  let .*$/m,
    '  bad line',
  )

  const result = loadCanonicalGraph(malformed)

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'invalid-statement-line')
})

test('loaded canonical graph checks and executes without allocating identity', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const loaded = loadCanonicalGraph(serializeCanonicalGraph(checked.program))
  let allocations = 0
  const recommitted = commit(
    createGraph(loaded.value, {
      check: (graph) => checkProgram(graph, { file: '<canonical>', registry }),
      uidFactory: () => {
        allocations += 1
        return 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
      },
    }),
  )

  assert.equal(recommitted.ok, true)
  assert.equal(allocations, 0)
  const stdout = []
  const outcome = evaluateProgram(recommitted.program, { stdout })
  assert.deepEqual(outcome, {
    code: 0,
    type: 'process.status',
  })
  assert.equal(stdout.join(''), 'Hello, World!\n')
})

test('canonical bytes do not depend on graph collection order', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const reordered = structuredClone(checked.program)
  const main = reordered.functions[0]
  main.literals.reverse()
  main.statements.reverse()
  const returned = main.statements.find(
    (statement) => statement.kind === 'return',
  )
  returned.value.branches.reverse()

  assert.equal(
    serializeCanonicalGraph(reordered),
    serializeCanonicalGraph(checked.program),
  )
})

test('reordered canonical-multi graph stays stable across two load generations', async () => {
  const source = await readFile(
    new URL('../test/fixtures/canonical-multi.re', import.meta.url),
    'utf8',
  )
  const checked = checkSource(source, { file: 'canonical-multi.re' })
  assert.equal(checked.ok, true)

  const reordered = structuredClone(checked.program)
  reordered.capabilities.reverse()
  const main = reordered.functions[0]
  main.literals.reverse()
  main.statements.reverse()

  let canonical = serializeCanonicalGraph(reordered)
  for (let generation = 0; generation < 2; generation += 1) {
    const loaded = loadCanonicalGraph(canonical)
    assert.equal(loaded.ok, true)
    const next = serializeCanonicalGraph(loaded.value)
    assert.equal(next, canonical)
    canonical = next
  }
})

test('canonical loader rejects a label that is not derived from its UID', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program).replace(
    /%u[a-z2-7]{7}(: uid\("[a-z2-7]{26}"\):)/,
    '%uzzzzzzz$1',
  )

  const loaded = loadCanonicalGraph(canonical)

  assert.equal(loaded.ok, false)
  assert.equal(loaded.diagnostics[0].code, 'label-uid-mismatch')
})

test('canonical loader rejects parseable bytes that are not the unique serialization', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program)

  for (const source of [
    canonical.replace('\nunit ', '\n\nunit '),
    `${canonical}\n`,
  ]) {
    const loaded = loadCanonicalGraph(source)
    assert.equal(loaded.ok, false)
    assert.equal(loaded.diagnostics[0].code, 'non-canonical-source')
    assert.equal(typeof loaded.diagnostics[0].byte_offset, 'number')
  }
})

test('canonical loader rejects comments and annotations instead of preserving metadata', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program)

  for (const marker of ['// human-only note', '#[audit.trace]']) {
    const loaded = loadCanonicalGraph(
      canonical.replace('\nunit ', `\n${marker}\nunit `),
    )
    assert.equal(loaded.ok, false)
    assert.equal(loaded.diagnostics[0].code, 'unexpected-canonical-line')
  }
})

test('canonical strings must already use NFC bytes', () => {
  const source = hello.replace('Hello, World!', 'caf\u00e9')
  const checked = checkSource(source, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program)
  const decomposed = canonical.replace('caf\u00e9', 'cafe\u0301')

  const loaded = loadCanonicalGraph(decomposed)

  assert.equal(loaded.ok, false)
  assert.equal(loaded.diagnostics[0].code, 'non-canonical-source')
})

test('canonical integer round-trips beyond host safe integer precision', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program).replace(
    ' int = 0\n',
    ' int = -90071992547409920000000000000000000000\n',
  )

  const loaded = loadCanonicalGraph(canonical)

  assert.equal(loaded.ok, true)
  assert.equal(serializeCanonicalGraph(loaded.value), canonical)
})

test('canonical decimal preserves arbitrary precision and exact scale', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const graph = structuredClone(checked.program)
  graph.functions[0].literals.push({
    kind: 'literal',
    location: { column: 1, file: 'decimal.re', line: 1 },
    type: 'decimal<5>',
    uid: 'zzzzzzzzzzzzzzzzzzzzzzzzza',
    value: '-9007199254740993.00100',
  })

  const canonical = serializeCanonicalGraph(graph)
  const loaded = loadCanonicalGraph(canonical)

  assert.equal(loaded.ok, true)
  assert.equal(serializeCanonicalGraph(loaded.value), canonical)
  const rechecked = checkProgram(loaded.value, {
    file: 'decimal.re',
    registry,
  })
  assert.equal(rechecked.ok, true)
})

test('canonical decimal rejects scale and syntax drift', () => {
  const checked = checkSource(hello, { file: 'hello.re' })
  const canonical = serializeCanonicalGraph(checked.program)
  const intLine = /  literal .* int = 0\n/

  for (const replacement of [
    (line) => line.replace('int = 0', 'decimal<2> = -0.00'),
    (line) => line.replace('int = 0', 'decimal<2> = 01.00'),
    (line) => line.replace('int = 0', 'decimal<2> = 1.0'),
    (line) => line.replace('int = 0', 'decimal<256> = 1'),
  ]) {
    const candidate = canonical.replace(intLine, replacement)
    const loaded = loadCanonicalGraph(candidate)

    assert.equal(loaded.ok, false, candidate)
    assert.equal(loaded.diagnostics[0].code, 'invalid-literal-value')
  }
})
