import {
  SERVER_CONFIG_ADAPTER_CONTRACT,
  SERVER_CONFIG_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const [CONFIG_SCHEMA] = serverProfileSchemaDefinitions()

export class ServerConfigMemoryAdapter {
  #unavailable
  #values

  constructor({ unavailable = false, values = new Map() } = {}) {
    if (!(values instanceof Map)) {
      throw new TypeError('config values must be a Map')
    }
    const snapshot = []
    const iterator = Map.prototype.entries.call(values)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [key, value] = step.value
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new TypeError('config values must map text keys to text values')
      }
      snapshot.push([key, value])
    }
    this.#unavailable = unavailable
    this.#values = new Map(snapshot)
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
    if (!this.#values.has(typedArguments.key)) return declaredError('not_found')
    return {
      kind: 'value',
      value: { kind: 'ok', value: this.#values.get(typedArguments.key) },
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
