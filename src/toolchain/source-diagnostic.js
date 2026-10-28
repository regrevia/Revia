export const SOURCE_DIAGNOSTIC_SCHEMA = 're.source-diagnostic@0.1.0'

export function createSourceDiagnostic(source, {
  code,
  end,
  file = '<input>',
  phase,
  repair,
  rule,
  start,
  ...details
}) {
  if (typeof source !== 'string') throw new TypeError('diagnostic source must be text')
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('diagnostic code must be non-empty')
  }
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new TypeError('diagnostic phase must be non-empty')
  }
  if (typeof rule !== 'string' || rule.length === 0) {
    throw new TypeError('diagnostic rule must be non-empty')
  }

  const boundedStart = boundOffset(start, source.length)
  const boundedEnd = Math.max(boundedStart, boundOffset(end, source.length))
  return {
    ...details,
    byte_end: Buffer.byteLength(source.slice(0, boundedEnd), 'utf8'),
    byte_start: Buffer.byteLength(source.slice(0, boundedStart), 'utf8'),
    code,
    ...sourcePosition(source, boundedStart, boundedEnd),
    file,
    lexeme: source.slice(boundedStart, boundedEnd),
    phase,
    repair: repair ?? defaultRepair(details.expected, rule),
    rule,
    schema: SOURCE_DIAGNOSTIC_SCHEMA,
    severity: 'error',
  }
}

function defaultRepair(expected, rule) {
  if (expected !== undefined) {
    return {
      action: Array.isArray(expected) ? 'choose' : 'replace',
      expected,
    }
  }
  return { action: 'inspect', rule }
}

function boundOffset(offset, maximum) {
  if (!Number.isSafeInteger(offset)) return 0
  return Math.min(Math.max(offset, 0), maximum)
}

function sourcePosition(source, start, end) {
  const startPosition = positionAt(source, start)
  const endPosition = positionAt(source, end)
  return {
    column: startPosition.column,
    end_column: endPosition.column,
    end_line: endPosition.line,
    line: startPosition.line,
  }
}

function positionAt(source, offset) {
  const before = source.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return {
    column: [...source.slice(lineStart, offset)].length + 1,
    line: [...before].filter((character) => character === '\n').length + 1,
  }
}
