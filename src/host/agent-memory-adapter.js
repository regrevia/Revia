import {
  agentAdapterContractDigest,
  validateAgentAdapterContract,
} from './agent-adapter-contract.js'

export class AgentMemoryAdapter {
  #contract
  #profile
  #responses

  constructor({ contract, profile, responses = new Map() } = {}) {
    const validation = validateAgentAdapterContract(contract)
    if (!validation.ok) throw new TypeError(validation.diagnostics[0].code)
    if (!(responses instanceof Map)) throw new TypeError('agent responses must be a Map')
    this.#contract = validation.value
    this.#profile = snapshotProfile(profile)
    if (!same(this.#profile, this.#contract.profile)) {
      throw new TypeError('agent adapter profile mismatch')
    }
    const entries = []
    for (const [key, outcome] of Map.prototype.entries.call(responses)) {
      if (typeof key !== 'string' || !isOutcome(outcome)) {
        throw new TypeError('agent responses must map keys to closed outcomes')
      }
      entries.push([key, structuredClone(outcome)])
    }
    this.#responses = new Map(entries)
  }

  adapterContract() {
    return agentAdapterContractDigest(this.#contract)
  }

  profileIdentity() {
    return structuredClone(this.#profile)
  }

  invoke(operation, typedArguments, context = {}) {
    if (
      operation.interface !== this.#contract.capability.reference
      || operation.member !== this.#contract.capability.member
    ) {
      throw new Error('unsupported agent operation')
    }
    if (context.cancellation === 'requested') {
      return { kind: 'cancelled' }
    }
    const key = stableJson(typedArguments)
    const outcome = this.#responses.get(key)
    if (outcome === undefined) {
      return {
        kind: 'value',
        value: {
          error: {
            type: this.#contract.error_type.name,
            variant: 'unavailable',
          },
          kind: 'err',
        },
      }
    }
    return structuredClone(outcome)
  }
}

export function agentMemoryResponseKey(input) {
  return stableJson(input)
}

function isOutcome(value) {
  return value?.kind === 'value'
    && value.value !== null
    && typeof value.value === 'object'
    && ['ok', 'err'].includes(value.value.kind)
}

function snapshotProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('invalid agent profile')
  }
  const identity = profile.profile_digest === undefined
    ? profile
    : {
      digest: profile.profile_digest,
      id: profile.id,
      schema: profile.schema,
    }
  return structuredClone(identity)
}

function same(left, right) {
  return stableJson(left) === stableJson(right)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    if (value instanceof Uint8Array) {
      return `{"$bytes":"${Buffer.from(value).toString('hex')}"}`
    }
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}
