import { Buffer } from 'node:buffer'

import { isCanonicalBytes } from './bytes-literal.js'
import {
  decimalScaleFromType,
  isCanonicalDecimalLiteral,
} from './decimal-literal.js'
import {
  EXECUTABLE_GRAMMAR_PROFILE,
  executableGrammarHeader,
} from './executable-grammar-profile.js'
import { parseExecutableGrammar } from './executable-grammar.js'
import { validateGraphIdentities } from './graph-identity.js'
import { isCanonicalInteger } from './integer-literal.js'

const HEADER = executableGrammarHeader('canonical')
const UID = '[a-z2-7]{26}'
const LABEL = '%u[a-z2-7]{7}'
const IDENTITY = `(${LABEL}): uid\\("(${UID})"\\):`

export const CANONICAL_GRAPH_SLICE = Object.freeze({
  callTargetKinds: Object.freeze(['capability-member', 'pure-operation']),
  identityNodeKinds: Object.freeze([
    'call',
    'cap',
    'function',
    'let',
    'literal',
    'match',
    'match-branch',
    'return',
  ]),
  literalTypes: Object.freeze([
    'bytes',
    'decimal<scale>',
    'fs.path',
    'int',
    'text.encoding',
    'text.utf8',
  ]),
  supportKinds: Object.freeze(['checked-program-graph', 'value-edge']),
  version: EXECUTABLE_GRAMMAR_PROFILE.version,
})

export function serializeCanonicalGraph(graph) {
  assertCanonicalGraphSlice(graph)
  const lines = [HEADER, `unit ${graph.unit}`]
  for (const capability of sorted(graph.capabilities, 'instance')) {
    lines.push(
      `cap ${renderIdentity(capability)} ${capability.instance} = ${capability.reference}`,
    )
  }
  for (const function_ of sorted(graph.functions, 'name')) {
    lines.push(
      `fn ${renderIdentity(function_)} ${function_.name} -> ${function_.returnType} {`,
    )
    for (const literal of sorted(function_.literals ?? [], 'uid')) {
      lines.push(
        `  literal ${renderIdentity(literal)} ${literal.type} = ${encodeValue(literal.value, literal.type)}`,
      )
    }
    for (const statement of canonicalStatements(function_.statements)) {
      lines.push(...renderStatement(statement))
    }
    lines.push('}')
  }
  return `${lines.join('\n')}\n`
}

export function loadCanonicalGraph(source) {
  const grammar = parseExecutableGrammar(source, { file: '<canonical>' })
  if (!grammar.ok) return grammar
  if (grammar.value.kind !== 'canonical') {
    return fail('unexpected-source-form', 1, {
      actual: grammar.value.kind,
      expected: 'canonical',
    })
  }
  return loadCanonicalGraphBody(
    source.slice(grammar.value.bodyOffset),
    { canonicalSource: source },
  )
}

export function loadCanonicalGraphBody(
  body,
  { canonicalSource = null } = {},
) {
  // A non-semantic sentinel preserves the source line numbers expected by the
  // body parser without letting it consume or reinterpret the real header.
  const lines = [HEADER, ...body.split(/\r?\n/)]

  const state = {
    capabilityReferences: new Map(),
    labels: new Map(),
    uids: new Set(),
  }
  const graph = {
    capabilities: [],
    functions: [],
    unit: null,
    version: EXECUTABLE_GRAMMAR_PROFILE.version,
  }
  let index = 1
  while (index < lines.length) {
    const line = lines[index]
    if (line === '') {
      index += 1
      continue
    }
    if (line.startsWith('unit ')) {
      if (graph.unit !== null) return fail('duplicate-unit', index + 1)
      graph.unit = line.slice(5)
      index += 1
      continue
    }
    if (line.startsWith('cap ')) {
      const parsed = parseCapability(line, index + 1, state)
      if (!parsed.ok) return parsed
      graph.capabilities.push(parsed.value)
      state.capabilityReferences.set(
        parsed.value.instance,
        parsed.value.reference,
      )
      index += 1
      continue
    }
    if (line.startsWith('fn ')) {
      const parsed = parseFunction(lines, index, state)
      if (!parsed.ok) return parsed
      graph.functions.push(parsed.value.function)
      index = parsed.value.nextIndex
      continue
    }
    return fail('unexpected-canonical-line', index + 1)
  }
  if (graph.unit === null) return fail('missing-unit')

  const resolved = resolveEdgeLabels(graph, state.labels)
  if (!resolved.ok) return resolved
  const identityDiagnostics = validateGraphIdentities(graph)
  if (identityDiagnostics.length > 0) {
    return {
      diagnostics: [
        {
          ...identityDiagnostics[0],
          column: 1,
          file: '<canonical>',
          line: 1,
        },
      ],
      ok: false,
    }
  }
  if (canonicalSource !== null) {
    const unique = validateCanonicalBytes(canonicalSource, graph)
    if (!unique.ok) return unique
  }
  return { ok: true, value: graph }
}

