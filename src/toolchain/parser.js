import { parseExecutableGrammar } from './executable-grammar.js'
import { isCanonicalBytes } from './bytes-literal.js'
import { tokenizeCompactSource } from './compact-lexer.js'
import { decimalType } from './decimal-literal.js'
import { isCompactAliasToken } from './grammar-peg.js'
import {
  decodeV1NumericLiteral,
  looksLikeNumericLiteral,
} from './numeric-literal.js'
import { createSourceDiagnostic } from './source-diagnostic.js'

export function parseProgram(source, { file = '<input>' } = {}) {
  const grammar = parseExecutableGrammar(source, { file })
  if (!grammar.ok) return grammar
  if (grammar.value.kind !== 'compact') {
    return {
      diagnostics: [createSourceDiagnostic(source, {
        actual: grammar.value.kind,
        code: 'unexpected-source-form',
        end: source.indexOf('\n'),
        expected: 'compact',
        file,
        phase: 'dispatch',
        rule: 'header.source-form',
        start: 0,
      })],
      ok: false,
    }
  }
  return parseCompactProgramBody(
    source.slice(grammar.value.bodyOffset),
    {
      file,
      fullSource: source,
      lineOffset: 1,
      sourceOffset: grammar.value.bodyOffset,
      version: grammar.value.version,
    },
  )
}

export function parseCompactProgramBody(
  source,
  {
    file = '<input>',
    fullSource = source,
    lineOffset = 1,
    sourceOffset = 0,
    version = '0.1',
  } = {},
) {
  const tokenized = tokenizeCompactSource(source, {
    file,
    fullSource,
    sourceOffset,
    startLine: lineOffset + 1,
  })
  if (!tokenized.ok) return tokenized

  try {
    const cursor = new Cursor(tokenized.tokens, file, fullSource)
    cursor.expect('unit')
    const unit = cursor.take('unit identity')

    const capabilities = []
    while (cursor.peek().text === 'cap') {
      const cap = cursor.expect('cap')
      const instance = cursor.take('capability instance')
      cursor.expect(':')
      const reference = cursor.take('schema reference')
      capabilities.push({
        kind: 'cap',
        instance: instance.text,
        location: locationOf(cap, file),
        reference: reference.text,
      })
    }

    cursor.expect('fn')
    const functionName = cursor.take('function name')
    cursor.expect('(')
    cursor.expect(')')
    cursor.expect('->')
    const returnType = cursor.take('return type')
    cursor.expect('{')
    const statements = []
    while (cursor.peek().text !== '}') {
      statements.push(
        parseStatement(cursor, file, capabilities, statements.length),
      )
    }
    cursor.expect('}')
    cursor.expectEnd()

    return {
      ok: true,
      value: {
        capabilities,
        functions: [{
          kind: 'function',
          location: locationOf(functionName, file),
          name: functionName.text,
          returnType: returnType.text,
          statements,
        }],
        unit: unit.text,
        version,
      },
    }
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { diagnostics: [error.diagnostic], ok: false }
    }
    throw error
  }
}

function parseStatement(cursor, file, capabilities, index) {
  const token = cursor.peek()
  if (token.text.startsWith('%')) {
    const binding = takeCompactAlias(cursor, 'value binding')
    cursor.expect('=')
    return {
      binding: binding.text,
      id: `statement:${index}`,
      kind: 'let',
      location: locationOf(binding, file),
      value: parseCall(cursor, file, capabilities),
    }
  }
  if (token.text === 'return') {
    const returnToken = cursor.expect('return')
    return {
      id: `statement:${index}`,
      kind: 'return',
      location: locationOf(returnToken, file),
      value: parseMatch(cursor, file, capabilities),
    }
  }
  cursor.fail(token, 'let or return statement')
}

