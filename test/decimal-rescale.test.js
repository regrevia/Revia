import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  DECIMAL_ROUNDING_MODES,
  rescaleDecimal,
  validateDecimalRescale,
} from '../src/toolchain/type-contract.js'

const corpus = JSON.parse(await readFile(
  new URL('./fixtures/decimal-rescale-corpus.json', import.meta.url),
  'utf8',
))

test('decimal rescale corpus fixes database, finance, and directed rounding semantics', () => {
  assert.equal(corpus.schema, 're.decimal-rescale-corpus@0.1.0')
  assert.equal(new Set(corpus.workloads.map(({ id }) => id)).size, corpus.workloads.length)
  assert.deepEqual(
    [...new Set(corpus.workloads.map(({ profile }) => profile))].length,
    corpus.workloads.length,
  )
  for (const entry of corpus.workloads) {
    const result = rescaleDecimal(entry.input)
    if (entry.expected.ok) {
      assert.deepEqual(result, entry.expected, entry.id)
    } else {
      assert.equal(result.ok, false, entry.id)
      assert.equal(result.diagnostics[0].code, entry.expected.code, entry.id)
    }
  }
})

test('scale 255 remains exact and does not inherit host floating-point limits', () => {
  const tie = `0.${'0'.repeat(254)}5`
  const rounded = rescaleDecimal({
    from_scale: 255,
    rounding: 'half_even',
    to_scale: 254,
    value: tie,
  })
  assert.deepEqual(rounded, { ok: true, value: `0.${'0'.repeat(254)}` })

  const expanded = rescaleDecimal({
    from_scale: 0,
    rounding: 'exact',
    to_scale: 255,
    value: '1',
  })
  assert.deepEqual(expanded, { ok: true, value: `1.${'0'.repeat(255)}` })
})

test('all rounding modes match an independent rational oracle', () => {
  for (let coefficient = -1000; coefficient <= 1000; coefficient += 1) {
    const value = formatReference(coefficient, 3)
    for (const rounding of DECIMAL_ROUNDING_MODES) {
      const result = rescaleDecimal({
        from_scale: 3,
        rounding,
        to_scale: 2,
        value,
      })
      const expected = referenceRound(coefficient, rounding)
      if (expected === null) {
        assert.equal(result.ok, false, `${value} ${rounding}`)
        assert.equal(result.diagnostics[0].code, 'inexact-decimal-rescale')
      } else {
        assert.deepEqual(result, {
          ok: true,
          value: formatReference(expected, 2),
        }, `${value} ${rounding}`)
      }
    }
  }
})

test('rescale contract rejects missing, unknown, and open-ended rounding claims', () => {
  for (const rounding of DECIMAL_ROUNDING_MODES) {
    assert.deepEqual(validateDecimalRescale({
      from_scale: 3,
      rounding,
      to_scale: 2,
    }), { ok: true })
  }
  const guessed = validateDecimalRescale({
    from_scale: 3,
    rounding: 'host_default',
    to_scale: 2,
  })
  assert.equal(guessed.ok, false)
  assert.equal(guessed.diagnostics[0].code, 'invalid-decimal-rounding-mode')

  const unknown = rescaleDecimal({
    from_scale: 3,
    locale: 'en-US',
    rounding: 'half_even',
    to_scale: 2,
    value: '1.005',
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.diagnostics[0].code, 'unexpected-decimal-rescale-field')
})

function referenceRound(coefficient, mode) {
  const quotient = Math.trunc(coefficient / 10)
  const remainder = coefficient - quotient * 10
  if (remainder === 0) return quotient
  if (mode === 'exact') return null
  if (mode === 'toward_zero') return quotient
  if (mode === 'floor') return Math.floor(coefficient / 10)
  if (mode === 'ceiling') return Math.ceil(coefficient / 10)
  const direction = coefficient < 0 ? -1 : 1
  const magnitude = Math.abs(remainder)
  if (magnitude < 5) return quotient
  if (magnitude > 5 || mode === 'half_away_from_zero') return quotient + direction
  return Math.abs(quotient) % 2 === 0 ? quotient : quotient + direction
}

function formatReference(coefficient, scale) {
  const negative = coefficient < 0
  const digits = String(Math.abs(coefficient)).padStart(scale + 1, '0')
  if (scale === 0) return `${negative ? '-' : ''}${digits}`
  const split = digits.length - scale
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`
}
