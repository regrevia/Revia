import {
  SERVER_LOG_ADAPTER_CONTRACT,
  SERVER_LOG_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const LOG_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'log.event')

export class ServerLogMemoryAdapter {
  #entries = []
  #unavailable

  constructor({ unavailable = false } = {}) {
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_LOG_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_LOG_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(LOG_SCHEMA.resource_catalog)
  }

  entries() {
    return structuredClone(this.#entries)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_LOG_REFERENCE
      || operation.member !== 'emit'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) {
      return {
        kind: 'value',
        value: {
          error: { type: 'log.write_error', variant: 'unavailable' },
          kind: 'err',
        },
      }
    }
    this.#entries.push(structuredClone(typedArguments))
    return { kind: 'value', value: { kind: 'ok', value: null } }
  }
}
