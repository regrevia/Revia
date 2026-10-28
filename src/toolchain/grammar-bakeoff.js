import { parseExecutableGrammar } from './executable-grammar.js'
import {
  CANDIDATE_LEXEMES,
  isCompactAliasToken,
} from './grammar-peg.js'
import { tokenizeCompactSource } from './compact-lexer.js'
import {
  decodeV1NumericLiteral,
  looksLikeNumericLiteral,
} from './numeric-literal.js'
import { createSourceDiagnostic } from './source-diagnostic.js'

// This parser is an isolated bake-off instrument. Production source decoding
// continues to use parseExecutableSource until a candidate passes G0-G6.

const SEGMENT = '[a-z][a-z0-9_]*'
const QUALIFIED = `${SEGMENT}(?:\\.${SEGMENT})*`
const SEMVER_PART = '(?:0|[1-9][0-9]*)'
const SCHEMA_REFERENCE = new RegExp(
  `^(${QUALIFIED})@(${SEMVER_PART}\\.${SEMVER_PART}\\.${SEMVER_PART})$`,
)

const PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(CANDIDATE_LEXEMES).map(([candidate, lexemes]) => [
    candidate,
    buildProfile(lexemes),
  ]),
))

export function parseGrammarCandidate(
  source,
  { file = '<bakeoff>', grammar } = {},
) {
  const profile = PROFILES[grammar]
  if (profile === undefined) {
    return failure(createSourceDiagnostic(source, {
      actual: grammar,
      code: 'unknown-grammar-candidate',
      end: 0,
      expected: ['S1', 'S2'],
      file,
      grammar,
      phase: 'candidate-selection',
      rule: 'grammar.profile',
      start: 0,
    }))
  }

  const header = parseExecutableGrammar(source, { file })
  if (!header.ok) {
    return {
      ...header,
      diagnostics: header.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        grammar,
        phase: 'header',
      })),
    }
  }
  if (header.value.kind !== 'compact') {
    return failure(createSourceDiagnostic(source, {
      actual: header.value.kind,
      code: 'unsupported-bakeoff-source-form',
      end: source.indexOf('\n'),
      expected: 'compact',
      file,
      grammar,
      phase: 'dispatch',
      rule: 'header.source-form',
      start: 0,
    }))
  }

  const tokenized = tokenizeCompactSource(
    source.slice(header.value.bodyOffset),
    {
      file,
      fullSource: source,
      grammar,
      sourceOffset: header.value.bodyOffset,
      startLine: 2,
    },
  )
  if (!tokenized.ok) return tokenized

  try {
    const cursor = new CandidateCursor(tokenized.tokens, {
      file,
      grammar,
      source,
    })
    const value = parseProgram(cursor, profile)
    return {
      ok: true,
      parseCount: 1,
      tokenStream: tokenized.tokens
        .filter(({ kind }) => kind !== 'end')
        .map(({ kind, text }) => ({ kind, text })),
      value,
    }
  } catch (error) {
    if (error instanceof CandidateParseFailure) {
      return failure(error.diagnostic)
    }
    throw error
  }
}

export function summarizeCandidateCst(cst) {
  const function_ = cst.functions[0]
  const calls = []
  for (const statement of function_.statements) {
    if (statement.kind === 'let') calls.push(statement.value)
    if (statement.kind === 'return') {
      for (const branch of statement.value.branches) calls.push(branch.value)
    }
  }
  const returned = function_.statements.find(({ kind }) => kind === 'return')
  return {
    unit: cst.unit,
    capabilities: cst.capabilities.map(({ instance, reference }) => ({
      instance,
      reference,
    })),
    function: function_.name,
    return_type: function_.returnType,
    statement_kinds: function_.statements.map(({ kind }) => kind),
    call_targets: calls.map(({ target }) => targetSummary(target)),
    match_input: returned.value.input,
    branch_variants: returned.value.branches
      .map(({ variant }) => variant)
      .sort(compareAscii),
  }
}

function parseProgram(cursor, profile) {
  cursor.expect('unit')
  const unit = takeRole(cursor, profile.semanticSymbol, 'semantic symbol')
  const capabilities = []
  while (cursor.peek().text === 'cap') {
    cursor.expect('cap')
    const instance = takeRole(
      cursor,
      profile.capabilityInstance,
      'capability instance',
    )
    cursor.expect(':')
    const referenceToken = cursor.take('pinned schema reference')
    const reference = SCHEMA_REFERENCE.exec(referenceToken.text)
    if (reference === null) {
      const code = new RegExp(`^${QUALIFIED}$`).test(referenceToken.text)
        ? 'unpinned-schema-reference'
        : 'invalid-schema-reference'
      cursor.fail(referenceToken, 'name@major.minor.patch', code)
    }
    capabilities.push({
      instance,
      kind: 'capability',
      reference: referenceToken.text,
    })
  }

  cursor.expect('fn')
  const name = takeRole(cursor, profile.semanticSymbol, 'semantic symbol')
  cursor.expect('(')
  cursor.expect(')')
  cursor.expect('->')
  const returnType = takeQualified(cursor, 'return type')
  cursor.expect('{')
  const statements = []
  while (cursor.peek().text !== '}') {
    statements.push(parseStatement(cursor, profile, capabilities))
  }
  cursor.expect('}')
  cursor.expectEnd()
  return {
    capabilities,
    functions: [{
      kind: 'function',
      name,
      returnType,
      statements,
    }],
    kind: 'candidate-program',
    unit,
    version: '0.1',
  }
}

