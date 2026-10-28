import { createHash } from 'node:crypto'
import {
  executePortableBytecodeCore,
  PORTABLE_BYTECODE_RESULT_SCHEMA,
} from './portable-bytecode-core.js'

export const PORTABLE_BYTECODE_ARTIFACT_SCHEMA =
  're.portable-bytecode-artifact@0.1.0'
export { PORTABLE_BYTECODE_RESULT_SCHEMA }
export const PORTABLE_BYTECODE_PROFILE = 're.portable-bytecode@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/u

export function compilePortableBytecode(graph) {
  try {
    if (!plainObject(graph) || !DIGEST.test(graph.graph_revision)) {
      return rejected('portable-bytecode-graph-invalid')
    }
    if (!Array.isArray(graph.functions) || graph.functions.length !== 1) {
      return rejected('portable-bytecode-shape-unsupported')
    }
    const main = graph.functions?.find((candidate) => candidate?.name === '@main')
    if (!plainObject(main)
      || !Array.isArray(main.statements)
      || main.statements.length !== 2
      || !Array.isArray(main.literals)) {
      return rejected('portable-bytecode-main-invalid')
    }
    const invocations = main.statements.filter(
      (statement) => statement?.kind === 'let',
    )
    const returns = main.statements.filter(
      (statement) => statement?.kind === 'return',
    )
    const invocation = invocations[0]
    const returned = returns[0]
    if (invocations.length !== 1 || returns.length !== 1) {
      return rejected('portable-bytecode-shape-unsupported')
    }
    if (!plainObject(invocation)
      || !capabilityCall(invocation.value)
      || !plainObject(returned?.value)
      || returned.value.kind !== 'match'
      || returned.value.input?.producer !== invocation.uid) {
      return rejected('portable-bytecode-shape-unsupported')
    }
    const branches = new Map(
      (returned.value.branches ?? []).map((branch) => [branch?.variant, branch]),
    )
    if (branches.size !== 2
      || !branches.has('ok')
      || !branches.has('err')
      || !processExitCall(branches.get('ok')?.value)
      || !processExitCall(branches.get('err')?.value)) {
      return rejected('portable-bytecode-shape-unsupported')
    }

    const literalEntries = [...main.literals]
      .sort((left, right) => compareText(left?.uid, right?.uid))
      .map((literal) => {
        if (!plainObject(literal)
          || typeof literal.uid !== 'string'
          || typeof literal.type !== 'string'
          || !['bytes', 'fs.path', 'int', 'text.encoding', 'text.utf8']
            .includes(literal.type)
          || typeof literal.value !== 'string') {
          fail('portable-bytecode-literal-invalid')
        }
        return {
          type: literal.type,
          uid: literal.uid,
          value: literal.value,
        }
      })
    const literalIndex = new Map(
      literalEntries.map((literal, index) => [literal.uid, index]),
    )
    const instructions = [
      {
        arguments: compileArguments(invocation.value, literalIndex),
        destination: 0,
        instance: invocation.value.target.instance,
        invocation_id: invocation.uid,
        member: invocation.value.target.member,
        op: 'invoke-capability',
      },
      {
        err: 3,
        ok: 2,
        op: 'branch-result',
        source: 0,
      },
      {
        code_literal: compileExitLiteral(branches.get('ok').value, literalIndex),
        op: 'process-exit',
      },
      {
        code_literal: compileExitLiteral(branches.get('err').value, literalIndex),
        op: 'process-exit',
      },
    ]
    const content = {
      graph_revision: graph.graph_revision,
      instructions,
      literals: literalEntries,
      profile: PORTABLE_BYTECODE_PROFILE,
      schema: PORTABLE_BYTECODE_ARTIFACT_SCHEMA,
    }
    const artifact = {
      ...content,
      artifact_digest: digest(content),
    }
    const validated = validatePortableBytecodeArtifact(artifact)
    return validated.ok ? { ok: true, value: artifact } : validated
  } catch (error) {
    return rejected(error?.code ?? 'portable-bytecode-compile-failed')
  }
}

