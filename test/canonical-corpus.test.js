import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { demoSchemaDefinitions } from '../src/host/demo-schema.js'
import { SchemaRegistry } from '../src/host/schema-registry.js'
import {
  CANONICAL_GRAPH_SLICE,
  loadCanonicalGraph,
  serializeCanonicalGraph,
} from '../src/toolchain/canonical.js'
import { checkProgram } from '../src/toolchain/checker.js'
import { commit, createGraph } from '../src/toolchain/creation-transaction.js'
import { parseExecutableSource } from '../src/toolchain/executable-source.js'

const repository = new URL('../', import.meta.url)
const corpus = JSON.parse(await readFile(
  new URL('./fixtures/canonical-corpus.json', import.meta.url),
  'utf8',
))
const registry = SchemaRegistry.load(demoSchemaDefinitions()).value
const graphCases = new Map()

for (const entry of corpus.graph_cases) {
  const source = await readFile(new URL(entry.fixture, repository), 'utf8')
  const parsed = parseExecutableSource(source, { file: entry.fixture })
  assert.equal(parsed.ok, true, entry.id)
  const checked = commit(createGraph(parsed.value, {
    check: (graph) => checkProgram(graph, { file: entry.fixture, registry }),
    uidFactory: deterministicUidFactory(),
  }))
  assert.equal(checked.ok, true, entry.id)
  graphCases.set(entry.id, checked.program)
}

const MUTATIONS = Object.freeze({
  'append-trailing-newline': (source) => `${source}\n`,
  'decompose-nfc-string': (source) => source.replace('café', 'cafe\u0301'),
  'insert-annotation': (source) =>
    source.replace('\nunit ', '\n#[audit.trace]\nunit '),
  'insert-blank-line': (source) => source.replace('\nunit ', '\n\nunit '),
  'insert-comment': (source) => source.replace('\nunit ', '\n// note\nunit '),
  'reverse-branches': (source) => reverseMatchingLines(source, '    branch '),
  'reverse-capabilities': (source) => reverseMatchingLines(source, 'cap '),
  'reverse-let-statements': (source) => reverseMatchingLines(source, '  let '),
})

test('canonical corpus schema binds exact bytes and the supported graph slice', () => {
  assert.equal(corpus.schema, 're.canonical-corpus@0.2.0')
  assert.equal(corpus.status, 'serializer-owned-evidence')

  const entries = [...corpus.graph_cases, ...corpus.mutation_cases]
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length)
  assert.deepEqual(corpus.required_coverage, manifestCoverage())
  assert.ok(corpus.graph_cases.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)))
  assert.ok(corpus.graph_cases.every(({ source_form: form }) =>
    form === 'compact' || form === 'canonical'
  ))
  assert.ok(corpus.mutation_cases.every(({ graph }) => graphCases.has(graph)))
  assert.deepEqual(
    [...new Set(corpus.mutation_cases.map(({ operation }) => operation))].sort(),
    Object.keys(MUTATIONS).sort(),
  )
})

test('serializer goldens cover every currently supported canonical node family', () => {
  const actualCoverage = new Set()
  for (const entry of corpus.graph_cases) {
    const graph = graphCases.get(entry.id)
    const canonical = serializeCanonicalGraph(graph)
    const loaded = loadCanonicalGraph(canonical)

    assert.equal(sha256(canonical), entry.sha256, entry.id)
    assert.equal(loaded.ok, true, entry.id)
    assert.equal(serializeCanonicalGraph(loaded.value), canonical, entry.id)
    collectCoverage(graph, actualCoverage)
  }
  assert.deepEqual([...actualCoverage].sort(), corpus.required_coverage)
})

test('canonical load and serialize stay byte-idempotent across two generations', () => {
  for (const entry of corpus.graph_cases) {
    let source = serializeCanonicalGraph(graphCases.get(entry.id))
    for (let generation = 0; generation < 2; generation += 1) {
      const loaded = loadCanonicalGraph(source)
      assert.equal(loaded.ok, true, `${entry.id} generation ${generation}`)
      const next = serializeCanonicalGraph(loaded.value)
      assert.equal(next, source, `${entry.id} generation ${generation}`)
      source = next
    }
  }
})

