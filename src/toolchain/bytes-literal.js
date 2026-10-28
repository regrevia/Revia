import { Buffer } from 'node:buffer'

const CANONICAL_BYTES = /^hex:(?:[0-9a-f]{2})*$/

export function isCanonicalBytes(value) {
  return typeof value === 'string' && CANONICAL_BYTES.test(value)
}

export function decodeCanonicalBytes(value) {
  if (!isCanonicalBytes(value)) {
    throw new TypeError('invalid canonical bytes')
  }
  return Uint8Array.from(Buffer.from(value.slice(4), 'hex'))
}
