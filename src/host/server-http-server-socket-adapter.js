import {
  SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
  SERVER_HTTP_SERVER_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'

const HTTP_SERVER_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'http.server')
const MEMBERS = Object.keys(HTTP_SERVER_SCHEMA.members)
const TEXT_MEMBERS = new Set(['headers', 'method', 'path', 'route_params'])
const CLOSED_ERRORS = new Set(
  HTTP_SERVER_SCHEMA.types['http.server_error'].variants,
)
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set

export class ServerHttpServerSocketAdapter {
  #driver
  #unavailable

  constructor({ driver = null, unavailable = false } = {}) {
    if (
      driver !== null
      && (typeof driver !== 'object' || Array.isArray(driver))
    ) {
      throw new TypeError('http server driver must be an object')
    }
    if (driver === null) {
      this.#driver = null
    } else {
      const methods = []
      for (const member of MEMBERS) {
        const method = driver[member]
        if (typeof method !== 'function') continue
        methods.push([
          member,
          Function.prototype.bind.call(method, driver),
        ])
      }
      this.#driver = Object.fromEntries(methods)
    }
    this.#unavailable = unavailable
  }

  adapterContract() {
    return SERVER_HTTP_SERVER_ADAPTER_CONTRACT
  }

  supportedInterfaces() {
    return [SERVER_HTTP_SERVER_REFERENCE]
  }

  resourceCatalog() {
    return structuredClone(HTTP_SERVER_SCHEMA.resource_catalog)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_HTTP_SERVER_REFERENCE
      || !Object.hasOwn(HTTP_SERVER_SCHEMA.members, operation.member)
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable || this.#driver === null) {
      return declaredError('unavailable')
    }
    const driverMethod = this.#driver[operation.member]
    if (typeof driverMethod !== 'function') return declaredError('unavailable')

    let request
    try {
      request = copyRequest(operation.member, typedArguments)
    } catch (error) {
      return declaredError(
        operation.member === 'body' && error.code === 'body_too_large'
          ? 'body_too_large'
          : 'invalid_request',
      )
    }

    let outcome
    try {
      outcome = driverMethod(request)
    } catch {
      return declaredError('unavailable')
    }
    if (outcome instanceof Promise) {
      return outcome.then(
        (value) => normalizeDriverOutcome(operation.member, value),
        () => declaredError('unavailable'),
      )
    }
    return normalizeDriverOutcome(operation.member, outcome)
  }
}

function normalizeDriverOutcome(member, outcome) {
    if (
      outcome !== null
      && typeof outcome === 'object'
      && !Array.isArray(outcome)
      && Object.keys(outcome).length === 1
      && Object.hasOwn(outcome, 'error')
      && CLOSED_ERRORS.has(outcome.error)
    ) {
      return declaredError(outcome.error)
    }
    if (!validSuccess(member, outcome)) {
      return declaredError('unavailable')
    }
    const value = outcome instanceof Uint8Array
      ? snapshotBytes(outcome)
      : outcome
    if (value === null && outcome instanceof Uint8Array) {
      return declaredError('unavailable')
    }
    return {
      kind: 'value',
      value: {
        kind: 'ok',
        value,
      },
    }
}

function copyRequest(member, typedArguments) {
  if (member === 'accept') {
    if (typeof typedArguments.listener !== 'string') throw new TypeError()
    return { listener: typedArguments.listener }
  }
  if (member === 'body') {
    if (
      typeof typedArguments.request !== 'string'
      || !Number.isSafeInteger(typedArguments.limit)
      || typedArguments.limit < 0
    ) {
      throw new TypeError()
    }
    return {
      limit: typedArguments.limit,
      request: typedArguments.request,
    }
  }
  if (
    TEXT_MEMBERS.has(member)
    || member === 'cancel'
    || member === 'respond_drain'
    || member === 'respond_end'
  ) {
    if (typeof typedArguments.request !== 'string') throw new TypeError()
    return { request: typedArguments.request }
  }
  if (member === 'respond') {
    const body = snapshotBytes(typedArguments.body)
    if (
      body === null
      || typeof typedArguments.headers !== 'string'
      || typeof typedArguments.request !== 'string'
      || !Number.isSafeInteger(typedArguments.status)
    ) {
      throw new TypeError()
    }
    return {
      body,
      headers: typedArguments.headers,
      request: typedArguments.request,
      status: typedArguments.status,
    }
  }
  if (member === 'respond_chunk') {
    const body = snapshotBytes(typedArguments.body)
    if (
      body === null
      || typeof typedArguments.request !== 'string'
    ) {
      throw new TypeError()
    }
    return {
      body,
      request: typedArguments.request,
    }
  }
  if (member === 'respond_start') {
    if (
      typeof typedArguments.headers !== 'string'
      || typeof typedArguments.request !== 'string'
      || !Number.isSafeInteger(typedArguments.status)
    ) {
      throw new TypeError()
    }
    return {
      headers: typedArguments.headers,
      request: typedArguments.request,
      status: typedArguments.status,
    }
  }
  throw new TypeError()
}

function snapshotBytes(value) {
  if (!(value instanceof Uint8Array)) return null
  try {
    const bytes = new Uint8Array(
      Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []),
    )
    Reflect.apply(TYPED_ARRAY_SET, bytes, [value])
    return bytes
  } catch {
    return null
  }
}

function validSuccess(member, outcome) {
  if (member === 'accept') return typeof outcome === 'string' && outcome.length > 0
  if (TEXT_MEMBERS.has(member)) return typeof outcome === 'string'
  if (member === 'respond_chunk') return outcome === 'ready' || outcome === 'blocked'
  if (member === 'body') return outcome instanceof Uint8Array
  return outcome === null
}

function declaredError(variant) {
  return {
    kind: 'value',
    value: {
      error: { type: 'http.server_error', variant },
      kind: 'err',
    },
  }
}