test('every graph case declares a source-to-serializer golden', () => {
  const missing = corpus.graph_cases
    .filter(({ canonical_golden: golden }) => golden === undefined)
    .map(({ id }) => id)

  assert.deepEqual(missing, [])
})

test('declared source-to-serializer goldens are byte-exact', async () => {
  for (const entry of corpus.graph_cases.filter(({ canonical_golden: golden }) =>
    golden !== undefined
  )) {
    const canonical = serializeCanonicalGraph(graphCases.get(entry.id))
    const golden = await readFile(new URL(entry.canonical_golden, repository), 'utf8')

    assert.equal(canonical, golden, entry.id)
    assert.equal(sha256(golden), entry.sha256, entry.id)
    assert.equal(loadCanonicalGraph(golden).ok, true, entry.id)
  }
})

test('canonical mutations are rejected after changing serializer-owned bytes', () => {
  for (const entry of corpus.mutation_cases) {
    const source = serializeCanonicalGraph(graphCases.get(entry.graph))
    const candidate = MUTATIONS[entry.operation](source)

    assert.notEqual(candidate, source, entry.id)
    const result = loadCanonicalGraph(candidate)
    assert.deepEqual(project(result), entry.expected, entry.id)
  }
})

test('serializer rejects graph constructs outside its declared slice', () => {
  const original = graphCases.get('CANON-GRAPH-HELLO')
  const mutations = [
    (graph) => { graph.capabilities[0].kind = 'ambient-authority' },
    (graph) => { graph.functions[0].literals[0].type = 'float64' },
    (graph) => { graph.functions[0].statements[0].kind = 'emit' },
    (graph) => { graph.functions[0].statements[0].value.target.kind = 'transport-call' },
    (graph) => { graph.functions[0].regions = [{ kind: 'par' }] },
  ]

  for (const mutate of mutations) {
    const graph = structuredClone(original)
    mutate(graph)
    assert.throws(
      () => serializeCanonicalGraph(graph),
      /unsupported canonical graph construct/,
    )
  }
})

function deterministicUidFactory() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let counter = 0
  return () => {
    let value = counter
    counter += 1
    let prefix = ''
    for (let index = 0; index < 7; index += 1) {
      prefix = alphabet[value % 32] + prefix
      value = Math.floor(value / 32)
    }
    return `${prefix}${'a'.repeat(19)}`
  }
}

function manifestCoverage() {
  return [
    ...CANONICAL_GRAPH_SLICE.literalTypes.map((type) => `literal:${type}`),
    ...CANONICAL_GRAPH_SLICE.identityNodeKinds.map((kind) => `node:${kind}`),
    ...CANONICAL_GRAPH_SLICE.supportKinds.map((kind) => `support:${kind}`),
    ...CANONICAL_GRAPH_SLICE.callTargetKinds.map((kind) => `target:${kind}`),
  ].sort()
}

function collectCoverage(value, coverage) {
  if (Array.isArray(value)) {
    for (const child of value) collectCoverage(child, coverage)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (CANONICAL_GRAPH_SLICE.identityNodeKinds.includes(value.kind)) {
    coverage.add(`node:${value.kind}`)
  }
  if (value.kind === 'literal') {
    coverage.add(
      /^decimal<\d+>$/.test(value.type)
        ? 'literal:decimal<scale>'
        : `literal:${value.type}`,
    )
  }
  if (value.kind === 'call') coverage.add(`target:${value.target.kind}`)
  if (CANONICAL_GRAPH_SLICE.supportKinds.includes(value.kind)) {
    coverage.add(`support:${value.kind}`)
  }
  for (const child of Object.values(value)) collectCoverage(child, coverage)
}

function reverseMatchingLines(source, prefix) {
  const lines = source.split('\n')
  const indexes = lines
    .map((line, index) => line.startsWith(prefix) ? index : -1)
    .filter((index) => index >= 0)
  assert.ok(indexes.length >= 2, prefix)
  const values = indexes.map((index) => lines[index]).reverse()
  indexes.forEach((index, position) => { lines[index] = values[position] })
  return lines.join('\n')
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex')
}

function project(result) {
  if (result.ok) return { ok: true, byte_identical: true }
  return { ok: false, diagnostic: result.diagnostics[0].code }
}
