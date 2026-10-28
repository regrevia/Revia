import {
  agentAdapterContractDigest,
  validateAgentAdapterContract,
} from './agent-adapter-contract.js'
import { ServerHttpClientTransportAdapter } from './server-http-client-transport-adapter.js'

export class AgentHttpAdapter {
  #contract
  #profile
  #transport

  constructor({ contract, profile, transport = null, unavailable = false } = {}) {
    const validation = validateAgentAdapterContract(contract)
    if (!validation.ok) throw new TypeError(validation.diagnostics[0].code)
    this.#contract = validation.value
    this.#profile = snapshotProfile(profile)
    if (stableJson(this.#profile) !== stableJson(this.#contract.profile)) {
      throw new TypeError('agent adapter profile mismatch')
    }
    this.#transport = new ServerHttpClientTransportAdapter({
      transport,
      unavailable,
    })
  }

  adapterContract() {
    return agentAdapterContractDigest(this.#contract)
  }

  profileIdentity() {
    return structuredClone(this.#profile)
  }

  invoke(operation, typedArguments, context = {}) {
    if (context.cancellation === 'requested') {
      return { kind: 'cancelled' }
    }
    return this.#transport.invoke(operation, typedArguments)
  }
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
