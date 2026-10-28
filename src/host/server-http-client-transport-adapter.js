import {
  SERVER_HTTP_CLIENT_ADAPTER_CONTRACT,
  SERVER_HTTP_CLIENT_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { httpClientRequestKey } from './server-http-client-memory-adapter.js'
import { snapshotUint8Array } from './uint8-array.js'

const HTTP_CLIENT_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'http.client')
const CLOSED_ERRORS = new Set(
  HTTP_CLIENT_SCHEMA.types['http.client_error'].variants,
)

export class ServerHttpClientTransportAdapter {
  #transport
  #unavailable

  constructor({ transport = null, unavailable = false } = {}) {
    if (transport !== null && typeof transport !== 'function') {
      throw new TypeError('http client transport must be a function')
    }
    this.#transport = transport
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
    if (this.#unavailable || this.#transport === null) {
      return declaredError('unavailable')
    }

    let request
    try {
      request = {
        body: snapshotUint8Array(typedArguments.body),
        deadline: typedArguments.deadline,
        headers: typedArguments.headers,
        method: typedArguments.method,
        redirect_policy: typedArguments.redirect_policy,
        url: typedArguments.url,
      }
      if (request.body === null) throw new TypeError()
      httpClientRequestKey(request)
    } catch {
      return declaredError('invalid_request')
    }

    let outcome
    try {
      outcome = this.#transport(request)
    } catch {
      return declaredError('unavailable')
    }
    if (outcome instanceof Promise) {
      return outcome.then(
        normalizeTransportOutcome,
        () => declaredError('unavailable'),
      )
    }
    return normalizeTransportOutcome(outcome)
  }
}

function normalizeTransportOutcome(outcome) {
    if (typeof outcome === 'string') {
      return {
        kind: 'value',
        value: { kind: 'ok', value: outcome },
      }
    }
    if (
      outcome !== null
      && typeof outcome === 'object'
      && CLOSED_ERRORS.has(outcome.error)
    ) {
      return declaredError(outcome.error)
    }
    return declaredError('invalid_request')
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
