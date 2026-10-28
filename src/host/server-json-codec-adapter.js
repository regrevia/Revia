import {
  SERVER_JSON_ADAPTER_CONTRACT,
  SERVER_JSON_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const JSON_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'data.json')

export class ServerJsonCodecAdapter {
  #codecs
  #unavailable

  constructor({ codecs = new Map(), unavailable = false } = {}) {
    if (!(codecs instanceof Map)) {
      throw new TypeError('json codecs must be a Map')
    }
    const entries = []
    const iterator = Map.prototype.entries.call(codecs)
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const [reference, codec] = step.value
      const encode = codec?.encode
      const decode = codec?.decode
      if (
        typeof reference !== 'string'
        || codec === null
        || typeof codec !== 'object'
        || typeof encode !== 'function'
        || typeof decode !== 'function'
      ) {
        throw new TypeError('json codecs must map references to encode/decode functions')
      }
      entries.push([
        reference,
        {
          decode: Function.prototype.bind.call(decode, codec),
          encode: Function.prototype.bind.call(encode, codec),
        },
      ])
    }
    this.#codecs = new Map(entries)
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
    const codec = this.#codecs.get(typedArguments.schema)
    if (codec === undefined) return declaredError('invalid_schema')

    try {
      if (operation.member === 'encode') {
        const encoded = codec.encode(typedArguments.value)
        return declaredValue(stableStringify(encoded))
      }
      const decoded = codec.decode(structuredClone(JSON.parse(typedArguments.payload)))
      if (typeof decoded !== 'string') return declaredError('invalid_json')
      return declaredValue(decoded)
    } catch {
      return declaredError('invalid_json')
    }
  }
}

function stableStringify(value) {
  return serializeJson(value, new Set())
}

function serializeJson(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError('unsupported JSON value')
  }
  if (ancestors.has(value)) throw new TypeError('cyclic JSON value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serializeJson(entry, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must be plain objects')
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${serializeJson(value[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function declaredValue(value) {
  return {
    kind: 'value',
    value: { kind: 'ok', value },
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
