import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  canonicalValueBytes,
  typeDeclarationDigest,
  validateTypeDeclaration,
} from '../src/toolchain/type-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/type-value-corpus.json', import.meta.url),
  'utf8',
))

function referenceBytes(type, value) {
  if (type.kind === 'primitive' && type.name === 'text.utf8') value = value.normalize('NFC')
  if (type.kind === 'map') {
    value = [...value].sort((left, right) => compareReferenceKeys(type.key, left.key, right.key))
  }
  if (type.kind === 'set') {
    value = [...value].sort((left, right) => compareReferenceKeys(type.element, left, right))
  }
  return `re.canonical-value@0.1.0\n${stable({ type, value })}\n`
}

function compareReferenceKeys(type, left, right) {
  const numeric = type.kind === 'decimal' ||
    (type.kind === 'primitive' && type.name === 'int')
  const leftValue = numeric ? BigInt(String(left).replace('.', '')) : left
  const rightValue = numeric ? BigInt(String(right).replace('.', '')) : right
  if (type.kind === 'primitive' && type.name === 'bytes') {
    return Buffer.compare(Buffer.from(left.slice(4), 'hex'), Buffer.from(right.slice(4), 'hex'))
  }
  if (type.kind === 'primitive' && type.name === 'text.utf8') {
    return Buffer.compare(Buffer.from(left.normalize('NFC')), Buffer.from(right.normalize('NFC')))
  }
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

test('independent reference oracle agrees on canonical bytes for valid scalar/container corpus', () => {
  const covered = ['TV-001', 'TV-004', 'TV-007', 'TV-012', 'TV-013', 'TV-014']
  for (const entry of corpus.canonical_values.filter(({ id }) => covered.includes(id))) {
    const result = canonicalValueBytes(entry.type, entry.input)
    assert.equal(result.ok, true, entry.id)
    assert.equal(result.bytes, referenceBytes(entry.type, entry.input), entry.id)
  }
})

test('recursive generic data is guarded, finite, and exact-digest bound', () => {
  const unproductive = {
    body: { kind: 'newtype', type: { kind: 'self' } },
    module: 'test.types', name: 'recursive', parameters: [], schema: 're.type-declaration@0.1.0',
  }
  assert.deepEqual(validateTypeDeclaration(unproductive), {
    diagnostics: [{ code: 'unproductive-recursive-type' }],
    ok: false,
  })

  const node = {
    body: {
      fields: [
        { name: 'next', type: { kind: 'option', value: { kind: 'self' } } },
        { name: 'value', type: { kind: 'parameter', name: 'item' } },
      ],
      kind: 'record',
    },
    module: 'test.types',
    name: 'node',
    parameters: ['item'],
    schema: 're.type-declaration@0.1.0',
  }
  const nodeType = {
    arguments: [{ kind: 'primitive', name: 'int' }],
    declaration_digest: typeDeclarationDigest(node),
    kind: 'declared',
  }
  const finite = canonicalValueBytes(nodeType, {
    next: {
      value: { next: { variant: 'none' }, value: '2' },
      variant: 'some',
    },
    value: '1',
  }, [node])
  assert.equal(finite.ok, true)
  assert.match(finite.bytes, /"value":"2"/)

  let deep = { next: { variant: 'none' }, value: '0' }
  for (let index = 1; index < 50; index += 1) {
    deep = { next: { value: deep, variant: 'some' }, value: String(index) }
  }
  const depthFailure = canonicalValueBytes(nodeType, deep, [node])
  assert.equal(depthFailure.ok, false)
  assert.equal(depthFailure.diagnostics[0].code, 'canonical-value-too-deep')

  const missing = canonicalValueBytes({
    arguments: [],
    declaration_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'declared',
  }, 'value', [node])
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'type-declaration-not-found')
})

test('decimal scales and explicit rounding modes remain bounded and exact', () => {
  const invalid = canonicalValueBytes({ kind: 'decimal', scale: 256 }, '1')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.diagnostics[0].code, 'invalid-decimal-scale')
})
