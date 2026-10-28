import {
  SERVER_SECRET_ADAPTER_CONTRACT,
  SERVER_SECRET_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const SECRET_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'secret.read')

export class ServerSecretMemoryAdapter {
  #unavailable
  #values

  constructor({ unavailable = false, values = new Map() } = {}) {
    if (!(values instanceof Map)) {
      throw new TypeError('secret values must be a Map')
    }
    const entries = []
    const iterator = Map.prototype.entries.call(values)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [name, value] = step.value
      const bytes = snapshotUint8Array(value)
      if (typeof name !== 'string' || bytes === null) {
        throw new TypeError('secret values must map text names to Uint8Array')
      }
      entries.push([name, bytes])
    }
    this.#unavailable = unavailable
    this.#values = new Map(entries)
  }

  adapterContract() {
    return SERVER_SECRET_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_SECRET_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(SECRET_SCHEMA.resource_catalog)
  }

  resourceParents() {
    return structuredClone(SECRET_SCHEMA.resource_parents)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_SECRET_REFERENCE
      || operation.member !== 'get'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    if (!this.#values.has(typedArguments.name)) return declaredError('not_found')
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value: new Uint8Array(this.#values.get(typedArguments.name)),
      },
    }
  }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'secret.read_error', variant },
      kind: 'err',
    },
  }
}
