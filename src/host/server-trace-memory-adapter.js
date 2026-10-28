import {
  SERVER_TRACE_ADAPTER_CONTRACT,
  SERVER_TRACE_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const TRACE_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'trace.event')

export class ServerTraceMemoryAdapter {
  #events = []
  #unavailable

  constructor({ unavailable = false } = {}) {
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_TRACE_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_TRACE_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(TRACE_SCHEMA.resource_catalog)
  }

  events() {
    return structuredClone(this.#events)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_TRACE_REFERENCE
      || operation.member !== 'record'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) {
      return {
        kind: 'value',
        value: {
          error: { type: 'trace.write_error', variant: 'unavailable' },
          kind: 'err',
        },
      }
    }
    this.#events.push(structuredClone(typedArguments))
    return { kind: 'value', value: { kind: 'ok', value: null } }
  }
}