export function portableBytecodeArtifactDigest(artifact) {
  if (!plainObject(artifact)) {
    throw new TypeError('invalid portable bytecode artifact')
  }
  const { artifact_digest: ignored, ...content } = artifact
  return digest(content)
}

export function validatePortableBytecodeArtifact(artifact) {
  const diagnostics = []
  if (!plainObject(artifact)
    || artifact.schema !== PORTABLE_BYTECODE_ARTIFACT_SCHEMA) {
    return rejected('portable-bytecode-artifact-schema-mismatch')
  }
  exactFields(artifact, [
    'artifact_digest',
    'graph_revision',
    'instructions',
    'literals',
    'profile',
    'schema',
  ], diagnostics)
  if (!DIGEST.test(artifact.graph_revision)) {
    diagnostics.push({ code: 'portable-bytecode-graph-revision-invalid' })
  }
  if (artifact.profile !== PORTABLE_BYTECODE_PROFILE) {
    diagnostics.push({ code: 'portable-bytecode-profile-mismatch' })
  }
  validateLiterals(artifact.literals, diagnostics)
  validateInstructions(artifact.instructions, artifact.literals, diagnostics)
  if (artifact.artifact_digest !== portableBytecodeArtifactDigest(artifact)) {
    diagnostics.push({ code: 'portable-bytecode-artifact-digest-mismatch' })
  }
  return verificationResult(diagnostics)
}

export function executePortableBytecode({
  artifact,
  checkedGraph,
  expectedArtifactDigest,
  expectedGraphRevision,
  invokeCapability,
} = {}) {
  const validated = validatePortableBytecodeArtifact(artifact)
  if (!validated.ok) return validated
  if (!plainObject(checkedGraph)) {
    return rejected('portable-bytecode-checked-graph-missing')
  }
  if (!DIGEST.test(expectedGraphRevision)
    || checkedGraph.graph_revision !== expectedGraphRevision
    || artifact.graph_revision !== expectedGraphRevision) {
    return rejected('portable-bytecode-graph-revision-mismatch')
  }
  const canonical = compilePortableBytecode(checkedGraph)
  if (!canonical.ok) {
    return rejected('portable-bytecode-checked-graph-invalid')
  }
  if (canonicalJson(artifact) !== canonicalJson(canonical.value)) {
    return rejected('portable-bytecode-checked-graph-artifact-mismatch')
  }
  if (!DIGEST.test(expectedArtifactDigest)
    || artifact.artifact_digest !== expectedArtifactDigest) {
    return rejected('portable-bytecode-artifact-identity-mismatch')
  }
  if (typeof invokeCapability !== 'function') {
    return rejected('portable-bytecode-capability-bridge-missing')
  }
  return executePortableBytecodeCore({
    artifact: canonical.value,
    invokeCapability,
  })
}

function compileArguments(call, literalIndex) {
  return Object.entries(call.typedArguments ?? {})
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, binding]) => {
      const literal = literalIndex.get(binding?.endpoint)
      if (literal === undefined) fail('portable-bytecode-literal-missing')
      return { literal, name }
    })
}

function compileExitLiteral(call, literalIndex) {
  const binding = call.typedArguments?.code
  const literal = literalIndex.get(binding?.endpoint)
  if (literal === undefined) fail('portable-bytecode-literal-missing')
  return literal
}

function validateLiterals(literals, diagnostics) {
  if (!Array.isArray(literals) || literals.length === 0) {
    diagnostics.push({ code: 'portable-bytecode-literal-invalid' })
    return
  }
  let previous = null
  for (const literal of literals) {
    if (!plainObject(literal)
      || !exactShape(literal, ['type', 'uid', 'value'])
      || typeof literal.uid !== 'string'
      || typeof literal.type !== 'string'
      || typeof literal.value !== 'string'
      || (literal.type === 'bytes'
        && !/^hex:(?:[0-9a-f]{2})*$/u.test(literal.value))
      || (literal.type === 'int' && !INTEGER.test(literal.value))
      || (previous !== null && compareText(previous, literal.uid) >= 0)) {
      diagnostics.push({ code: 'portable-bytecode-literal-invalid' })
    }
    previous = literal?.uid ?? previous
  }
}