function renderStatement(statement) {
  if (statement.kind === 'let') {
    return [
      `  let ${renderIdentity(statement)} ${statement.binding} = ${renderCall(statement.value)}`,
    ]
  }
  if (statement.kind === 'return') {
    const match = statement.value
    const lines = [
      `  return ${renderIdentity(statement)} match ${renderIdentity(match)} ${labelOf(match.input.producer)} {`,
    ]
    for (const branch of canonicalBranches(match.branches)) {
      lines.push(
        `    branch ${renderIdentity(branch)} ${branch.variant} => ${renderCall(branch.value)}`,
      )
    }
    lines.push('  }')
    return lines
  }
  throw new TypeError(`unsupported canonical statement: ${statement.kind}`)
}

function renderCall(call) {
  if (call.arguments.length === 0) {
    return renderCallWithArguments(call, '')
  }
  const arguments_ = call.arguments
    .map((argument) => ({
      endpoint: labelOf(argument.source.endpoint),
      name: canonicalArgumentName(call, argument),
    }))
    .sort((left, right) => compareUtf8(left.name, right.name))
    .map(({ endpoint, name }) => `${name}: ${endpoint}`)
    .join(', ')
  return renderCallWithArguments(call, arguments_)
}

function renderCallWithArguments(call, arguments_) {
  if (call.target.kind === 'capability-member') {
    return `call ${renderIdentity(call)} ${call.target.instance}.${call.target.member}(${arguments_})`
  }
  if (call.target.kind === 'pure-operation') {
    return `call ${renderIdentity(call)} ${call.target.schemaReference}(${arguments_})`
  }
  throw unsupportedCanonicalConstruct('call target', call.target.kind)
}

function canonicalArgumentName(call, argument) {
  if (argument.name !== null && argument.name !== undefined) return argument.name
  for (const [name, binding] of Object.entries(call.typedArguments ?? {})) {
    if (binding.endpoint === argument.source.endpoint) return name
  }
  throw new TypeError('checked call argument has no canonical parameter name')
}

