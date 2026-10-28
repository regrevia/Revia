const DECIMAL_TYPE = /^decimal<(0|[1-9][0-9]{0,2})>$/
const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/

export function decimalType(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 255) {
    throw new TypeError('invalid decimal scale')
  }
  return `decimal<${scale}>`
}

export function decimalScaleFromType(type) {
  if (typeof type !== 'string') return null
  const match = DECIMAL_TYPE.exec(type)
  if (match === null) return null
  const scale = Number(match[1])
  return scale <= 255 ? scale : null
}

export function isCanonicalDecimal(value, scale) {
  if (
    typeof value !== 'string' ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 255
  ) {
    return false
  }
  if (/^-0(?:\.0+)?$/.test(value)) return false
  if (scale === 0) return CANONICAL_INTEGER.test(value)
  return new RegExp(
    `^-?(?:0|[1-9][0-9]*)\\.[0-9]{${scale}}$`,
  ).test(value)
}

export function isCanonicalDecimalLiteral(value, type) {
  const scale = decimalScaleFromType(type)
  return scale !== null && isCanonicalDecimal(value, scale)
}
