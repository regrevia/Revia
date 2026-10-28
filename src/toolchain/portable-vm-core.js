export const PORTABLE_VM_CORE_PROFILE = 're.portable-vm-core@0.1.0'
export const PORTABLE_VM_CORE_RESULT_SCHEMA = 're.portable-vm-core-result@0.1.0'

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/u
const ADMISSIONS = new WeakMap()
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set

// The caller owns cryptographic artifact admission; this core only consumes it.
export function admitPortableVmCore({ artifact, request } = {}) {
  if (!validRequest(request)) return rejected('portable-vm-core-request-invalid')
  if (!validArtifact(artifact)
    || artifact.artifact_digest !== request.artifact_digest
    || artifact.graph_revision !== request.graph_revision) {
    return rejected('portable-vm-core-artifact-request-mismatch')
  }
  const admission = Object.freeze(Object.create(null))
  ADMISSIONS.set(admission, freezeValue({
    artifact: snapshotValue(artifact),
    request: snapshotValue(request),
  }))
  return { ok: true, value: admission }
}

export function executePortableVmCore({ admission, invokeCapability } = {}) {
  const input = ADMISSIONS.get(admission)
  if (input === undefined) return rejected('portable-vm-core-admission-missing')
  if (typeof invokeCapability !== 'function') {
    return rejected('portable-vm-core-capability-bridge-missing')
  }
  const { artifact, request } = input
  const registers = new Map()
  const invocations = []
  let pc = 0
  try {
    while (pc < artifact.instructions.length) {
      const instruction = artifact.instructions[pc]
      if (instruction.op === 'invoke-capability') {
        const args = Object.fromEntries(instruction.arguments.map((argument) => [
          argument.name,
          literalValue(artifact.literals[argument.literal]),
        ]))
        let response
        try {
          response = snapshotValue(invokeCapability(
            instruction.instance,
            instruction.member,
            args,
            instruction.invocation_id,
          ))
        } catch {
          return rejected('portable-vm-core-capability-fault')
        }
        if (!plainObject(response)
          || !['check-failure', 'host-fault', 'value'].includes(response.kind)) {
          return rejected('portable-vm-core-capability-outcome-invalid')
        }
        registers.set(instruction.destination, response)
        invocations.push({
          instance: instruction.instance,
          invocation_id: instruction.invocation_id,
          member: instruction.member,
          outcome: invocationOutcome(response),
        })
        pc += 1
        continue
      }
      if (instruction.op === 'branch-result') {
        const response = registers.get(instruction.source)
        if (response?.kind === 'host-fault' || response?.kind === 'check-failure') {
          return rejected('portable-vm-core-capability-failed')
        }
        const variant = response?.value?.kind
        if (!['err', 'ok'].includes(variant)) {
          return rejected('portable-vm-core-result-invalid')
        }
        pc = instruction[variant]
        continue
      }
      const outcome = processExit(
        literalValue(artifact.literals[instruction.code_literal]),
      )
      if (outcome === null) return rejected('portable-vm-core-process-exit-invalid')
      return {
        ok: true,
        value: {
          artifact_digest: request.artifact_digest,
          graph_revision: request.graph_revision,
          invocations,
          outcome,
          profile: PORTABLE_VM_CORE_PROFILE,
          schema: PORTABLE_VM_CORE_RESULT_SCHEMA,
        },
      }
    }
    return rejected('portable-vm-core-termination-missing')
  } catch {
    return rejected('portable-vm-core-execution-failed')
  }
}

function validRequest(value) {
  return exactShape(value, [
    'artifact_digest',
    'graph_revision',
    'input_digest',
    'profile',
    'request_digest',
    'schema',
    'transcript_digest',
    'workload_digest',
    'workload_id',
  ])
    && value.schema === 're.portable-equivalence-request@0.1.0'
    && value.profile === 're.portable-equivalence@0.1.0'
    && typeof value.workload_id === 'string'
    && ['artifact_digest', 'graph_revision', 'input_digest', 'request_digest',
      'transcript_digest', 'workload_digest'].every((field) => DIGEST.test(value[field]))
}

function validArtifact(value) {
  if (!exactShape(value, [
    'artifact_digest',
    'graph_revision',
    'instructions',
    'literals',
    'profile',
    'schema',
  ])
    || value.schema !== 're.portable-bytecode-artifact@0.1.0'
    || value.profile !== 're.portable-bytecode@0.1.0'
    || !DIGEST.test(value.artifact_digest)
    || !DIGEST.test(value.graph_revision)
    || !Array.isArray(value.literals)
    || !Array.isArray(value.instructions)
    || value.instructions.length !== 4) return false

  const [invoke, branch, okExit, errExit] = value.instructions
  return exactShape(invoke, [
    'arguments', 'destination', 'instance', 'invocation_id', 'member', 'op',
  ])
    && invoke.op === 'invoke-capability'
    && invoke.destination === 0
    && typeof invoke.instance === 'string'
    && typeof invoke.invocation_id === 'string'
    && typeof invoke.member === 'string'
    && Array.isArray(invoke.arguments)
    && invoke.arguments.every(({ literal, name }) => (
      Number.isSafeInteger(literal) && literal >= 0 && literal < value.literals.length
      && typeof name === 'string'
    ))
    && exactShape(branch, ['err', 'ok', 'op', 'source'])
    && branch.op === 'branch-result'
    && branch.source === 0
    && branch.ok === 2
    && branch.err === 3
    && [okExit, errExit].every((exit) => (
      exactShape(exit, ['code_literal', 'op'])
      && exit.op === 'process-exit'
      && Number.isSafeInteger(exit.code_literal)
      && value.literals[exit.code_literal]?.type === 'int'
    ))
}

function literalValue(literal) {
  if (!plainObject(literal)) throw new TypeError('invalid literal')
  if (literal.type !== 'bytes') return literal.value
  if (!/^hex:(?:[0-9a-f]{2})*$/u.test(literal.value)) {
    throw new TypeError('invalid bytes literal')
  }
  const bytes = new Uint8Array((literal.value.length - 4) / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      literal.value.slice(4 + index * 2, 6 + index * 2),
      16,
    )
  }
  return bytes
}

function processExit(value) {
  if (typeof value !== 'string' || !INTEGER.test(value)) return null
  const numeric = Number(BigInt(value))
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 255
    ? { code: numeric, type: 'process.status' }
    : null
}

function invocationOutcome(value) {
  if (value?.kind === 'value' && value.value?.kind === 'ok') return 'ok'
  if (value?.kind === 'value' && value.value?.kind === 'err') return 'err'
  if (value?.kind === 'host-fault') return 'host-fault'
  if (value?.kind === 'check-failure') return 'check-failure'
  return 'invalid'
}

function snapshotValue(value) {
  if (value instanceof Uint8Array) {
    const bytes = new Uint8Array(
      Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []),
    )
    Reflect.apply(TYPED_ARRAY_SET, bytes, [value])
    return bytes
  }
  if (Array.isArray(value)) return value.map(snapshotValue)
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, snapshotValue(child)]),
    )
  }
  return value
}

function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue))
  if (plainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freezeValue(child)]),
    ))
  }
  return value
}

function exactShape(value, fields) {
  return plainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}
