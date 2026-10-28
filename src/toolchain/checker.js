import { checkProcessExitLiteral } from '../host/demo-runner.js'
import { isCanonicalBytes } from './bytes-literal.js'
import { isCanonicalDecimalLiteral } from './decimal-literal.js'
import { validateGraphIdentities } from './graph-identity.js'
import { isCanonicalInteger } from './integer-literal.js'
import { minimalStdOperationContract } from './minimal-std-subset.js'

const PROCESS_EXIT_REFERENCE = 'process.exit@0.1.0'
const PROCESS_EXIT_PARAMETERS = [
  { name: 'code', primary: true, type: 'process.exit_code' },
]

export function checkProgram(program, { file, registry }) {
  const diagnostics = validateGraphIdentities(program)

  if (program.version !== '0.1') {
    diagnostics.push({
      actual: program.version,
      code: 'unsupported-language-version',
      column: 4,
      expected: '0.1',
      file,
      line: 1,
    })
  }

  const main = program.functions.find((candidate) => candidate.name === '@main')
  if (main === undefined) {
    diagnostics.push({
      code: 'missing-main-entry',
      column: 1,
      expected: '@main',
      file,
      line: 1,
    })
  } else if (main.returnType !== 'process.status') {
    diagnostics.push({
      ...main.location,
      actual: main.returnType,
      code: 'main-return-type-mismatch',
      expected: 'process.status',
    })
  }

  const capabilities = checkCapabilities(program.capabilities, registry, diagnostics)
  const checkedFunctions = program.functions.map((function_) =>
    checkFunction(function_, capabilities, program.capabilities, diagnostics),
  )

  if (diagnostics.length > 0) return { diagnostics, ok: false }
  return {
    ok: true,
    program: {
      ...program,
      functions: checkedFunctions,
      kind: 'checked-program-graph',
    },
  }
}

function checkCapabilities(declarations, registry, diagnostics) {
  const capabilities = new Map()
  for (const capability of declarations) {
    if (capabilities.has(capability.instance)) {
      diagnostics.push({
        ...capability.location,
        code: 'duplicate-capability-instance',
        instance: capability.instance,
      })
      continue
    }
    const resolved = registry.resolve(capability.reference)
    if (!resolved.ok) {
      diagnostics.push({
        ...capability.location,
        code: resolved.error.code,
        reference: capability.reference,
      })
      continue
    }
    capabilities.set(capability.instance, {
      definition: resolved.value,
      reference: capability.reference,
    })
  }
  return capabilities
}

function checkFunction(function_, capabilities, declarations, diagnostics) {
  const producers = new Map()
  const bindings = new Set()
  const checkedStatements = new Map()
  const returnStatements = []
  const literalsByUid = buildLiteralsByUid(function_, diagnostics)

  for (const statement of function_.statements) {
    if (statement.kind === 'let') {
      if (bindings.has(statement.binding)) {
        diagnostics.push({
          ...statement.location,
          binding: statement.binding,
          code: 'duplicate-value-binding',
        })
        continue
      }
      const checkedCall = checkLetCall(
        statement.value,
        capabilities,
        declarations,
        literalsByUid,
        diagnostics,
      )
      const checked = { ...statement, value: checkedCall }
      bindings.add(statement.binding)
      producers.set(statement.uid, checked)
      checkedStatements.set(statement.uid, checked)
    } else if (statement.kind === 'return') {
      returnStatements.push(statement)
    }
  }

  if (returnStatements.length === 0) {
    diagnostics.push({
      ...function_.location,
      code: 'missing-return-statement',
    })
  } else if (returnStatements.length > 1) {
    for (const statement of returnStatements.slice(1)) {
      diagnostics.push({
        ...statement.location,
        code: 'duplicate-return-statement',
      })
    }
  }

  for (const statement of returnStatements) {
    checkedStatements.set(
      statement.uid,
      checkReturn(statement, function_, producers, literalsByUid, diagnostics),
    )
  }

  return {
    ...function_,
    statements: function_.statements.map(
      (statement) => checkedStatements.get(statement.uid) ?? statement,
    ),
  }
}

// Literal nodes are graph identity: the checker validates their declared type
// and value but never mints or repairs an identity. Every call argument is an
// explicit value edge to a literal UID; the checker resolves it here.
function buildLiteralsByUid(function_, diagnostics) {
  const literalsByUid = new Map()
  for (const literal of function_.literals ?? []) {
    if (typeof literal.uid !== 'string') continue
    literalsByUid.set(literal.uid, literal)
    if (!isWellTypedLiteral(literal)) {
      diagnostics.push({
        ...locationOf(literal),
        actual: literal.value,
        code: 'malformed-literal-node',
        type: literal.type,
      })
    }
  }
  return literalsByUid
}

