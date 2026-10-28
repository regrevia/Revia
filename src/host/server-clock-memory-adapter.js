import {
  SERVER_CLOCK_ADAPTER_CONTRACT,
  SERVER_CLOCK_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const CLOCK_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'clock.monotonic')

export class ServerClockMemoryAdapter {
  #index = 0
  #instants

  constructor({ instants = [] } = {}) {
    if (!Array.isArray(instants)) {
      throw new TypeError('monotonic clock instants must be nondecreasing safe integers')
    }
    const snapshot = []
    const length = instants.length
    for (let index = 0; index < length; index += 1) {
      const value = instants[index]
      if (
        !Number.isSafeInteger(value)
        || value < 0
        || (index > 0 && value < snapshot[index - 1])
      ) {
        throw new TypeError('monotonic clock instants must be nondecreasing safe integers')
      }
      snapshot.push(value)
    }
    this.#instants = snapshot
  }

  adapterContract() {
    return SERVER_CLOCK_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_CLOCK_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(CLOCK_SCHEMA.resource_catalog)
  }

  invoke(operation) {
    if (
      operation.interface !== SERVER_CLOCK_REFERENCE
      || operation.member !== 'now'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#index >= this.#instants.length) {
      return {
        kind: 'value',
        value: {
          error: { type: 'clock.monotonic_error', variant: 'unavailable' },
          kind: 'err',
        },
      }
    }
    const value = this.#instants[this.#index]
    this.#index += 1
    return { kind: 'value', value: { kind: 'ok', value } }
  }
}
