import {
  COMPACT_TRIVIA_POLICY,
  V1_SOURCE_BOUNDARY_POLICY,
} from './grammar-peg.js'
import { createSourceDiagnostic } from './source-diagnostic.js'

export function tokenizeCompactSource(source, {
  file = '<input>',
  fullSource = source,
  grammar,
  sourceOffset = 0,
  startLine = 1,
} = {}) {
  const tokens = []
  let column = 1
  let index = 0
  let line = startLine

  const advance = () => {
    const character = source[index]
    index += 1
    if (character === '\n') {
      column = 1
      line += 1
    } else {
      column += 1
    }
    return character
  }

  while (index < source.length) {
    const character = source[index]
    if (isCompactWhitespace(character)) {
      advance()
      continue
    }
    if (isUnicodeWhitespace(character)) {
      return failure(fullSource, 'non-ascii-compact-trivia', {
        actual: formatCodePoint(character),
        end: sourceOffset + index + character.length,
        expected: 'ASCII space, tab, or LF',
        file,
        grammar,
        rule: 'compact.trivia',
        start: sourceOffset + index,
      })
    }
    if (source.startsWith(COMPACT_TRIVIA_POLICY.lineCommentPrefix, index)) {
      while (index < source.length && source[index] !== '\n') {
        if (isForbiddenCommentWhitespace(source[index])) {
          const forbidden = source[index]
          return failure(fullSource, 'non-ascii-compact-trivia', {
            actual: formatCodePoint(forbidden),
            end: sourceOffset + index + forbidden.length,
            expected: 'ASCII space, tab, or LF',
            file,
            grammar,
            rule: 'compact.trivia',
            start: sourceOffset + index,
          })
        }
        advance()
      }
      continue
    }
    if (source.startsWith(V1_SOURCE_BOUNDARY_POLICY.annotation.prefix, index)) {
      return failure(fullSource, V1_SOURCE_BOUNDARY_POLICY.annotation.code, {
        actual: V1_SOURCE_BOUNDARY_POLICY.annotation.prefix,
        end: sourceOffset + index + V1_SOURCE_BOUNDARY_POLICY.annotation.prefix.length,
        expected: 'annotations are deferred beyond V1',
        file,
        grammar,
        repair: { action: 'remove' },
        rule: 'compact.annotation',
        start: sourceOffset + index,
      })
    }

    const tokenColumn = column
    const tokenLine = line
    const tokenStart = sourceOffset + index
    const pairedSymbol = ['->', '=>'].find((symbol) =>
      source.startsWith(symbol, index),
    )
    if (pairedSymbol !== undefined) {
      advance()
      advance()
      tokens.push(token(
        pairedSymbol,
        'symbol',
        tokenStart,
        sourceOffset + index,
        tokenLine,
        tokenColumn,
      ))
      continue
    }
    if ('(){}:,='.includes(character)) {
      const text = advance()
      tokens.push(token(
        text,
        'symbol',
        tokenStart,
        sourceOffset + index,
        tokenLine,
        tokenColumn,
      ))
      continue
    }
    if (character === '"') {
      let raw = advance()
      let closed = false
      while (index < source.length) {
        const next = advance()
        raw += next
        if (next === '\\' && index < source.length) {
          raw += advance()
          continue
        }
        if (next === '"') {
          closed = true
          break
        }
      }
      if (!closed) {
        return failure(fullSource, 'unterminated-string', {
          end: sourceOffset + index,
          expected: '"',
          file,
          grammar,
          repair: { action: 'insert', expected: '"' },
          rule: 'compact.string-literal',
          start: tokenStart,
        })
      }
      try {
        tokens.push({
          ...token(
            raw,
            'string',
            tokenStart,
            sourceOffset + index,
            tokenLine,
            tokenColumn,
          ),
          value: JSON.parse(raw),
        })
      } catch {
        return failure(fullSource, 'invalid-string-literal', {
          end: sourceOffset + index,
          expected: 'JSON string escape',
          file,
          grammar,
          rule: 'compact.string-literal',
          start: tokenStart,
        })
      }
      continue
    }

    let text = ''
    while (
      index < source.length &&
      !isCompactWhitespace(source[index]) &&
      !isUnicodeWhitespace(source[index]) &&
      !'(){}:,="'.includes(source[index]) &&
      !source.startsWith(COMPACT_TRIVIA_POLICY.lineCommentPrefix, index) &&
      !source.startsWith(V1_SOURCE_BOUNDARY_POLICY.annotation.prefix, index) &&
      !source.startsWith('->', index) &&
      !source.startsWith('=>', index)
    ) {
      text += advance()
    }
    if (text.length === 0) {
      return failure(fullSource, 'invalid-character', {
        end: sourceOffset + index + character.length,
        file,
        grammar,
        repair: { action: 'remove' },
        rule: 'compact.token',
        start: tokenStart,
      })
    }
    tokens.push(token(
      text,
      'atom',
      tokenStart,
      sourceOffset + index,
      tokenLine,
      tokenColumn,
    ))
  }

  tokens.push(token(
    '',
    'end',
    sourceOffset + index,
    sourceOffset + index,
    line,
    column,
  ))
  return { ok: true, tokens }
}

function failure(source, code, context) {
  const details = { ...context }
  if (details.grammar === undefined) delete details.grammar
  return {
    diagnostics: [createSourceDiagnostic(source, {
      code,
      ...details,
      phase: 'lex',
    })],
    ok: false,
  }
}

function token(text, kind, start, end, line, column) {
  return { column, end, kind, line, start, text }
}

function isCompactWhitespace(character) {
  return COMPACT_TRIVIA_POLICY.whitespaceCodePoints.includes(
    character.codePointAt(0),
  )
}

function isUnicodeWhitespace(character) {
  return /\p{White_Space}/u.test(character)
}

function isForbiddenCommentWhitespace(character) {
  return isUnicodeWhitespace(character) && !isCompactWhitespace(character)
}

function formatCodePoint(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}
