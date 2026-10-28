import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  canonicalValueBytes,
  canonicalizeValue,
  DECIMAL_ROUNDING_MODES,
  isCanonicalKeyType,
  typeDeclarationDigest,
  validateDecimalRescale,
  validateTypeDeclaration,
} from '../src/toolchain/type-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/type-value-corpus.json', import.meta.url),
  'utf8',
))
const int = { kind: 'primitive', name: 'int' }
const text = { kind: 'primitive', name: 'text.utf8' }

const userId = {
  body: { kind: 'newtype', type: int },
  module: 'agent.relay.core',
  name: 'user_id',
  parameters: [],
  schema: 're.type-declaration@0.1.0',
}
const envelope = {
  body: {
    fields: [
      { name: 'value', type: { kind: 'parameter', name: 'item' } },
      { name: 'label', type: text },
    ],
    kind: 'record',
  },
  module: 'agent.relay.core',
  name: 'envelope',
  parameters: ['item'],
  schema: 're.type-declaration@0.1.0',
}
const event = {
  body: {
    kind: 'sum',
    variants: [
      { name: 'stopped' },
      { name: 'message', type: text },
    ],
  },
  module: 'agent.relay.core',
  name: 'event',
  parameters: [],
  schema: 're.type-declaration@0.1.0',
}
const currency = {
  body: {
    kind: 'sum',
    variants: [
      { name: 'usd' },
      { name: 'cny' },
    ],
  },
  module: 'agent.expense.intake',
  name: 'currency',
  parameters: [],
  schema: 're.type-declaration@0.1.0',
}

test('type/value corpus fixes the P0-04 numeric and key decisions', () => {
  assert.equal(corpus.schema, 're.type-value-corpus@0.1.0')
  assert.match(corpus.decisions.int, /arbitrary-precision/)
  assert.match(corpus.decisions.decimal, /rounding mode/)
  assert.equal(corpus.decisions.float, 'deferred from V1 Core')
  assert.equal(new Set(corpus.canonical_values.map(({ id }) => id)).size,
    corpus.canonical_values.length)
})

test('every canonical value case matches its exact oracle', () => {
  for (const entry of corpus.canonical_values) {
    const result = canonicalizeValue(entry.type, entry.input)
    if (entry.expected.ok) {
      assert.deepEqual(result, entry.expected, entry.id)
    } else {
      assert.equal(result.ok, false, entry.id)
      assert.equal(result.diagnostics[0].code, entry.expected.code, entry.id)
    }
  }
})

test('int magnitude and decimal scale boundaries do not inherit host Number limits', () => {
  const magnitudes = [
    '0',
    '-1',
    String(2 ** 53),
    `1${'0'.repeat(4096)}`,
    `-1${'0'.repeat(4096)}`,
  ]
  for (const value of magnitudes) {
    assert.deepEqual(canonicalizeValue(int, value), { ok: true, value })
  }

  const scale255 = { kind: 'decimal', scale: 255 }
  const exact = `0.${'0'.repeat(254)}1`
  assert.deepEqual(canonicalizeValue(scale255, exact), { ok: true, value: exact })
  const overScale = canonicalizeValue({ kind: 'decimal', scale: 256 }, '0')
  assert.equal(overScale.ok, false)
  assert.equal(overScale.diagnostics[0].code, 'invalid-decimal-scale')
})

test('nominal declaration digest ignores field/variant order but preserves identity', () => {
  const reordered = structuredClone(envelope)
  reordered.body.fields.reverse()
  assert.equal(typeDeclarationDigest(reordered), typeDeclarationDigest(envelope))

  const renamed = structuredClone(userId)
  renamed.name = 'account_id'
  assert.notEqual(typeDeclarationDigest(renamed), typeDeclarationDigest(userId))

  const reorderedVariants = structuredClone(event)
  reorderedVariants.body.variants.reverse()
  assert.equal(typeDeclarationDigest(reorderedVariants), typeDeclarationDigest(event))
})

test('record, sum, and explicit generic instantiation share one declaration registry', () => {
  const envelopeType = {
    arguments: [int],
    declaration_digest: typeDeclarationDigest(envelope),
    kind: 'declared',
  }
  assert.deepEqual(canonicalizeValue(envelopeType, {
    value: '9007199254740993',
    label: 'exact',
  }, [envelope]), {
    ok: true,
    value: { label: 'exact', value: '9007199254740993' },
  })

  const eventType = {
    arguments: [],
    declaration_digest: typeDeclarationDigest(event),
    kind: 'declared',
  }
  assert.deepEqual(canonicalizeValue(eventType, { variant: 'message', value: 'ok' }, [event]), {
    ok: true,
    value: { value: 'ok', variant: 'message' },
  })
  const wrongArity = canonicalizeValue({ ...envelopeType, arguments: [] }, {}, [envelope])
  assert.equal(wrongArity.ok, false)
  assert.equal(wrongArity.diagnostics[0].code, 'type-argument-arity-mismatch')
})