function isWellTypedLiteral(literal) {
  if (
    ['fs.path', 'text.encoding', 'text.utf8'].includes(literal.type)
  ) {
    return typeof literal.value === 'string'
  }
  if (literal.type === 'bytes') {
    return isCanonicalBytes(literal.value)
  }
  if (isCanonicalDecimalLiteral(literal.value, literal.type)) return true
  if (literal.type === 'int') return isCanonicalInteger(literal.value)
  return false
}

function locationOf(node) {
  return node.location ?? { column: 1, file: '<input>', line: 1 }
}

function checkLetCall(
  call,
  capabilities,
  declarations,
  literalsByUid,
  diagnostics,
) {
  if (call.target.kind === 'pure-operation') {
    return checkMinimalStdCall(call, literalsByUid, diagnostics)
  }
  return checkCapabilityCall(call, capabilities, declarations, literalsByUid, diagnostics)
}

function checkCapabilityCall(
  call,
  capabilities,
  declarations,
  literalsByUid,
  diagnostics,
) {
  if (call.target.kind !== 'capability-member') {
    diagnostics.push({
      ...call.location,
      code: 'effect-call-requires-capability-instance',
    })
    return call
  }

  const declaration = declarations.find(
    (candidate) => candidate.instance === call.target.instance,
  )
  if (declaration === undefined) {
    diagnostics.push({
      ...call.location,
      code: 'unknown-capability-instance',
      instance: call.target.instance,
    })
    return call
  }
  const capability = capabilities.get(call.target.instance)
  if (capability === undefined) return call
  if (call.target.schemaReference !== capability.reference) {
    diagnostics.push({
      ...call.location,
      actual: call.target.schemaReference,
      code: 'call-schema-reference-mismatch',
      expected: capability.reference,
    })
    return call
  }

  const member = capability.definition.members[call.target.member]
  if (member === undefined) {
    diagnostics.push({
      ...call.location,
      code: 'unknown-capability-member',
      instance: call.target.instance,
      member: call.target.member,
      reference: capability.reference,
    })
    return call
  }
  const typedArguments = bindArguments({
    arguments_: call.arguments,
    diagnostics,
    literalsByUid,
    member: call.target.member,
    params: member.params,
    reference: capability.reference,
  })
  if (!isSupportedDemoOperation(capability.reference, call.target.member)) {
    diagnostics.push({
      ...call.location,
      code: 'unsupported-demo-operation',
      operation: `${capability.reference}.${call.target.member}`,
    })
  }
  return {
    ...call,
    returnType: member.returns,
    typedArguments,
  }
}

function checkMinimalStdCall(call, literalsByUid, diagnostics) {
  const contract = minimalStdOperationContract(call.target.operation)
  if (contract === null
    || call.target.schemaReference !== `${call.target.operation}@0.1.0`) {
    diagnostics.push({
      ...call.location,
      code: 'unsupported-pure-operation',
      operation: call.target.operation,
    })
    return call
  }
  if (call.target.operation !== 'std.bytes.decode_utf8') {
    diagnostics.push({
      ...call.location,
      code: 'std-operation-graph-representation-unsupported',
      operation: call.target.operation,
    })
    return call
  }
  const params = contract.parameters.map(({ name, type }) => ({
    name,
    type: primitiveGraphType(type),
  }))
  if (params.some(({ type }) => type === null)) {
    diagnostics.push({
      ...call.location,
      code: 'std-operation-graph-representation-unsupported',
      operation: call.target.operation,
    })
    return call
  }
  const typedArguments = bindArguments({
    arguments_: call.arguments,
    diagnostics,
    literalsByUid,
    member: call.target.operation,
    params,
    reference: call.target.schemaReference,
  })
  return {
    ...call,
    returnType: stdReturnType(call.target.operation),
    typedArguments,
  }
}

function primitiveGraphType(type) {
  return type?.kind === 'primitive' ? type.name : null
}

function stdReturnType(operation) {
  return operation === 'std.bytes.decode_utf8'
    ? 'result<text.utf8, std.bytes.decode_error>'
    : 'std.value'
}

function checkReturn(statement, function_, producers, literalsByUid, diagnostics) {
  const match = statement.value
  const producer = producers.get(match.input.producer)
  if (match.input.kind !== 'value-edge' || producer === undefined) {
    diagnostics.push({
      ...match.input.location,
      code: 'unknown-edge-endpoint',
      endpoint: match.input.producer,
    })
  }

  const variants = new Set()
  const branches = []
  for (const branch of match.branches) {
    if (!['err', 'ok'].includes(branch.variant)) {
      diagnostics.push({
        ...branch.location,
        code: 'unknown-match-variant',
        variant: branch.variant,
      })
    } else if (variants.has(branch.variant)) {
      diagnostics.push({
        ...branch.location,
        code: 'duplicate-match-variant',
        variant: branch.variant,
      })
    }
    variants.add(branch.variant)
    branches.push({
      ...branch,
      value: checkProcessExitCall(branch.value, literalsByUid, diagnostics),
    })
  }
  const missing = ['err', 'ok'].filter((variant) => !variants.has(variant))
  if (missing.length > 0) {
    diagnostics.push({
      ...function_.location,
      code: 'non-exhaustive-match',
      missing,
    })
  }

  return {
    ...statement,
    value: { ...match, branches },
  }
}