function parseMatch(cursor, file, capabilities) {
  const matchToken = cursor.expect('match')
  const input = takeCompactAlias(cursor, 'matched value')
  cursor.expect('{')
  const branches = []
  while (cursor.peek().text !== '}') {
    const variant = cursor.take('match variant')
    cursor.expect('(')
    cursor.expect('_')
    cursor.expect(')')
    cursor.expect('=>')
    branches.push({
      kind: 'match-branch',
      location: locationOf(variant, file),
      value: parseCall(cursor, file, capabilities),
      variant: variant.text,
    })
  }
  cursor.expect('}')
  return {
    branches,
    input: {
      kind: 'value-reference',
      location: locationOf(input, file),
      name: input.text,
    },
    kind: 'match',
    location: locationOf(matchToken, file),
  }
}

function parseCall(cursor, file, capabilities) {
  const operation = cursor.take('operation call')
  const memberSeparator = operation.text.lastIndexOf('.')
  let target
  if (operation.text.startsWith('@') && memberSeparator > 1) {
    const instance = operation.text.slice(0, memberSeparator)
    const capability = capabilities.find(
      (candidate) => candidate.instance === instance,
    )
    target = {
      instance,
      kind: 'capability-member',
      member: operation.text.slice(memberSeparator + 1),
      schemaReference: capability?.reference ?? null,
    }
  } else if (operation.text === 'process.exit') {
    target = {
      kind: 'pure-operation',
      operation: operation.text,
      schemaReference: 'process.exit@0.1.0',
    }
  } else {
    cursor.fail(
      operation,
      operation.text.startsWith('@') ? '@instance.member' : 'process.exit',
    )
  }

  cursor.expect('(')
  const arguments_ = []
  while (cursor.peek().text !== ')') {
    const argument = takeCallArgument(cursor, 'call argument')
    const literal = parseLiteral(
      cursor,
      argument.value,
      target,
      argument.name?.text ?? null,
    )
    arguments_.push(argumentValue(argument, literal, file))
    if (cursor.peek().text !== ',') break
    cursor.expect(',')
    if (cursor.peek().text === ')') cursor.fail(cursor.peek(), 'call argument')
  }
  cursor.expect(')')
  return {
    arguments: arguments_,
    kind: 'call',
    location: locationOf(operation, file),
    target,
  }
}

function parseLiteral(cursor, token, target, argumentName) {
  if (isBytesArgument(target, argumentName)) {
    if (token.kind !== 'string' || !isCanonicalBytes(token.value)) {
      cursor.fail(
        token,
        'bytes literal hex:<lowercase-even-hex>',
        'invalid-bytes-literal',
      )
    }
    return {
      kind: 'literal',
      type: 'bytes',
      value: token.value,
    }
  }
  if (token.kind === 'string') {
    if (target.kind === 'pure-operation' && target.operation === 'process.exit') {
      cursor.fail(token, 'process exit code integer')
    }
    return {
      kind: 'literal',
      type: contextualStringType(target, argumentName),
      value: token.value.normalize('NFC'),
    }
  }
  if (isTextEncodingArgument(target, argumentName)) {
    if (token.text !== 'text.encoding.utf8') {
      cursor.fail(
        token,
        'text.encoding.utf8',
        'unsupported-text-encoding',
      )
    }
    return {
      kind: 'literal',
      type: 'text.encoding',
      value: token.text,
    }
  }
  if (looksLikeNumericLiteral(token.text)) {
    const numeric = decodeV1NumericLiteral(token.text)
    if (!numeric.ok) {
      cursor.fail(
        token,
        'canonical int or fixed-scale decimal',
        'invalid-numeric-literal',
        { reason: numeric.reason },
      )
    }
    if (
      numeric.kind === 'decimal-literal' &&
      numeric.scale > 255
    ) {
      cursor.fail(
        token,
        'decimal scale 1..255',
        'decimal-scale-out-of-range',
        { scale: numeric.scale },
      )
    }
    return {
      kind: 'literal',
      type:
        numeric.kind === 'decimal-literal'
          ? decimalType(numeric.scale)
          : 'int',
      value: numeric.value,
    }
  }
  cursor.fail(
    token,
    target.kind === 'pure-operation' && target.operation === 'process.exit'
      ? 'process exit code integer'
      : 'literal',
  )
}

