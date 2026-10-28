import {
  SERVER_RANDOM_ADAPTER_CONTRACT,
  SERVER_RANDOM_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const RANDOM_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'random.bytes')

export class ServerRandomMemoryAdapter {
  #chunks
  #index = 0

  constructor({ chunks = [] } = {}) {
    if (!Array.isArray(chunks)) {
      throw new TypeError('random replay chunks must be Uint8Array values')
    }
    const snapshot = []
    const length = chunks.length
    for (let index = 0; index < length; index += 1) {
      const chunk = chunks[index]
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('random replay chunks must be Uint8Array values')
      }
      const bytes = snapshotUint8Array(chunk)
      if (bytes === null) {
        throw new TypeError('random replay chunks must be Uint8Array values')
      }
      snapshot.push(bytes)
    }
    this.#chunks = snapshot
  }

  adapterContract() {
    return SERVER_RANDOM_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_RANDOM_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(RANDOM_SCHEMA.resource_catalog)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_RANDOM_REFERENCE
      || operation.member !== 'fill'
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (!Number.isSafeInteger(typedArguments.length) || typedArguments.length < 0) {
      return declaredError('invalid_length')
    }
    if (this.#index >= this.#chunks.length) return declaredError('unavailable')
    const chunk = this.#chunks[this.#index]
    if (chunk.byteLength !== typedArguments.length) {
      throw new RangeError(
        `random replay chunk does not match requested length ${typedArguments.length}`,
      )
    }
    this.#index += 1
    return {
      kind: 'value',
      value: { kind: 'ok', value: new Uint8Array(chunk) },
    }
  }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'random.bytes_error', variant },
      kind: 'err',
    },
  }
}
