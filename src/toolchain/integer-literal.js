const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/

export function isCanonicalInteger(value) {
  return typeof value === 'string' && CANONICAL_INTEGER.test(value)
}

export function decodeCanonicalInteger(text) {
  if (!isCanonicalInteger(text)) {
    return { ok: false, reason: 'syntax' }
  }
  return { ok: true, value: BigInt(text) }
}