function isBytesArgument(target, argumentName) {
  return (
    target.kind === 'capability-member' &&
    target.schemaReference === 'fs.write@0.1.0' &&
    target.member === 'write_file' &&
    argumentName === 'data'
  )
}

function isTextEncodingArgument(target, argumentName) {
  return (
    target.kind === 'capability-member' &&
    target.schemaReference === 'fs.read@0.1.0' &&
    target.member === 'read_file' &&
    argumentName === 'encoding'
  )
}

function contextualStringType(target, argumentName) {
  if (
    target.kind === 'capability-member' &&
    target.schemaReference === 'fs.read@0.1.0' &&
    target.member === 'read_file'
  ) {
    if (argumentName === null || argumentName === 'path') return 'fs.path'
    if (argumentName === 'encoding') return 'text.encoding'
  }
  if (
    target.kind === 'capability-member' &&
    target.schemaReference === 'fs.write@0.1.0' &&
    target.member === 'write_file' &&
    argumentName === 'path'
  ) {
    return 'fs.path'
  }
  return 'text.utf8'
}

function takeCallArgument(cursor, expected) {
  const first = cursor.take(expected)
  if (cursor.peek().text !== ':') return { name: null, value: first }
  cursor.expect(':')
  return { name: first, value: cursor.take(expected) }
}

function takeCompactAlias(cursor, expected) {
  const token = cursor.take(expected)
  if (!isCompactAliasToken(token.text)) {
    const code = token.text.startsWith('%u')
      ? 'reserved-canonical-label'
      : 'unexpected-token'
    cursor.fail(token, 'compact alias not starting with %u', code)
  }
  return token
}

function argumentValue(argument, literal, file) {
  return {
    location: locationOf(argument.name ?? argument.value, file),
    name: argument.name?.text ?? null,
    // Inline compact literal: a creator lowers this into a literal graph node
    // and replaces it with a value edge. The parser assigns no stable identity.
    literal,
  }
}

class Cursor {
  #file
  #index = 0
  #source
  #tokens

  constructor(tokens, file, source) {
    this.#tokens = tokens
    this.#file = file
    this.#source = source
  }

  expect(text) {
    const token = this.peek()
    if (token.text !== text) this.fail(token, text)
    this.#index += 1
    return token
  }

  expectEnd() {
    const token = this.peek()
    if (token.kind !== 'end') this.fail(token, 'end of file')
  }

  fail(token, expected, code = 'unexpected-token', details = {}) {
    throw new ParseFailure(createSourceDiagnostic(this.#source, {
      ...details,
      actual: token.kind === 'end' ? 'end of file' : token.text,
      code,
      end: token.end,
      expected,
      file: this.#file,
      phase: 'parse',
      rule: productionDiagnosticRule(code),
      start: token.start,
    }))
  }

  peek() {
    return this.#tokens[this.#index]
  }

  take(expected) {
    const token = this.peek()
    if (token.kind === 'end') this.fail(token, expected)
    this.#index += 1
    return token
  }
}

class ParseFailure extends Error {
  constructor(diagnostic) {
    super(diagnostic.code)
    this.diagnostic = diagnostic
  }
}

function locationOf(token, file) {
  return { column: token.column, file, line: token.line }
}

function productionDiagnosticRule(code) {
  return ({
    'decimal-scale-out-of-range': 'compact.decimal-literal',
    'invalid-numeric-literal': 'compact.numeric-literal',
    'reserved-canonical-label': 'compact.alias',
    'invalid-bytes-literal': 'compact.bytes-literal',
    'unsupported-text-encoding': 'compact.text-encoding-literal',
    'unexpected-token': 'compact.token-role',
  })[code] ?? 'compact.parse'
}
