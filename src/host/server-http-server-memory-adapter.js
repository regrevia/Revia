import {
  SERVER_HTTP_SERVER_ADAPTER_CONTRACT,
  SERVER_HTTP_SERVER_REFERENCE,
  serverProfileSchemaDefinitions,
} from './server-profile.js'
import { snapshotUint8Array } from './uint8-array.js'

const HTTP_SERVER_SCHEMA = serverProfileSchemaDefinitions()
  .find(({ identity }) => identity === 'http.server')

export class ServerHttpServerMemoryAdapter {
  #active = new Map()
  #cancelled = new Set()
  #pending
  #responses = []
  #unavailable
  #maxResponseBytes
  #maxResponseChunkBytes

  constructor({
    maxResponseBytes = 1024 * 1024,
    maxResponseChunkBytes = 64 * 1024,
    requests = [],
    unavailable = false,
  } = {}) {
    if (!Array.isArray(requests)) {
      throw new TypeError('http server requests must be an Array')
    }
    validateResponseLimits(maxResponseBytes, maxResponseChunkBytes)
    const snapshot = []
    const length = requests.length
    for (let index = 0; index < length; index += 1) {
      const request = requests[index]
      validateRequest(request)
      const body = snapshotUint8Array(request.body)
      if (body === null) {
        throw new TypeError('invalid http server request')
      }
      snapshot.push({
        ...request,
        body,
        body_read_limit: null,
        response: null,
      })
    }
    this.#pending = snapshot
    this.#unavailable = unavailable
    this.#maxResponseBytes = maxResponseBytes
    this.#maxResponseChunkBytes = maxResponseChunkBytes
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

  responses() {
    return structuredClone(this.#responses)
  }

  invoke(operation, typedArguments) {
    if (
      operation.interface !== SERVER_HTTP_SERVER_REFERENCE
      || !Object.hasOwn(HTTP_SERVER_SCHEMA.members, operation.member)
    ) {
      throw new Error(`Unsupported operation: ${operation.interface}.${operation.member}`)
    }
    if (this.#unavailable) return declaredError('unavailable')
    if (operation.member === 'accept') {
      const index = this.#pending.findIndex(
        ({ listener }) => listener === typedArguments.listener,
      )
      if (index === -1) return declaredError('unavailable')
      const [request] = this.#pending.splice(index, 1)
      this.#active.set(request.id, request)
      return ok(request.id)
    }
    const request = this.#active.get(typedArguments.request)
    if (request === undefined) {
      const result = declaredError(
        this.#cancelled.has(typedArguments.request)
          ? 'cancelled'
          : 'invalid_request',
      )
      return operation.member === 'respond_drain'
        ? Promise.resolve(result)
        : result
    }
    if (operation.member === 'cancel') {
      this.#active.delete(request.id)
      this.#cancelled.add(request.id)
      return ok(null)
    }
    if (operation.member === 'respond') {
      const body = snapshotUint8Array(typedArguments.body)
      if (
        body === null
        || request.response !== null
        || !validResponse(typedArguments)
      ) {
        return declaredError('invalid_request')
      }
      if (body.length > this.#maxResponseBytes) {
        return this.#closeForResponseLimit(request)
      }
      this.#responses.push({
        body,
        headers: typedArguments.headers,
        request: request.id,
        status: typedArguments.status,
      })
      this.#active.delete(request.id)
      return ok(null)
    }
    if (operation.member === 'respond_start') {
      if (request.response !== null || !validResponseStart(typedArguments)) {
        return declaredError('invalid_request')
      }
      request.response = {
        body: [],
        headers: typedArguments.headers,
        status: typedArguments.status,
      }
      return ok(null)
    }
    if (operation.member === 'respond_chunk') {
      const body = snapshotUint8Array(typedArguments.body)
      if (request.response === null || body === null) {
        return declaredError('invalid_request')
      }
      const current = request.response.body.reduce((sum, chunk) => sum + chunk.length, 0)
      if (
        body.length > this.#maxResponseChunkBytes
        || current + body.length > this.#maxResponseBytes
      ) {
        return this.#closeForResponseLimit(request)
      }
      request.response.body.push(body)
      return ok('ready')
    }
    if (operation.member === 'respond_drain') {
      return Promise.resolve(
        request.response === null
          ? declaredError('invalid_request')
          : ok(null),
      )
    }
    if (operation.member === 'respond_end') {
      if (request.response === null) return declaredError('invalid_request')
      this.#responses.push({
        body: concatBytes(request.response.body),
        headers: request.response.headers,
        request: request.id,
        status: request.response.status,
      })
      this.#active.delete(request.id)
      return ok(null)
    }
    if (operation.member === 'body') {
      if (
        !Number.isSafeInteger(typedArguments.limit)
        || typedArguments.limit < 0
      ) {
        return declaredError('invalid_request')
      }
      if (request.body_read_limit === null) {
        request.body_read_limit = typedArguments.limit
      }
      if (
        request.body.length > request.body_read_limit
        || request.body.length > typedArguments.limit
      ) {
        return declaredError('body_too_large')
      }
      return ok(Uint8Array.from(request.body))
    }
    return ok(request[operation.member])
  }

  #closeForResponseLimit(request) {
    this.#active.delete(request.id)
    this.#cancelled.add(request.id)
    return declaredError('body_too_large')
  }
}

function validateResponseLimits(total, chunk) {
  if (
    !Number.isSafeInteger(total) || total < 1
    || !Number.isSafeInteger(chunk) || chunk < 1 || chunk > total
  ) {
    throw new TypeError('invalid http server response limits')
  }
}

function validResponse({ headers, status }) {
  return typeof headers === 'string'
    && Number.isSafeInteger(status)
    && status >= 100
    && status <= 599
}

function validResponseStart({ headers, status }) {
  return typeof headers === 'string'
    && Number.isSafeInteger(status)
    && status >= 100
    && status <= 599
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function validateRequest(request) {
  if (
    request === null
    || typeof request !== 'object'
    || !(request.body instanceof Uint8Array)
    || ['headers', 'id', 'listener', 'method', 'path', 'route_params']
      .some((field) => typeof request[field] !== 'string')
  ) {
    throw new TypeError('invalid http server request')
  }
}

function ok(value) {
  return { kind: 'value', value: { kind: 'ok', value } }
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
