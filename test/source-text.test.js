import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { decodeUtf8Source } from '../src/toolchain/source-text.js'

test('source decoder accepts exact UTF-8 without rewriting text', () => {
  assert.deepEqual(
    decodeUtf8Source(Buffer.from('re 0.1 compact\n// 中文\n'), { file: 'ok.re' }),
    { ok: true, value: 're 0.1 compact\n// 中文\n' },
  )
})

test('source decoder rejects malformed UTF-8 at a stable byte offset', () => {
  const cases = [
    [Buffer.from([0xc0, 0x80]), 0],
    [Buffer.from([0xe2, 0x28, 0xa1]), 0],
    [Buffer.from([0xf0, 0x9f, 0x92]), 0],
    [Buffer.from([0xed, 0xa0, 0x80]), 0],
  ]

  for (const [bytes, byteOffset] of cases) {
    assert.deepEqual(decodeUtf8Source(bytes, { file: 'bad.re' }), {
      diagnostics: [{
        byte_offset: byteOffset,
        code: 'invalid-utf8-source',
        column: 1,
        file: 'bad.re',
        line: 1,
      }],
      ok: false,
    })
  }
})

test('source decoder rejects a UTF-8 byte order mark explicitly', () => {
  assert.deepEqual(
    decodeUtf8Source(Buffer.from([0xef, 0xbb, 0xbf, 0x72, 0x65]), { file: 'bom.re' }),
    {
      diagnostics: [{
        byte_offset: 0,
        code: 'byte-order-mark-not-allowed',
        column: 1,
        file: 'bom.re',
        line: 1,
      }],
      ok: false,
    },
  )
})