function checkProcessExitCall(call, literalsByUid, diagnostics) {
  if (
    call.target.kind !== 'pure-operation' ||
    call.target.operation !== 'process.exit' ||
    call.target.schemaReference !== PROCESS_EXIT_REFERENCE
  ) {
    diagnostics.push({
      ...call.location,
      code: 'invalid-return-operation',
      expected: PROCESS_EXIT_REFERENCE,
    })
    return call
  }
  const typedArguments = bindArguments({
    arguments_: call.arguments,
    diagnostics,
    literalsByUid,
    member: 'process.exit',
    params: PROCESS_EXIT_PARAMETERS,
    reference: PROCESS_EXIT_REFERENCE,
  })
  if (typedArguments !== undefined) {
    const codeArgument = call.arguments.find(
      (argument) =>
        (argument.name ?? 'code') === 'code' &&
        argument.source?.kind === 'value-edge',
    )
    const codeLiteral =
      codeArgument !== undefined
        ? literalsByUid.get(codeArgument.source.endpoint)
        : undefined
    if (codeLiteral !== undefined) {
      const exitCodeCheck = checkProcessExitLiteral(
        codeLiteral.value,
        codeArgument.location,
      )
      if (!exitCodeCheck.ok) diagnostics.push(...exitCodeCheck.diagnostics)
    }
  }
  return { ...call, returnType: 'process.status', typedArguments }
}

function bindArguments({
  arguments_,
  diagnostics,
  literalsByUid,
  member,
  params,
  reference,
}) {
  const bound = {}
  const primary = params.find((parameter) => parameter.primary === true)
  const provided = new Set()
  let suppressMissing = false
  let valid = true
  for (const argument of arguments_) {
    const name = argument.name ?? primary?.name
    const parameter = params.find((candidate) => candidate.name === name)
    if (parameter === undefined) {
      diagnostics.push({
        ...argument.location,
        actual: argument.name ?? '<positional>',
        code: 'unexpected-argument',
        expected: params.map((candidate) => candidate.name),
        member,
        reference,
      })
      suppressMissing = true
      valid = false
      continue
    }
    provided.add(name)
    if (Object.hasOwn(bound, name)) {
      diagnostics.push({
        ...argument.location,
        code: 'duplicate-argument',
        member,
        parameter: name,
        reference,
      })
      valid = false
      continue
    }
    const resolution = resolveArgumentValueEdge(argument, literalsByUid, diagnostics)
    if (resolution === undefined) {
      valid = false
      continue
    }
    if (!matchesLiteralType(resolution.type, parameter.type)) {
      diagnostics.push({
        ...argument.location,
        actual: resolution.type,
        code: 'argument-type-mismatch',
        expected: parameter.type,
        member,
        parameter: name,
        reference,
      })
      valid = false
      continue
    }
    bound[name] = { endpoint: resolution.endpoint, type: resolution.type }
  }
  for (const parameter of suppressMissing ? [] : params) {
    if (
      !provided.has(parameter.name) &&
      !Object.hasOwn(parameter, 'default')
    ) {
      diagnostics.push({
        code: 'missing-argument',
        file: arguments_[0]?.location.file ?? '<input>',
        line: arguments_[0]?.location.line ?? 1,
        column: arguments_[0]?.location.column ?? 1,
        member,
        parameter: parameter.name,
        reference,
      })
      valid = false
    }
  }
  return valid ? bound : undefined
}

// Every call argument is a value edge to a literal graph node. Resolve the
// endpoint against the function's literal identity map and surface a broken
// endpoint as a single root diagnostic; never guess a value from text.
function resolveArgumentValueEdge(argument, literalsByUid, diagnostics) {
  const source = argument.source
  if (source?.kind !== 'value-edge' || source.endpoint === undefined) {
    diagnostics.push({
      ...argument.location,
      code: 'missing-argument-value-edge',
    })
    return undefined
  }
  const literal = literalsByUid.get(source.endpoint)
  if (literal === undefined) {
    diagnostics.push({
      ...argument.location,
      code: 'unknown-edge-endpoint',
      endpoint: source.endpoint,
    })
    return undefined
  }
  return { endpoint: source.endpoint, type: literal.type, value: literal.value }
}

function matchesLiteralType(actual, expected) {
  if (actual === expected) return true
  return actual === 'int' && expected === 'process.exit_code'
}

function isSupportedDemoOperation(reference, member) {
  return (
    (reference === 'process.stdout@0.1.0' && member === 'write') ||
    (reference === 'process.args@0.1.0' && member === 'read') ||
    (reference === 'fs.read@0.1.0' && member === 'read_file') ||
    (reference === 'fs.write@0.1.0' && member === 'write_file')
  )
}
