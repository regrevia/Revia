import {
  SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
  SERVER_HTTP_CLIENT_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const HTTP_CLIENT_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'http.client')
const CLOSED_ERRORS = new Set(
  HTTP_CLIENT_SCHEMA.types['http.client_error'].variants,
)

export class ServerHttpClientMemoryAdapter {
  #responses
  #unavailable

  constructor({ unavailable = false, responses = new Map() } = {}) {
    if (!(responses instanceof Map)) {
      throw new TypeError('http client responses must be a Map')
    }
    const snapshot = []
    const iterator = Map.prototype.entries.call(responses)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [key, outcome] = step.value
      if (
        typeof key !== 'string'
        || (
          typeof outcome !== 'string'
          && (
            outcome === null
            || typeof outcome !== 'object'
            || !CLOSED_ERRORS.has(outcome.error)
          )
        )
      ) {
        throw new TypeError('http client responses must map request keys to text or closed errors')
      }
      snapshot.push([
        key,
        typeof outcome === 'string' ? outcome : { error: outcome.error },
      ])
    }
    this.#responses = new Map(snapshot)
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_HTTP_CLIENT_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_HTTP_CLIENT_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(HTTP_CLIENT_SCHEMA.resource_catalog)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_HTTP_CLIENT_REFERENCE
      || operation.member !== 'request'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    let key
    try {
      key = httpClientRequestKey(typedArguments)
    } catch {
      return declaredError('invalid_request')
    }
    const outcome = this.#responses.get(key)
    if (outcome === undefined) return declaredError('invalid_request')
    if (typeof outcome === 'string') {
      return {
        kind: 'value',
        value: { kind: 'ok', value: outcome },
      }
    }
    return declaredError(outcome.error)
  }
}

export function httpClientRequestKey({
  body,
  deadline,
  headers,
  method,
  redirect_policy: redirectPolicy,
  url,
}) {
  const requestBody = snapshotUint8Array(body)
  if (
    requestBody === null
    || !Number.isSafeInteger(deadline)
    || typeof headers !== 'string'
    || typeof method !== 'string'
    || typeof redirectPolicy !== 'string'
    || typeof url !== 'string'
  ) {
    throw new TypeError('invalid HTTP client request')
  }
  return JSON.stringify([
    method,
    url,
    headers,
    Buffer.from(requestBody).toString('hex'),
    deadline,
    redirectPolicy,
  ])
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'http.client_error', variant },
      kind: 'err',
    },
  }
}