function validateInstructions(instructions, literals, diagnostics) {
  if (!Array.isArray(instructions) || instructions.length !== 4) {
    diagnostics.push({ code: 'portable-bytecode-opcode-invalid' })
    return
  }
  const [invoke, branch, okExit, errExit] = instructions
  if (!plainObject(invoke)
    || !exactShape(invoke, [
      'arguments',
      'destination',
      'instance',
      'invocation_id',
      'member',
      'op',
    ])
    || invoke.op !== 'invoke-capability'
    || invoke.destination !== 0
    || typeof invoke.instance !== 'string'
    || typeof invoke.invocation_id !== 'string'
    || typeof invoke.member !== 'string'
    || !Array.isArray(invoke.arguments)) {
    diagnostics.push({ code: 'portable-bytecode-opcode-invalid' })
  } else {
    let previous = null
    for (const argument of invoke.arguments) {
      if (!plainObject(argument)
        || !exactShape(argument, ['literal', 'name'])
        || typeof argument.name !== 'string'
        || !literalReference(argument.literal, literals)
        || (previous !== null && compareText(previous, argument.name) >= 0)) {
        diagnostics.push({ code: 'portable-bytecode-literal-invalid' })
      }
      previous = argument?.name ?? previous
    }
  }
  if (!plainObject(branch)
    || !exactShape(branch, ['err', 'ok', 'op', 'source'])
    || branch.op !== 'branch-result') {
    diagnostics.push({ code: 'portable-bytecode-opcode-invalid' })
  } else {
    if (branch.source !== 0) {
      diagnostics.push({ code: 'portable-bytecode-register-invalid' })
    }
    if (branch.ok !== 2 || branch.err !== 3) {
      diagnostics.push({ code: 'portable-bytecode-jump-invalid' })
    }
  }
  for (const exit of [okExit, errExit]) {
    if (!plainObject(exit)
      || !exactShape(exit, ['code_literal', 'op'])
      || exit.op !== 'process-exit') {
      diagnostics.push({ code: 'portable-bytecode-opcode-invalid' })
    } else if (!literalReference(exit.code_literal, literals)
      || literals[exit.code_literal]?.type !== 'int') {
      diagnostics.push({ code: 'portable-bytecode-literal-invalid' })
    }
  }
}

function capabilityCall(call) {
  return plainObject(call)
    && call.kind === 'call'
    && call.target?.kind === 'capability-member'
    && typeof call.target.instance === 'string'
    && typeof call.target.member === 'string'
}

function processExitCall(call) {
  return plainObject(call)
    && call.kind === 'call'
    && call.target?.kind === 'pure-operation'
    && call.target.operation === 'process.exit'
}

function literalReference(value, literals) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value < (Array.isArray(literals) ? literals.length : 0)
}

function exactFields(value, expected, diagnostics) {
  if (!plainObject(value)) return
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) {
      diagnostics.push({
        code: 'portable-bytecode-artifact-unexpected-field',
        field,
      })
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      diagnostics.push({
        code: 'portable-bytecode-artifact-missing-field',
        field,
      })
    }
  }
}

function exactShape(value, expected) {
  return plainObject(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson(expected)
}

function compareText(left, right) {
  return Buffer.from(left ?? '').compare(Buffer.from(right ?? ''))
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function verificationResult(diagnostics) {
  return diagnostics.length === 0
    ? { ok: true }
    : { diagnostics, ok: false }
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function fail(code) {
  const error = new TypeError(code)
  error.code = code
  throw error
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
