import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { moduleInterfaceDigest } from '../src/toolchain/module-contract.js'
import { lowerModuleSurface } from '../src/toolchain/module-surface.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/module-source-surface-corpus.json', import.meta.url),
  'utf8',
))
const manifest = JSON.parse(await readFile(
  new URL('./fixtures/module-contract-corpus.json', import.meta.url),
  'utf8',
)).manifest
const file = 'fixture.re'

test('module source corpus freezes its lowering and span contracts', () => {
  assert.equal(corpus.schema, 're.module-source-surface-corpus@0.2.0')
  assert.equal(corpus.status, 'lowering-prototype')
  assert.deepEqual(corpus.span_contract, {
    byte_offsets: 'zero-based UTF-8 half-open',
    line_column: 'one-based Unicode scalar positions; tab counts as one scalar',
  })
  assert.equal(new Set(corpus.cases.map(({ id }) => id)).size, corpus.cases.length)
  assert.equal(corpus.cases.length, 18)
})

test('every module source case matches its exact lowering or diagnostic oracle', () => {
  for (const entry of corpus.cases) {
    const result = lowerModuleSurface(entry.source, manifest, { file })
    assert.equal(result.ok, entry.expected.ok, entry.id)
    if (entry.expected.ok) {
      assert.equal(result.value.interface_digest, entry.expected.interface_digest, entry.id)
      assert.equal(
        moduleInterfaceDigest(result.value.interface),
        entry.expected.interface_digest,
        entry.id,
      )
      continue
    }
    const { lexeme, ...expectedDiagnostic } = entry.expected.diagnostic
    assert.deepEqual(result.diagnostics[0], { file, ...expectedDiagnostic }, entry.id)
    assert.equal(
      Buffer.from(entry.source).subarray(
        expectedDiagnostic.byte_start,
        expectedDiagnostic.byte_end,
      ).toString('utf8'),
      lexeme,
      entry.id,
    )
    assertSpanCoordinates(entry.source, expectedDiagnostic, entry.id)
  }
})

test('declaration order cannot change the lowered Module interface', () => {
  const first = lowerModuleSurface(corpus.cases[0].source, manifest, { file })
  const reordered = lowerModuleSurface(corpus.cases[1].source, manifest, { file })

  assert.equal(first.ok, true)
  assert.equal(reordered.ok, true)
  assert.deepEqual(reordered.value, first.value)
})

test('unknown suffixes fail closed instead of preserving a successful prefix', () => {
  const source = `${corpus.cases[0].source}future_construct value\n`
  const result = lowerModuleSurface(source, manifest, { file })

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'unsupported-module-surface-construct')
  assert.equal(result.diagnostics[0].line, 6)
})

test('duplicate identity outranks pin mismatch regardless of declaration order', () => {
  const exact = 'import agent.relay.service@sha256:6cbfa0a9e364b386c5f6015b90a3bc4d962062b4ba553ad25e43f0bcf03fe71c as service'
  const stale = `import agent.relay.service@sha256:${'f'.repeat(64)} as service`
  const remainder = corpus.cases[0].source.split('\n').slice(3).join('\n')

  for (const declarations of [[exact, stale], [stale, exact]]) {
    const source = [
      're 1.0 compact',
      'module agent.relay.api',
      ...declarations,
      remainder,
    ].join('\n')
    const result = lowerModuleSurface(source, manifest, { file })
    assert.equal(result.ok, false)
    assert.equal(result.diagnostics[0].code, 'duplicate-module-binding')
  }
})

test('UTF-8 byte offsets and scalar line/column positions remain distinct', () => {
  const entry = corpus.cases.find(({ id }) => id === 'SRC-011')
  const result = lowerModuleSurface(entry.source, manifest, { file })
  const codeUnitOffset = entry.source.indexOf('teleport')

  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].byte_start, 357)
  assert.ok(result.diagnostics[0].byte_start > codeUnitOffset)
  assert.equal(result.diagnostics[0].column, 1)
})

function assertSpanCoordinates(source, diagnostic, id) {
  const bytes = Buffer.from(source)
  const before = bytes.subarray(0, diagnostic.byte_start).toString('utf8')
  const selected = bytes
    .subarray(diagnostic.byte_start, diagnostic.byte_end)
    .toString('utf8')
  const lines = before.split('\n')
  assert.equal(diagnostic.line, lines.length, id)
  assert.equal(diagnostic.column, [...lines.at(-1)].length + 1, id)
  const selectedLines = selected.split('\n')
  assert.equal(
    diagnostic.end_line,
    diagnostic.line + selectedLines.length - 1,
    id,
  )
  assert.equal(
    diagnostic.end_column,
    selectedLines.length === 1
      ? diagnostic.column + [...selected].length
      : [...selectedLines.at(-1)].length + 1,
    id,
  )
}
