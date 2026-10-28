export const PORTABLE_BYTECODE_RESULT_SCHEMA =
  're.portable-bytecode-result@0.1.0'

const INTEGER = /^(?:0|-?[1-9][0-9]*)$/u
const INVALID = Symbol('portable-bytecode-invalid')
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set

export function executePortableBytecodeCore({
  artifact,
  invokeCapability,
} = {}) {
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
          return rejected('portable-bytecode-capability-fault')
        }
        if (!plainObject(response)
          || !['check-failure', 'host-fault', 'value'].includes(response.kind)) {
          return rejected('portable-bytecode-capability-outcome-invalid')
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
          return rejected('portable-bytecode-capability-failed')
        }
        const variant = response?.value?.kind
        if (!['err', 'ok'].includes(variant)) {
          return rejected('portable-bytecode-result-invalid')
        }
        pc = instruction[variant]
        continue
      }
      const outcome = processExit(
        literalValue(artifact.literals[instruction.code_literal]),
      )
      if (outcome === INVALID) {
        return rejected('portable-bytecode-process-exit-invalid')
      }
      return {
        ok: true,
        value: {
          artifact_digest: artifact.artifact_digest,
          graph_revision: artifact.graph_revision,
          invocations,
          outcome,
          profile: artifact.profile,
          schema: PORTABLE_BYTECODE_RESULT_SCHEMA,
        },
      }
    }
    return rejected('portable-bytecode-termination-missing')
  } catch {
    return rejected('portable-bytecode-execution-failed')
  }
}

function literalValue(literal) {
  if (literal.type !== 'bytes') return literal.value
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
  if (typeof value !== 'string' || !INTEGER.test(value)) return INVALID
  const numeric = Number(BigInt(value))
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 255
    ? { code: numeric, type: 'process.status' }
    : INVALID
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

function rejected(code) {
  return { diagnostics: [{ code }], ok: false }
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
