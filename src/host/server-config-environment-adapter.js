import {
  SERVER_CONFIG_ADAPTER_CONTRACT,
  SERVER_CONFIG_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const CONFIG_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'config.read')

export class ServerConfigEnvironmentAdapter {
  #environment
  #unavailable

  constructor({ environment = {}, unavailable = false } = {}) {
    if (
      environment === null
      || typeof environment !== 'object'
      || Array.isArray(environment)
    ) {
      throw new TypeError('environment must be an object')
    }
    const entries = Object.entries(environment)
    if (entries.some(([, value]) => typeof value !== 'string')) {
      throw new TypeError('environment values must be strings')
    }
    this.#environment = new Map(entries)
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_CONFIG_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_CONFIG_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(CONFIG_SCHEMA.resource_catalog)
  }

  resourceParents() {
    return structuredClone(CONFIG_SCHEMA.resource_parents)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_CONFIG_REFERENCE
      || operation.member !== 'get'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    if (!this.#environment.has(typedArguments.key)) {
      return declaredError('not_found')
    }
    return {
      kind: 'value',
      value: { kind: 'ok', value: this.#environment.get(typedArguments.key) },
    }
  }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'config.read_error', variant },
      kind: 'err',
    },
  }
}
