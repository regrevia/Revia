const INTEGER = /^-?(?:0|[1-9][0-9]*)$/
const DECIMAL = /^-?(?:0|[1-9][0-9]*)\.([0-9]+)$/

export const V1_NUMERIC_TOKEN_CONTRACT = Object.freeze({
  decimal: '-?(0|[1-9][0-9]*) "." [0-9]+',
  digitSeparator: false,
  exponent: false,
  int: '-?(0|[1-9][0-9]*)',
  leadingPlus: false,
  negativeZero: false,
})

export function decodeV1NumericLiteral(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return rejected('syntax')
  }
  if (text.startsWith('+')) return rejected('leading-plus')
  if (/[eE]/.test(text)) return rejected('exponent')
  if (text.includes('_')) return rejected('digit-separator')
  if (/^-0(?:\.0+)?$/.test(text)) return rejected('negative-zero')
  if (/^-?0[0-9]/.test(text)) return rejected('leading-zero')

  const decimal = DECIMAL.exec(text)
  if (decimal !== null) {
    return {
      kind: 'decimal-literal',
      ok: true,
      scale: decimal[1].length,
      value: text,
    }
  }
  if (INTEGER.test(text)) {
    return {
      kind: 'int-literal',
      ok: true,
      value: text,
    }
  }
  return rejected(text.includes('.') ? 'decimal-shape' : 'syntax')
}

export function looksLikeNumericLiteral(text) {
  return typeof text === 'string' && /^[+\-.0-9]/.test(text)
}

function rejected(reason) {
  return { ok: false, reason }
}