function parseStatement(cursor, profile, capabilities) {
  if (cursor.peek().text.startsWith('%')) {
    const alias = takeAlias(cursor)
    cursor.expect('=')
    return {
      alias,
      kind: 'let',
      value: parseCall(cursor, profile, capabilities),
    }
  }
  if (cursor.peek().text === 'return') {
    cursor.expect('return')
    return {
      kind: 'return',
      value: parseMatch(cursor, profile, capabilities),
    }
  }
  cursor.fail(cursor.peek(), 'let or return statement')
}

function parseMatch(cursor, profile, capabilities) {
  cursor.expect('match')
  const input = takeAlias(cursor)
  cursor.expect('{')
  const branches = []
  while (cursor.peek().text !== '}') {
    const variant = takeQualified(cursor, 'match variant')
    cursor.expect('(')
    cursor.expect('_')
    cursor.expect(')')
    cursor.expect('=>')
    branches.push({
      kind: 'match-branch',
      value: parseCall(cursor, profile, capabilities),
      variant,
    })
  }
  cursor.expect('}')
  return { branches, input, kind: 'match' }
}

function parseCall(cursor, profile, capabilities) {
  const operation = cursor.take('operation call')
  const capability = profile.capabilityCall.exec(operation.text)
  let target
  if (capability !== null) {
    target = {
      instance: capability[1],
      kind: 'capability-member',
      member: capability[2],
    }
  } else if (new RegExp(`^${QUALIFIED}$`).test(operation.text)) {
    const root = operation.text.split('.')[0]
    if (capabilities.some(({ instance }) => instance === root)) {
      cursor.fail(
        operation,
        'capability call sigil',
        'missing-capability-sigil',
      )
    }
    target = { kind: 'pure-operation', operation: operation.text }
  } else {
    cursor.fail(operation, 'candidate operation call')
  }

  cursor.expect('(')
  const first = cursor.take('call argument')
  let name = null
  let value = first
  if (cursor.peek().text === ':') {
    cursor.expect(':')
    name = first.text
    value = cursor.take('call argument')
  }
  const argument = parseCandidateLiteral(cursor, value)
  cursor.expect(')')
  return {
    arguments: [{ name, value: argument }],
    kind: 'call',
    target,
  }
}

function parseCandidateLiteral(cursor, token) {
  if (token.kind === 'string') {
    return { kind: 'text-literal', value: token.value.normalize('NFC') }
  }
  const numeric = decodeV1NumericLiteral(token.text)
  if (numeric.ok) {
    const { ok: _ok, ...literal } = numeric
    return literal
  }
  if (looksLikeNumericLiteral(token.text)) {
    cursor.fail(
      token,
      'canonical int or fixed-scale decimal',
      'invalid-numeric-literal',
      { reason: numeric.reason },
    )
  }
  cursor.fail(token, 'literal')
}

function takeRole(cursor, pattern, expected) {
  const token = cursor.take(expected)
  const match = pattern.exec(token.text)
  if (match === null) {
    cursor.fail(token, expected, 'unexpected-candidate-token')
  }
  return match[1]
}

function takeAlias(cursor) {
  const token = cursor.take('compact alias')
  if (!isCompactAliasToken(token.text)) {
    const code = token.text.startsWith('%u')
      ? 'reserved-canonical-label'
      : 'unexpected-candidate-token'
    cursor.fail(token, 'compact alias not starting with %u', code)
  }
  const match = new RegExp(`^%(${SEGMENT})$`).exec(token.text)
  if (match === null) {
    cursor.fail(token, 'compact alias', 'unexpected-candidate-token')
  }
  return match[1]
}

function takeQualified(cursor, expected) {
  const token = cursor.take(expected)
  if (!new RegExp(`^${QUALIFIED}$`).test(token.text)) {
    cursor.fail(token, expected, 'unexpected-candidate-token')
  }
  return token.text
}

function targetSummary(target) {
  return target.kind === 'capability-member'
    ? `capability:${target.instance}.${target.member}`
    : `pure:${target.operation}`
}

class CandidateCursor {
  #context
  #index = 0
  #tokens

  constructor(tokens, context) {
    this.#context = context
    this.#tokens = tokens
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

  fail(token, expected, code = 'unexpected-candidate-token', details = {}) {
    throw new CandidateParseFailure(createSourceDiagnostic(
      this.#context.source,
      {
      actual: token.kind === 'end' ? 'end of file' : token.text,
      code,
      ...details,
      end: token.end,
      expected,
      file: this.#context.file,
      grammar: this.#context.grammar,
      phase: 'parse',
      rule: diagnosticRule(code),
      start: token.start,
      },
    ))
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

class CandidateParseFailure extends Error {
  constructor(diagnostic) {
    super(diagnostic.code)
    this.diagnostic = diagnostic
  }
}

function failure(diagnostic) {
  return { diagnostics: [diagnostic], ok: false }
}

function diagnosticRule(code) {
  return ({
    'invalid-numeric-literal': 'compact.numeric-literal',
    'invalid-schema-reference': 'compact.schema-reference',
    'missing-capability-sigil': 'compact.capability-call',
    'reserved-canonical-label': 'compact.alias',
    'unpinned-schema-reference': 'compact.schema-reference',
    'unexpected-candidate-token': 'compact.token-role',
  })[code] ?? 'compact.parse'
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function buildProfile({ capabilityPrefix, semanticPrefix }) {
  const capability = escapeRegExp(capabilityPrefix)
  const semantic = escapeRegExp(semanticPrefix)
  return Object.freeze({
    capabilityCall: new RegExp(`^${capability}(${SEGMENT})\\.(${SEGMENT})$`),
    capabilityInstance: new RegExp(`^${capability}(${SEGMENT})$`),
    semanticSymbol: new RegExp(`^${semantic}(${QUALIFIED})$`),
  })
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
