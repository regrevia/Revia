import { Buffer } from 'node:buffer'

export function decodeUtf8Source(bytes, { file = '<input>' } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('source bytes must be a Uint8Array')
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return failure('byte-order-mark-not-allowed', bytes, 0, file)
  }

  const invalid = invalidUtf8Offset(bytes)
  if (invalid !== null) {
    return failure('invalid-utf8-source', bytes, invalid, file)
  }
  return { ok: true, value: Buffer.from(bytes).toString('utf8') }
}

function invalidUtf8Offset(bytes) {
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index]
    if (first <= 0x7f) {
      index += 1
      continue
    }
    if (first >= 0xc2 && first <= 0xdf) {
      if (!continuations(bytes, index, 1)) return index
      index += 2
      continue
    }
    if (first === 0xe0) {
      if (
        !range(bytes[index + 1], 0xa0, 0xbf) ||
        !continuation(bytes[index + 2])
      ) return index
      index += 3
      continue
    }
    if (
      (first >= 0xe1 && first <= 0xec) ||
      (first >= 0xee && first <= 0xef)
    ) {
      if (!continuations(bytes, index, 2)) return index
      index += 3
      continue
    }
    if (first === 0xed) {
      if (
        !range(bytes[index + 1], 0x80, 0x9f) ||
        !continuation(bytes[index + 2])
      ) return index
      index += 3
      continue
    }
    if (first === 0xf0) {
      if (
        !range(bytes[index + 1], 0x90, 0xbf) ||
        !continuations(bytes, index + 1, 2)
      ) return index
      index += 4
      continue
    }
    if (first >= 0xf1 && first <= 0xf3) {
      if (!continuations(bytes, index, 3)) return index
      index += 4
      continue
    }
    if (first === 0xf4) {
      if (
        !range(bytes[index + 1], 0x80, 0x8f) ||
        !continuations(bytes, index + 1, 2)
      ) return index
      index += 4
      continue
    }
    return index
  }
  return null
}

function continuations(bytes, leadIndex, count) {
  for (let offset = 1; offset <= count; offset += 1) {
    if (!continuation(bytes[leadIndex + offset])) return false
  }
  return true
}

function continuation(byte) {
  return range(byte, 0x80, 0xbf)
}

function range(value, minimum, maximum) {
  return value !== undefined && value >= minimum && value <= maximum
}

function failure(code, bytes, byteOffset, file) {
  const prefix = Buffer.from(bytes.subarray(0, byteOffset)).toString('utf8')
  const lineStart = prefix.lastIndexOf('\n')
  return {
    diagnostics: [{
      byte_offset: byteOffset,
      code,
      column: [...prefix.slice(lineStart + 1)].length + 1,
      file,
      line: [...prefix].filter((character) => character === '\n').length + 1,
    }],
    ok: false,
  }
}