function parseCapability(line, lineNumber, state) {
  const match = new RegExp(`^cap ${IDENTITY} (\\S+) = (\\S+)$`).exec(line)
  if (!match) return fail('invalid-capability-line', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  return {
    ok: true,
    value: {
      instance: match[3],
      kind: 'cap',
      location: location(lineNumber),
      reference: match[4],
      uid: match[2],
    },
  }
}

function parseFunction(lines, startIndex, state) {
  const lineNumber = startIndex + 1
  const match = new RegExp(
    `^fn ${IDENTITY} (\\S+) -> (\\S+) \\{$`,
  ).exec(lines[startIndex])
  if (!match) return fail('invalid-function-line', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  const function_ = {
    kind: 'function',
    literals: [],
    location: location(lineNumber),
    name: match[3],
    returnType: match[4],
    statements: [],
    uid: match[2],
  }

  let index = startIndex + 1
  while (index < lines.length && lines[index] !== '}') {
    const current = lines[index]
    if (current.startsWith('  literal ')) {
      const parsed = parseLiteral(current, index + 1, state)
      if (!parsed.ok) return parsed
      function_.literals.push(parsed.value)
      index += 1
      continue
    }
    if (current.startsWith('  let ')) {
      const parsed = parseLet(current, index + 1, state)
      if (!parsed.ok) return parsed
      function_.statements.push(parsed.value)
      index += 1
      continue
    }
    if (current.startsWith('  return ')) {
      const parsed = parseReturn(lines, index, state)
      if (!parsed.ok) return parsed
      function_.statements.push(parsed.value.statement)
      index = parsed.value.nextIndex
      continue
    }
    return fail('invalid-statement-line', index + 1)
  }
  if (lines[index] !== '}') return fail('unterminated-function', index + 1)
  return { ok: true, value: { function: function_, nextIndex: index + 1 } }
}

function parseLiteral(line, lineNumber, state) {
  const match = new RegExp(
    `^  literal ${IDENTITY} (\\S+) = (.+)$`,
  ).exec(line)
  if (!match) return fail('invalid-literal-line', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  const value = decodeValue(match[4], match[3], lineNumber)
  if (!value.ok) return value
  return {
    ok: true,
    value: {
      kind: 'literal',
      location: location(lineNumber),
      type: match[3],
      uid: match[2],
      value: value.value,
    },
  }
}

function parseLet(line, lineNumber, state) {
  const match = new RegExp(
    `^  let ${IDENTITY} (\\S+) = (.+)$`,
  ).exec(line)
  if (!match) return fail('invalid-let-line', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  const call = parseCall(match[4], lineNumber, state)
  if (!call.ok) return call
  return {
    ok: true,
    value: {
      binding: match[3],
      kind: 'let',
      location: location(lineNumber),
      uid: match[2],
      value: call.value,
    },
  }
}

function parseReturn(lines, startIndex, state) {
  const lineNumber = startIndex + 1
  const match = new RegExp(
    `^  return ${IDENTITY} match ${IDENTITY} (${LABEL}) \\{$`,
  ).exec(lines[startIndex])
  if (!match) return fail('invalid-return-line', lineNumber)
  const statementIdentity = registerIdentity(
    match[1],
    match[2],
    lineNumber,
    state,
  )
  if (!statementIdentity.ok) return statementIdentity
  const matchIdentity = registerIdentity(
    match[3],
    match[4],
    lineNumber,
    state,
  )
  if (!matchIdentity.ok) return matchIdentity

  const branches = []
  let index = startIndex + 1
  while (index < lines.length && lines[index] !== '  }') {
    const parsed = parseBranch(lines[index], index + 1, state)
    if (!parsed.ok) return parsed
    branches.push(parsed.value)
    index += 1
  }
  if (lines[index] !== '  }') return fail('unterminated-match', index + 1)
  return {
    ok: true,
    value: {
      nextIndex: index + 1,
      statement: {
        kind: 'return',
        location: location(lineNumber),
        uid: match[2],
        value: {
          branches,
          input: {
            kind: 'value-edge',
            location: location(lineNumber),
            producer: match[5],
          },
          kind: 'match',
          location: location(lineNumber),
          uid: match[4],
        },
      },
    },
  }
}

function parseBranch(line, lineNumber, state) {
  const match = new RegExp(
    `^    branch ${IDENTITY} (\\S+) => (.+)$`,
  ).exec(line)
  if (!match) return fail('invalid-branch-line', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  const call = parseCall(match[4], lineNumber, state)
  if (!call.ok) return call
  return {
    ok: true,
    value: {
      kind: 'match-branch',
      location: location(lineNumber),
      uid: match[2],
      value: call.value,
      variant: match[3],
    },
  }
}

function parseCall(text, lineNumber, state) {
  const match = new RegExp(
    `^call ${IDENTITY} (\\S+)\\((.*)\\)$`,
  ).exec(text)
  if (!match) return fail('invalid-call', lineNumber)
  const identity = registerIdentity(match[1], match[2], lineNumber, state)
  if (!identity.ok) return identity
  const target = parseTarget(match[3], lineNumber, state)
  if (!target.ok) return target
  const arguments_ = parseCanonicalArguments(match[4], lineNumber)
  if (!arguments_.ok) return arguments_
  return {
    ok: true,
    value: {
      arguments: arguments_.value,
      kind: 'call',
      location: location(lineNumber),
      target: target.value,
      uid: match[2],
    },
  }
}

function parseCanonicalArguments(text, lineNumber) {
  if (text === '') return { ok: true, value: [] }
  const arguments_ = []
  for (const argument of text.split(', ')) {
    const match = new RegExp(`^(\\S+): (${LABEL})$`).exec(argument)
    if (!match) return fail('invalid-call', lineNumber)
    arguments_.push({
      location: location(lineNumber),
      name: match[1],
      source: { endpoint: match[2], kind: 'value-edge' },
    })
  }
  return { ok: true, value: arguments_ }
}

function parseTarget(text, lineNumber, state) {
  if (text.startsWith('@')) {
    const separator = text.lastIndexOf('.')
    if (separator <= 1) return fail('invalid-call-target', lineNumber)
    const instance = text.slice(0, separator)
    const schemaReference = state.capabilityReferences.get(instance)
    if (schemaReference === undefined) {
      return fail('unknown-canonical-capability-instance', lineNumber, {
        instance,
      })
    }
    return {
      ok: true,
      value: {
        instance,
        kind: 'capability-member',
        member: text.slice(separator + 1),
        schemaReference,
      },
    }
  }
  const pure = /^(.+)@(\d+\.\d+\.\d+)$/.exec(text)
  if (!pure) return fail('invalid-call-target', lineNumber)
  return {
    ok: true,
    value: {
      kind: 'pure-operation',
      operation: pure[1],
      schemaReference: text,
    },
  }
}

function registerIdentity(label, uid, lineNumber, state) {
  const expected = labelOf(uid)
  if (label !== expected) {
    return fail('label-uid-mismatch', lineNumber, {
      actual: label,
      expected,
      uid,
    })
  }
  const previousUid = state.labels.get(label)
  if (previousUid !== undefined && previousUid !== uid) {
    return fail('ambiguous-label', lineNumber, {
      label,
      uids: [previousUid, uid],
    })
  }
  if (state.uids.has(uid)) {
    return fail('uid-collision', lineNumber, { uid })
  }
  state.labels.set(label, uid)
  state.uids.add(uid)
  return { ok: true }
}

function resolveEdgeLabels(graph, labels) {
  for (const function_ of graph.functions) {
    for (const call of callsOf(function_)) {
      for (const argument of call.arguments ?? []) {
        const resolved = labels.get(argument.source.endpoint)
        if (resolved === undefined) {
          return fail('unknown-canonical-label', argument.location.line, {
            label: argument.source.endpoint,
          })
        }
        argument.source.endpoint = resolved
      }
    }
    for (const statement of function_.statements) {
      if (statement.kind !== 'return') continue
      const resolved = labels.get(statement.value.input.producer)
      if (resolved === undefined) {
        return fail('unknown-canonical-label', statement.location.line, {
          label: statement.value.input.producer,
        })
      }
      statement.value.input.producer = resolved
    }
  }
  return { ok: true }
}

function callsOf(function_) {
  const calls = []
  for (const statement of function_.statements) {
    if (statement.kind === 'let') calls.push(statement.value)
    for (const branch of statement.value?.branches ?? []) {
      calls.push(branch.value)
    }
  }
  return calls
}

function canonicalStatements(statements) {
  const rank = { let: 0, return: 1 }
  return [...statements].sort(
    (left, right) =>
      (rank[left.kind] ?? 99) - (rank[right.kind] ?? 99) ||
      compareUtf8(left.uid, right.uid),
  )
}

function canonicalBranches(branches) {
  return [...branches].sort(
    (left, right) =>
      compareUtf8(left.variant, right.variant) ||
      compareUtf8(left.uid, right.uid),
  )
}

function sorted(values, key) {
  return [...values].sort((left, right) => compareUtf8(left[key], right[key]))
}

function renderIdentity(node) {
  return `${labelOf(node.uid)}: uid("${node.uid}"):`
}

function labelOf(uid) {
  return `%u${uid.slice(0, 7)}`
}

function decodeValue(rawValue, type, lineNumber) {
  if (type === 'fs.path' || type === 'text.utf8') {
    try {
      const value = JSON.parse(rawValue)
      return typeof value === 'string'
        ? { ok: true, value }
        : fail('invalid-literal-value', lineNumber)
    } catch {
      return fail('invalid-literal-value', lineNumber)
    }
  }
  if (type === 'text.encoding' && rawValue === 'text.encoding.utf8') {
    return { ok: true, value: rawValue }
  }
  if (type === 'bytes' && isCanonicalBytes(rawValue)) {
    return { ok: true, value: rawValue }
  }
  if (isCanonicalDecimalLiteral(rawValue, type)) {
    return { ok: true, value: rawValue }
  }
  if (type === 'int' && isCanonicalInteger(rawValue)) {
    return { ok: true, value: rawValue }
  }
  return fail('invalid-literal-value', lineNumber)
}

function encodeValue(value, type) {
  if (
    (type === 'fs.path' || type === 'text.utf8') &&
    typeof value === 'string'
  ) {
    return JSON.stringify(value.normalize('NFC'))
  }
  if (type === 'text.encoding' && value === 'text.encoding.utf8') {
    return value
  }
  if (type === 'bytes' && isCanonicalBytes(value)) {
    return value
  }
  if (isCanonicalDecimalLiteral(value, type)) {
    return value
  }
  if (type === 'int' && isCanonicalInteger(value)) {
    return value
  }
  throw unsupportedCanonicalConstruct('literal value', type)
}

function assertCanonicalGraphSlice(graph) {
  if (graph === null || typeof graph !== 'object') {
    throw unsupportedCanonicalConstruct('graph', typeof graph)
  }
  if (graph.version !== CANONICAL_GRAPH_SLICE.version) {
    throw unsupportedCanonicalConstruct('graph version', graph.version)
  }
  if (typeof graph.unit !== 'string') {
    throw unsupportedCanonicalConstruct('unit', typeof graph.unit)
  }
  if (!Array.isArray(graph.capabilities) || !Array.isArray(graph.functions)) {
    throw unsupportedCanonicalConstruct('graph collections', 'non-array')
  }
  assertKnownGraphKinds(graph)

  for (const capability of graph.capabilities) {
    assertNodeKind(capability, 'cap')
  }
  for (const function_ of graph.functions) {
    assertNodeKind(function_, 'function')
    if (!Array.isArray(function_.literals) || !Array.isArray(function_.statements)) {
      throw unsupportedCanonicalConstruct('function collections', 'non-array')
    }
    for (const literal of function_.literals) {
      assertNodeKind(literal, 'literal')
      if (!isSupportedLiteralType(literal.type)) {
        throw unsupportedCanonicalConstruct('literal type', literal.type)
      }
      encodeValue(literal.value, literal.type)
    }
    for (const statement of function_.statements) {
      if (statement.kind === 'let') {
        assertCall(statement.value)
        continue
      }
      if (statement.kind === 'return') {
        assertNodeKind(statement.value, 'match')
        if (statement.value.input?.kind !== 'value-edge') {
          throw unsupportedCanonicalConstruct(
            'match input',
            statement.value.input?.kind,
          )
        }
        if (!Array.isArray(statement.value.branches)) {
          throw unsupportedCanonicalConstruct('match branches', 'non-array')
        }
        for (const branch of statement.value.branches) {
          assertNodeKind(branch, 'match-branch')
          assertCall(branch.value)
        }
        continue
      }
      throw unsupportedCanonicalConstruct('statement', statement.kind)
    }
  }

  const identityDiagnostics = validateGraphIdentities(graph)
  if (identityDiagnostics.length > 0) {
    throw new TypeError(
      `canonical serializer requires valid graph identity: ${identityDiagnostics[0].code}`,
    )
  }
}

function isSupportedLiteralType(type) {
  return (
    CANONICAL_GRAPH_SLICE.literalTypes.includes(type) ||
    decimalScaleFromType(type) !== null
  )
}

function assertKnownGraphKinds(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertKnownGraphKinds(child)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (
    typeof value.kind === 'string' &&
    !CANONICAL_GRAPH_SLICE.identityNodeKinds.includes(value.kind) &&
    !CANONICAL_GRAPH_SLICE.callTargetKinds.includes(value.kind) &&
    !CANONICAL_GRAPH_SLICE.supportKinds.includes(value.kind)
  ) {
    throw unsupportedCanonicalConstruct('graph kind', value.kind)
  }
  for (const child of Object.values(value)) assertKnownGraphKinds(child)
}

function assertCall(call) {
  assertNodeKind(call, 'call')
  if (!CANONICAL_GRAPH_SLICE.callTargetKinds.includes(call.target?.kind)) {
    throw unsupportedCanonicalConstruct('call target', call.target?.kind)
  }
  if (!Array.isArray(call.arguments)) {
    throw unsupportedCanonicalConstruct(
      'call argument count',
      call.arguments?.length,
    )
  }
  for (const argument of call.arguments) {
    if (argument.source?.kind !== 'value-edge') {
      throw unsupportedCanonicalConstruct(
        'call argument source',
        argument.source?.kind,
      )
    }
  }
}


function assertNodeKind(node, expected) {
  if (node?.kind !== expected) {
    throw unsupportedCanonicalConstruct(expected, node?.kind)
  }
}

function unsupportedCanonicalConstruct(scope, actual) {
  return new TypeError(
    `unsupported canonical graph construct: ${scope}=${String(actual)}`,
  )
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function location(line) {
  return { column: 1, file: '<canonical>', line }
}

function fail(code, line = 1, details = {}) {
  return {
    diagnostics: [
      { code, column: 1, file: '<canonical>', line, ...details },
    ],
    ok: false,
  }
}

function validateCanonicalBytes(source, graph) {
  const expected = Buffer.from(serializeCanonicalGraph(graph), 'utf8')
  const actual = Buffer.from(source, 'utf8')
  const length = Math.min(actual.length, expected.length)
  let byteOffset = 0
  while (byteOffset < length && actual[byteOffset] === expected[byteOffset]) {
    byteOffset += 1
  }
  if (byteOffset === actual.length && byteOffset === expected.length) {
    return { ok: true }
  }

  const prefix = actual.subarray(0, byteOffset).toString('utf8')
  const lineStart = prefix.lastIndexOf('\n')
  const line = [...prefix].filter((character) => character === '\n').length + 1
  const column = [...prefix.slice(lineStart + 1)].length + 1
  return fail('non-canonical-source', line, {
    actual_byte: actual[byteOffset] ?? null,
    byte_offset: byteOffset,
    column,
    expected_byte: expected[byteOffset] ?? null,
  })
}
