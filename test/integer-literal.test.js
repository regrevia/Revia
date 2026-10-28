import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeCanonicalInteger,
  isCanonicalInteger,
} from '../src/toolchain/integer-literal.js'

test('canonical integers preserve arbitrary precision and sign', () => {
  for (const text of [
    '0',
    '-1',
    '9007199254740992',
    '-99999999999999999999999999999999999999',
  ]) {
    assert.equal(isCanonicalInteger(text), true, text)
    assert.deepEqual(decodeCanonicalInteger(text), {
      ok: true,
      value: BigInt(text),
    })
  }
})

test('canonical integers reject non-canonical syntax before conversion', () => {
  for (const text of ['-0', '+1', '01', '1.0', '1e3', '']) {
    assert.equal(isCanonicalInteger(text), false, text)
    assert.deepEqual(decodeCanonicalInteger(text), {
      ok: false,
      reason: 'syntax',
    }, text)
  }
})
