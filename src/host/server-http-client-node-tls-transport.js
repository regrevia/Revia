import { request as nodeHttpsRequest } from 'node:https'

import { snapshotUint8Array } from './uint8-array.js'

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const MAX_RESPONSE_BYTES = 1024 * 1024

export function createServerHttpClientNodeTlsTransport({
  ca,
  clearTimeoutImpl = clearTimeout,
  requestImpl = nodeHttpsRequest,
  setTimeoutImpl = setTimeout,
} = {}) {
  const caBytes = snapshotUint8Array(ca)
  if (caBytes === null || caBytes.length === 0) {
    throw new TypeError('http client TLS transport requires a CA certificate')
  }
  if (
    typeof clearTimeoutImpl !== 'function'
    || typeof requestImpl !== 'function'
    || typeof setTimeoutImpl !== 'function'
  ) {
    throw new TypeError('http client TLS transport requires host functions')
  }
  const trustedCa = Buffer.from(caBytes)

  return function nodeTlsTransport(request) {
    const prepared = prepareRequest(request)
    if (!prepared.ok) return Promise.resolve({ error: 'invalid_request' })
    return invokeTlsRequest({
      clearTimeoutImpl,
      requestImpl,
      request: prepared.value,
      setTimeoutImpl,
      trustedCa,
    })
  }
}

function invokeTlsRequest({
  clearTimeoutImpl,
  requestImpl,
  request,
  setTimeoutImpl,
  trustedCa,
}) {
  return new Promise((resolve) => {
    let deadlineExceeded = false
    let settled = false
    let timer = null
    let clientRequest
    const settle = (outcome) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        try {
          clearTimeoutImpl(timer)
        } catch {
          // The transport outcome remains authoritative.
        }
      }
      resolve(outcome)
    }

    try {
      clientRequest = requestImpl(request.url, {
        ca: trustedCa,
        headers: request.headers,
        method: request.method,
        rejectUnauthorized: true,
      }, (response) => {
        const status = response?.statusCode
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          clientRequest.destroy()
          settle({ error: 'unavailable' })
          return
        }
        if (
          request.redirectPolicy === 'reject'
          && status >= 300
          && status < 400
        ) {
          response.resume()
          settle({ error: 'redirect_rejected' })
          return
        }
        const chunks = []
        let responseBytes = 0
        response.on('data', (chunk) => {
          if (settled) return
          const bytes = snapshotUint8Array(chunk)
          if (bytes === null || responseBytes + bytes.length > MAX_RESPONSE_BYTES) {
            clientRequest.destroy()
            settle({ error: 'unavailable' })
            return
          }
          responseBytes += bytes.length
          chunks.push(bytes)
        })
        response.once('aborted', () => settle({ error: 'unavailable' }))
        response.once('error', () => settle({ error: 'unavailable' }))
        response.once('end', () => {
          if (settled) return
          try {
            const body = new TextDecoder('utf-8', { fatal: true })
              .decode(concatenate(chunks, responseBytes))
            settle(JSON.stringify({ status, body }))
          } catch {
            settle({ error: 'unavailable' })
          }
        })
      })
      clientRequest.once('error', () => {
        settle({
          error: deadlineExceeded ? 'deadline_exceeded' : 'unavailable',
        })
      })
      timer = setTimeoutImpl(() => {
        if (settled) return
        deadlineExceeded = true
        clientRequest.destroy()
        settle({ error: 'deadline_exceeded' })
      }, request.deadline)
      if (request.body.length > 0) clientRequest.write(request.body)
      clientRequest.end()
    } catch {
      try {
        clientRequest?.destroy()
      } catch {
        // The sanitized unavailable result remains authoritative.
      }
      settle({ error: 'unavailable' })
    }
  })
}

function prepareRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false }
  }
  const body = snapshotUint8Array(request.body)
  if (
    body === null
    || !Number.isSafeInteger(request.deadline)
    || request.deadline < 0
    || typeof request.headers !== 'string'
    || typeof request.method !== 'string'
    || !HTTP_TOKEN.test(request.method)
    || (
      (request.method.toUpperCase() === 'GET'
        || request.method.toUpperCase() === 'HEAD')
      && body.length > 0
    )
    || request.redirect_policy !== 'reject'
    || typeof request.url !== 'string'
    || /[\u0000-\u001f\u007f]/u.test(request.url)
    || hasUnpairedSurrogate(request.url)
  ) {
    return { ok: false }
  }
  try {
    const url = new URL(request.url)
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.hash !== ''
    ) {
      return { ok: false }
    }
    return {
      ok: true,
      value: {
        body,
        deadline: request.deadline,
        headers: parseHeaders(request.headers),
        method: request.method,
        redirectPolicy: request.redirect_policy,
        url,
      },
    }
  } catch {
    return { ok: false }
  }
}

function parseHeaders(text) {
  if (text === '') return {}
  const headers = Object.create(null)
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (line.includes('\r')) throw new TypeError('invalid HTTP header')
    const separator = line.indexOf(':')
    if (separator <= 0) throw new TypeError('invalid HTTP header')
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    const canonicalName = name.toLowerCase()
    if (
      !HTTP_TOKEN.test(name)
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)
      || hasUnpairedSurrogate(value)
      || seen.has(canonicalName)
    ) {
      throw new TypeError('invalid HTTP header')
    }
    seen.add(canonicalName)
    headers[canonicalName] = value
  }
  return headers
}

function concatenate(chunks, length) {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