test('expense currency is a source-owned nominal closed sum', () => {
  const currencyType = {
    arguments: [],
    declaration_digest: typeDeclarationDigest(currency),
    kind: 'declared',
  }
  for (const variant of ['usd', 'cny']) {
    assert.deepEqual(
      canonicalizeValue(currencyType, { variant }, [currency]),
      { ok: true, value: { variant } },
    )
  }
  for (const input of [
    'USD',
    { variant: 'eur' },
    { variant: 'usd', value: 'legacy' },
  ]) {
    assert.equal(canonicalizeValue(currencyType, input, [currency]).ok, false)
  }

  const reordered = structuredClone(currency)
  reordered.body.variants.reverse()
  assert.equal(typeDeclarationDigest(reordered), typeDeclarationDigest(currency))

  const regionalCurrency = structuredClone(currency)
  regionalCurrency.module = 'agent.expense.brazil'
  regionalCurrency.body.variants = [{ name: 'brl' }]
  const regionalType = {
    arguments: [],
    declaration_digest: typeDeclarationDigest(regionalCurrency),
    kind: 'declared',
  }
  assert.deepEqual(
    canonicalizeValue(regionalType, { variant: 'brl' }, [regionalCurrency]),
    { ok: true, value: { variant: 'brl' } },
  )
})

test('canonical value bytes ignore input object and declaration member order', () => {
  const envelopeType = {
    arguments: [int],
    declaration_digest: typeDeclarationDigest(envelope),
    kind: 'declared',
  }
  const reordered = structuredClone(envelope)
  reordered.body.fields.reverse()
  const first = canonicalValueBytes(envelopeType, {
    value: '9007199254740993',
    label: 'exact',
  }, [envelope])
  const second = canonicalValueBytes(envelopeType, {
    label: 'exact',
    value: '9007199254740993',
  }, [reordered])
  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  assert.match(first.bytes, /^re\.canonical-value@0\.1\.0\n/)
})

test('record and sum values reject missing, excess, and unknown shapes', () => {
  const envelopeType = {
    arguments: [int],
    declaration_digest: typeDeclarationDigest(envelope),
    kind: 'declared',
  }
  const missing = canonicalizeValue(envelopeType, { label: 'missing' }, [envelope])
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'missing-record-field')

  const excess = canonicalizeValue(envelopeType, {
    label: 'extra',
    value: '1',
    guessed: true,
  }, [envelope])
  assert.equal(excess.ok, false)
  assert.equal(excess.diagnostics[0].code, 'unexpected-record-field')

  const eventType = {
    arguments: [],
    declaration_digest: typeDeclarationDigest(event),
    kind: 'declared',
  }
  const unknown = canonicalizeValue(eventType, { variant: 'guessed' }, [event])
  assert.equal(unknown.ok, false)
  assert.equal(unknown.diagnostics[0].code, 'unknown-sum-variant')
})

test('only stable total-order scalar types and their newtypes are keys', () => {
  const userIdType = {
    arguments: [],
    declaration_digest: typeDeclarationDigest(userId),
    kind: 'declared',
  }
  assert.equal(isCanonicalKeyType(userIdType, [userId]), true)
  assert.equal(isCanonicalKeyType({ kind: 'option', value: int }), false)
  assert.equal(isCanonicalKeyType({ kind: 'primitive', name: 'unit' }), false)
  assert.equal(isCanonicalKeyType({ kind: 'resource', name: 'file',
    contract_digest: `sha256:${'a'.repeat(64)}` }), false)
})

test('text key equality uses NFC before sorting and duplicate detection', () => {
  const result = canonicalizeValue({
    element: text,
    kind: 'set',
  }, ['é', 'é'])
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics[0].code, 'duplicate-canonical-set-element')
})

test('text.utf8 rejects isolated UTF-16 surrogates before key comparison', () => {
  const scalar = canonicalizeValue(text, '\ud800')
  assert.equal(scalar.ok, false)
  assert.equal(scalar.diagnostics[0].code, 'invalid-text-value')

  const keys = canonicalizeValue({ element: text, kind: 'set' }, ['\ud800', '�'])
  assert.equal(keys.ok, false)
  assert.equal(keys.diagnostics[0].code, 'invalid-text-value')
})

test('type declarations fail closed on duplicate members and unknown fields', () => {
  const duplicate = structuredClone(event)
  duplicate.body.variants.push({ name: 'stopped' })
  assert.deepEqual(validateTypeDeclaration(duplicate), {
    diagnostics: [{ code: 'duplicate-variant', name: 'stopped' }],
    ok: false,
  })
  const guessed = structuredClone(userId)
  guessed.structural = true
  assert.deepEqual(validateTypeDeclaration(guessed), {
    diagnostics: [{ code: 'unexpected-type-declaration-field', field: 'structural' }],
    ok: false,
  })
})

test('lossy decimal rescale always names one closed rounding mode', () => {
  assert.deepEqual(DECIMAL_ROUNDING_MODES, [
    'exact',
    'toward_zero',
    'floor',
    'ceiling',
    'half_even',
    'half_away_from_zero',
  ])
  assert.deepEqual(validateDecimalRescale({
    from_scale: 4,
    rounding: 'half_even',
    to_scale: 2,
  }), { ok: true })
  const missing = validateDecimalRescale({ from_scale: 4, to_scale: 2 })
  assert.equal(missing.ok, false)
  assert.equal(missing.diagnostics[0].code, 'invalid-decimal-rounding-mode')
  assert.deepEqual(validateDecimalRescale(null), {
    diagnostics: [{ code: 'invalid-decimal-rescale' }],
    ok: false,
  })
})
