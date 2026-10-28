import {
  SERVER_JSON_ADAPTER_CONTRACT,
  SERVER_JSON_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const JSON_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'data.json')

export class ServerJsonMemoryAdapter {
  #schemas
  #unavailable

  constructor({ unavailable = false, schemas = new Map() } = {}) {
    if (!(schemas instanceof Map)) {
      throw new TypeError('json schemas must be a Map')
    }
    const snapshot = []
    const schemaIterator = Map.prototype.entries.call(schemas)
    for (
      let schemaStep = schemaIterator.next();
      !schemaStep.done;
      schemaStep = schemaIterator.next()
    ) {
      const [reference, schema] = schemaStep.value
      if (
        typeof reference !== 'string'
        || schema === null
        || typeof schema !== 'object'
        || !(schema.encode instanceof Map)
        || !(schema.decode instanceof Map)
      ) {
        throw new TypeError('json schemas must map references to encode/decode Maps')
      }
      const operations = {}
      for (const operation of ['encode', 'decode']) {
        const entries = []
        const iterator = Map.prototype.entries.call(schema[operation])
        for (let step = iterator.next(); !step.done; step = iterator.next()) {
          const [input, output] = step.value
          if (typeof input !== 'string' || typeof output !== 'string') {
            throw new TypeError('json schema entries must map text to text')
          }
          entries.push([input, output])
        }
        operations[operation] = new Map(entries)
      }
      snapshot.push([reference, operations])
    }
    this.#schemas = new Map(snapshot)
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_JSON_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_JSON_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(JSON_SCHEMA.resource_catalog)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_JSON_REFERENCE
      || !['encode', 'decode'].includes(operation.member)
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    const schema = this.#schemas.get(typedArguments.schema)
    if (schema === undefined) return declaredError('invalid_schema')
    const input = operation.member === 'encode'
      ? typedArguments.value
      : typedArguments.payload
    if (!schema[operation.member].has(input)) return declaredError('invalid_json')
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value: schema[operation.member].get(input),
      },
    }
  }
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'data.json_error', variant },
      kind: 'err',
    },
  }
}
