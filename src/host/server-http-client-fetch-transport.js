import { snapshotUint8Array } from './uint8-array.js'

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function createServerHttpClientFetchTransport({
  clearTimeoutImpl = clearTimeout,
  fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('http client fetch transport requires fetch')
  }
  if (
    typeof clearTimeoutImpl !== 'function'
    || typeof setTimeoutImpl !== 'function'
  ) {
    throw new TypeError('http client fetch transport requires timer functions')
  }

  return async function fetchTransport(request) {
    const prepared = prepareRequest(request)
    if (!prepared.ok) return { error: 'invalid_request' }

    const controller = new AbortController()
    let deadlineExceeded = false
    const timer = setTimeoutImpl(() => {
      deadlineExceeded = true
      controller.abort()
    }, prepared.value.deadline)
    try {
      const response = await fetchImpl(prepared.value.url, {
        body: prepared.value.body.length === 0
          ? undefined
          : prepared.value.body,
        headers: prepared.value.headers,
        method: prepared.value.method,
        redirect: prepared.value.redirectPolicy === 'follow'
          ? 'follow'
          : 'manual',
        signal: controller.signal,
      })
      const status = response?.status
      const text = response?.text
      if (
        !Number.isInteger(status)
        || status < 100
        || status > 599
        || typeof text !== 'function'
      ) {
        return { error: 'unavailable' }
      }
      if (
        prepared.value.redirectPolicy === 'reject'
        && status >= 300
        && status < 400
      ) {
        return { error: 'redirect_rejected' }
      }
      const readText = Function.prototype.bind.call(text, response)
      const body = await readText()
      if (typeof body !== 'string' || hasUnpairedSurrogate(body)) {
        return { error: 'unavailable' }
      }
      return JSON.stringify({ status, body })
    } catch (error) {
      if (deadlineExceeded || error?.name === 'AbortError') {
        return { error: 'deadline_exceeded' }
      }
      return { error: 'unavailable' }
    } finally {
      clearTimeoutImpl(timer)
    }
  }
}

function prepareRequest(request) {
  if (
    request === null
    || typeof request !== 'object'
  ) {
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
    || (
      request.redirect_policy !== 'follow'
      && request.redirect_policy !== 'reject'
    )
    || typeof request.url !== 'string'
    || /[\u0000-\u001f\u007f]/u.test(request.url)
    || hasUnpairedSurrogate(request.url)
  ) {
    return { ok: false }
  }
  let url
  let headers
  try {
    url = new URL(request.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false }
    }
    headers = parseHeaders(request.headers)
  } catch {
    return { ok: false }
  }
  return {
    ok: true,
    value: {
      body,
      deadline: request.deadline,
      headers,
      method: request.method,
      redirectPolicy: request.redirect_policy,
      url: request.url,
    },
  }
}

function parseHeaders(text) {
  if (text === '') return []
  const headers = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (line.includes('\r')) throw new TypeError('invalid HTTP header')
    const separator = line.indexOf(':')
    if (separator <= 0) throw new TypeError('invalid HTTP header')
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    const canonicalName = name.toLowerCase()
    if (!HTTP_TOKEN.test(name)
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)
      || hasUnpairedSurrogate(value)
      || seen.has(canonicalName)) {
      throw new TypeError('invalid HTTP header')
    }
    seen.add(canonicalName)
    headers.push([name, value])
  }
  return headers
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
