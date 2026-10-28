import {
  agentAdapterContractDigest,
  validateAgentAdapterContract,
} from './agent-adapter-contract.js'
import { ServerHttpClientTransportAdapter } from './server-http-client-transport-adapter.js'
import { createServerHttpClientFetchTransport } from './server-http-client-fetch-transport.js'

const BUSINESS_RESPONSE_FIELDS = ['kind', 'value']
const BUSINESS_ERROR_RESPONSE_FIELDS = ['error', 'kind']

export class AgentBusinessHttpAdapter {
  #contract
  #profile
  #endpoint
  #timeout
  #transport

  constructor({
    contract,
    endpoint,
    profile,
    timeout_ms = 1000,
    transport = createServerHttpClientFetchTransport(),
    unavailable = false,
  } = {}) {
    const validation = validateAgentAdapterContract(contract)
    if (!validation.ok) throw new TypeError(validation.diagnostics[0].code)
    this.#contract = validation.value
    this.#profile = snapshotProfile(profile)
    if (!same(this.#profile, this.#contract.profile)) {
      throw new TypeError('agent adapter profile mismatch')
    }
    this.#endpoint = validateEndpoint(endpoint)
    if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 0) {
      throw new TypeError('invalid agent HTTP timeout')
    }
    this.#timeout = timeout_ms
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
    if (
      operation?.interface !== this.#contract.capability.reference
      || operation.member !== this.#contract.capability.member
      || context.cancellation === 'requested'
    ) {
      if (context.cancellation === 'requested') return { kind: 'cancelled' }
      return { kind: 'host-fault' }
    }

    let body
    try {
      body = Buffer.from(stableJson(projectBoundaryValue(typedArguments)), 'utf8')
    } catch {
      return { kind: 'host-fault' }
    }
    const transportOutcome = this.#transport.invoke(
      {
        interface: 'http.client@0.1.0',
        member: 'request',
      },
      {
        body,
        deadline: this.#timeout,
        headers: 'content-type:application/json',
        method: 'POST',
        redirect_policy: 'reject',
        url: this.#endpoint,
      },
    )
    if (transportOutcome instanceof Promise) {
      return transportOutcome.then((outcome) =>
        this.#decodeTransportOutcome(outcome))
    }
    return this.#decodeTransportOutcome(transportOutcome)
  }

  #decodeTransportOutcome(outcome) {
    if (outcome?.kind !== 'value' || outcome.value === null
      || typeof outcome.value !== 'object' || Array.isArray(outcome.value)) {
      return { kind: 'host-fault' }
    }
    if (outcome.value.kind === 'err') {
      if (outcome.value.error?.variant === 'unavailable') {
        return declaredError(this.#contract, 'unavailable')
      }
      return { kind: 'host-fault' }
    }
    if (outcome.value.kind !== 'ok' || typeof outcome.value.value !== 'string') {
      return { kind: 'host-fault' }
    }
    return decodeBusinessResponse(this.#contract, outcome.value.value)
  }
}

function decodeBusinessResponse(contract, encoded) {
  let response
  try {
    response = JSON.parse(encoded)
  } catch {
    return { kind: 'host-fault' }
  }
  if (
    response === null
    || typeof response !== 'object'
    || Array.isArray(response)
    || Object.keys(response).sort().join(',') !== 'body,status'
    || response.status !== 200
    || typeof response.body !== 'string'
  ) {
    return { kind: 'host-fault' }
  }
  let business
  try {
    business = JSON.parse(response.body)
  } catch {
    return { kind: 'host-fault' }
  }
  if (
    business === null
    || typeof business !== 'object'
    || Array.isArray(business)
  ) {
    return { kind: 'host-fault' }
  }
  const fields = Object.keys(business).sort().join(',')
  if (business.kind === 'ok') {
    if (fields !== BUSINESS_RESPONSE_FIELDS.join(',')
      || business.value === undefined) {
      return { kind: 'host-fault' }
    }
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value: projectCanonicalValue(business.value),
      },
    }
  }
  if (business.kind === 'err') {
    if (fields !== BUSINESS_ERROR_RESPONSE_FIELDS.join(',')
      || business.error === null
      || typeof business.error !== 'object'
      || Array.isArray(business.error)
      || Object.keys(business.error).sort().join(',') !== 'type,variant'
      || business.error.type !== contract.error_type.name
      || !contract.error_variants.includes(business.error.variant)) {
      return { kind: 'host-fault' }
    }
    return {
      kind: 'value',
      value: {
        error: { ...business.error },
        kind: 'err',
      },
    }
  }
  return { kind: 'host-fault' }
}

function declaredError(contract, variant) {
  if (!contract.error_variants.includes(variant)) return { kind: 'host-fault' }
  return {
    kind: 'value',
    value: {
      error: {
        type: contract.error_type.name,
        variant,
      },
      kind: 'err',
    },
  }
}

function validateEndpoint(input) {
  if (typeof input !== 'string' || input.length === 0
    || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new TypeError('invalid agent HTTP endpoint')
  }
  let url
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('invalid agent HTTP endpoint')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.pathname === ''
  ) {
    throw new TypeError('invalid agent HTTP endpoint')
  }
  return url.href
}

function snapshotProfile(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('invalid agent profile')
  }
  return structuredClone(profile)
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

function projectBoundaryValue(value) {
  const output = structuredClone(value)
  if (!Object.hasOwn(output, 'currency')) return output
  const currency = output.currency
  if (
    currency === null
    || typeof currency !== 'object'
    || Array.isArray(currency)
    || Object.keys(currency).join(',') !== 'variant'
    || typeof currency.variant !== 'string'
  ) {
    throw new TypeError('invalid project currency value')
  }
  output.currency = currency.variant
  return output
}

function projectCanonicalValue(value) {
  const output = structuredClone(value)
  if (
    output !== null
    && typeof output === 'object'
    && !Array.isArray(output)
    && Object.hasOwn(output, 'currency')
    && typeof output.currency === 'string'
  ) {
    output.currency = { variant: output.currency }
  }
  return output
}
