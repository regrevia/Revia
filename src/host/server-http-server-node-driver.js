const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype)
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
).get
const TYPED_ARRAY_SET = TYPED_ARRAY_PROTOTYPE.set

export function createServerHttpServerNodeDriver({
  clearTimeoutImpl = clearTimeout,
  listeners,
  maxResponseBytes = 1024 * 1024,
  maxResponseChunkBytes = 64 * 1024,
  maxPendingAccepts = 64,
  now = defaultNow,
  routes = new Map(),
  setTimeoutImpl = setTimeout,
  waitForResponseDrain = defaultWaitForResponseDrain,
  writeResponse = (response, body) => response.write(body),
} = {}) {
  if (!(listeners instanceof Map)) {
    throw new TypeError('http server listeners must be a non-empty Map')
  }
  if (!Number.isSafeInteger(maxPendingAccepts) || maxPendingAccepts < 1) {
    throw new TypeError('maxPendingAccepts must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || !Number.isSafeInteger(maxResponseChunkBytes) || maxResponseChunkBytes < 1
    || maxResponseChunkBytes > maxResponseBytes
  ) {
    throw new TypeError('invalid http server response limits')
  }
  if (typeof now !== 'function'
    || typeof setTimeoutImpl !== 'function'
    || typeof clearTimeoutImpl !== 'function'
    || typeof waitForResponseDrain !== 'function'
    || typeof writeResponse !== 'function') {
    throw new TypeError('invalid http server drain clock')
  }

  const listenerRecords = new Map()
  const serverHandles = new Set()
  const listenerIterator = Map.prototype.entries.call(listeners)
  for (
    let step = listenerIterator.next();
    !step.done;
    step = listenerIterator.next()
  ) {
    const [name, server] = step.value
    const capabilities = snapshotServerCapabilities(server)
    if (typeof name !== 'string'
      || name.length === 0
      || capabilities === null
      || serverHandles.has(server)) {
      throw new TypeError('invalid http server listener')
    }
    serverHandles.add(server)
    listenerRecords.set(name, {
      accepts: [],
      name,
      off: capabilities.off,
      on: capabilities.on,
      routes: null,
      server,
    })
  }
  if (listenerRecords.size === 0) {
    throw new TypeError('http server listeners must be a non-empty Map')
  }
  compileRouteRegistry(routes, listenerRecords)

  const active = new Map()
  const cancelled = new Set()
  let mode = 'open'
  let sequence = 0
  let drainState = null

  const finishDrain = (outcome, cancelledRequests = 0) => {
    if (drainState === null || drainState.done) return
    drainState.done = true
    if (drainState.timer !== null) {
      clearTimeoutImpl(drainState.timer)
      drainState.timer = null
    }
    drainState.resolve({
      cancelled_requests: cancelledRequests,
      outcome,
    })
  }

  const settleDrainIfIdle = () => {
    if (mode === 'draining' && active.size === 0) finishDrain('drained')
  }

  const markCancelled = (token) => {
    const record = active.get(token)
    if (record === undefined) return
    active.delete(token)
    cancelled.add(token)
    record.state = 'cancelled'
    settleResponseDrain(record, { error: 'cancelled' })
    settleDrainIfIdle()
  }

  const onRequest = (listener, request, response) => {
    if (mode !== 'open') {
      const responseCapabilities = snapshotResponseCapabilities(response)
      if (responseCapabilities === null
        || !responseCapabilities.setStatusCode(503)) return
      responseCapabilities.setHeader('connection', 'close')
      responseCapabilities.end()
      return
    }
    const requestEnvelope = snapshotRequestEnvelope(request)
    let headerSnapshot
    try {
      headerSnapshot = requestEnvelope === null
        ? { contentLength: undefined, outcome: { error: 'invalid_request' } }
        : snapshotHeaders(requestEnvelope.headers)
    } catch {
      headerSnapshot = {
        contentLength: undefined,
        outcome: { error: 'invalid_request' },
      }
    }
    const route = requestEnvelope === null
      ? { error: 'malformed' }
      : matchRoute(listener.routes, requestEnvelope)
    const responseCapabilities = snapshotResponseCapabilities(response)
    if (responseCapabilities === null) return
    if (route.error !== undefined) {
      if (!responseCapabilities.setStatusCode(
        route.error === 'malformed' ? 400 : 404,
      )) return
      responseCapabilities.end()
      return
    }
    const waiter = listener.accepts[0]
    if (waiter === undefined) {
      if (!responseCapabilities.setStatusCode(503)) return
      responseCapabilities.end()
      return
    }
    const requestCapabilities = snapshotRequestCapabilities(request)
    if (requestCapabilities === null) {
      if (!responseCapabilities.setStatusCode(400)) return
      responseCapabilities.end()
      return
    }
    listener.accepts.shift()
    sequence += 1
    const token = `node-http-request-${String(sequence).padStart(8, '0')}`
    const record = {
      bodyOutcome: null,
      bodyPromise: null,
      bodyReadLimit: null,
      contentLength: headerSnapshot.contentLength,
      headersOutcome: headerSnapshot.outcome,
      responseBytes: 0,
      responseDrainPromise: null,
      responseDrainResolve: null,
      responseStarted: false,
      method: route.method,
      path: route.path,
      requestCapabilities,
      responseCapabilities,
      routeParams: route.params,
      state: 'active',
      token,
    }
    active.set(token, record)
    requestCapabilities.once('aborted', () => markCancelled(token))
    responseCapabilities.once('close', () => {
      if (responseCapabilities.writableEnded() !== true) markCancelled(token)
    })
    waiter(token)
  }

  for (const listener of listenerRecords.values()) {
    listener.onRequest = (request, response) => onRequest(listener, request, response)
    listener.on('request', listener.onRequest)
  }

  const lookup = (token) => {
    if (typeof token !== 'string') return { error: 'invalid_request' }
    const record = active.get(token)
    if (record !== undefined) return record
    return { error: cancelled.has(token) ? 'cancelled' : 'invalid_request' }
  }

  const driver = {
    accept({ listener }) {
      if (mode !== 'open' || typeof listener !== 'string') {
        return { error: 'unavailable' }
      }
      const record = listenerRecords.get(listener)
      if (record === undefined || record.accepts.length >= maxPendingAccepts) {
        return { error: 'unavailable' }
      }
      return new Promise((resolve) => {
        record.accepts.push(resolve)
      })
    },

    body({ limit, request }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      if (!Number.isSafeInteger(limit) || limit < 0) {
        return { error: 'invalid_request' }
      }
      if (record.bodyOutcome !== null) {
        return projectBodyOutcome(record.bodyOutcome, limit)
      }
      if (record.bodyPromise === null) {
        record.bodyReadLimit = limit
        const preflight = contentLengthPreflight(record.contentLength, limit)
        if (preflight !== null) {
          record.bodyOutcome = { error: preflight }
          return record.bodyOutcome
        }
        record.bodyPromise = readBody(record, record.bodyReadLimit, () => {
          markCancelled(record.token)
        }).then((outcome) => {
          record.bodyOutcome = outcome instanceof Uint8Array
            ? new Uint8Array(outcome)
            : outcome
          return record.bodyOutcome
        })
      }
      return record.bodyPromise.then((outcome) => projectBodyOutcome(outcome, limit))
    },

    cancel({ request }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      active.delete(record.token)
      cancelled.add(record.token)
      record.state = 'cancelled'
      settleResponseDrain(record, { error: 'cancelled' })
      record.requestCapabilities.destroy()
      record.responseCapabilities.destroy()
      settleDrainIfIdle()
      return null
    },

    headers({ request }) {
      const record = lookup(request)
      return record.error !== undefined ? record : record.headersOutcome
    },

    method({ request }) {
      const record = lookup(request)
      return record.error !== undefined
        ? record
        : typeof record.method === 'string'
          && HTTP_TOKEN.test(record.method)
          ? record.method
          : { error: 'invalid_request' }
    },

    path({ request }) {
      const record = lookup(request)
      return record.error !== undefined
        ? record
        : typeof record.path === 'string'
          && record.path.length > 0
          && !/[\u0000-\u001f\u007f]/u.test(record.path)
          && !hasUnpairedSurrogate(record.path)
          ? record.path
          : { error: 'invalid_request' }
    },

    respond({ body, headers, request, status }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      if (
        record.responseStarted
        || !(body instanceof Uint8Array)
        || typeof headers !== 'string'
        || !Number.isSafeInteger(status)
        || status < 100
        || status > 599
      ) {
        return { error: 'invalid_request' }
      }
      const responseBody = snapshotBytes(body)
      if (responseBody === null) return { error: 'invalid_request' }
      if (
        responseBody.length > maxResponseChunkBytes
        || responseBody.length > maxResponseBytes
      ) {
        return failResponseLimit(record, active, cancelled)
      }
      let parsedHeaders
      try {
        parsedHeaders = parseHeaders(headers)
      } catch {
        return { error: 'invalid_request' }
      }
      active.delete(record.token)
      record.state = 'responded'
      try {
        record.responseCapabilities.writeHead(status, parsedHeaders)
        record.responseCapabilities.end(Buffer.from(responseBody))
      } catch {
        record.responseCapabilities.destroy()
        settleDrainIfIdle()
        return { error: 'unavailable' }
      }
      settleDrainIfIdle()
      return null
    },

    respond_start({ headers, request, status }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      if (record.responseStarted) return { error: 'invalid_request' }
      if (
        typeof headers !== 'string'
        || !Number.isSafeInteger(status)
        || status < 100
        || status > 599
      ) {
        return { error: 'invalid_request' }
      }
      let parsedHeaders
      try {
        parsedHeaders = parseHeaders(headers)
      } catch {
        return { error: 'invalid_request' }
      }
      try {
        record.responseCapabilities.writeHead(status, parsedHeaders)
      } catch {
        record.responseCapabilities.destroy()
        markCancelled(record.token)
        return { error: 'unavailable' }
      }
      record.responseStarted = true
      record.state = 'responding'
      return null
    },

    respond_chunk({ body, request }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      if (!record.responseStarted || !(body instanceof Uint8Array)) {
        return { error: 'invalid_request' }
      }
      const responseBody = snapshotBytes(body)
      if (responseBody === null) return { error: 'invalid_request' }
      if (
        responseBody.length > maxResponseChunkBytes
        || record.responseBytes + responseBody.length > maxResponseBytes
      ) {
        return failResponseLimit(record, active, cancelled)
      }
      if (record.responseDrainPromise !== null) {
        return { error: 'unavailable' }
      }
      try {
        const ready = writeResponse(
          record.responseCapabilities,
          Buffer.from(responseBody),
        )
        record.responseBytes += responseBody.length
        if (ready === false) {
          record.responseDrainPromise = new Promise((resolve) => {
            record.responseDrainResolve = resolve
          })
          Promise.resolve()
            .then(() => waitForResponseDrain(record.responseCapabilities))
            .then(
              () => settleResponseDrain(record, null),
              () => settleResponseDrain(record, { error: 'unavailable' }),
            )
          return 'blocked'
        }
      } catch {
        record.responseCapabilities.destroy()
        markCancelled(record.token)
        return { error: 'unavailable' }
      }
      return 'ready'
    },

    respond_drain({ request }) {
      const record = lookup(request)
      if (record.error !== undefined) return Promise.resolve(record)
      if (!record.responseStarted) return Promise.resolve({ error: 'invalid_request' })
      if (record.responseDrainPromise === null) return Promise.resolve(null)
      return record.responseDrainPromise
    },

    respond_end({ request }) {
      const record = lookup(request)
      if (record.error !== undefined) return record
      if (!record.responseStarted) return { error: 'invalid_request' }
      active.delete(record.token)
      record.state = 'responded'
      settleResponseDrain(record, null)
      try {
        record.responseCapabilities.end()
      } catch {
        record.responseCapabilities.destroy()
        settleDrainIfIdle()
        return { error: 'unavailable' }
      }
      settleDrainIfIdle()
      return null
    },

    route_params({ request }) {
      const record = lookup(request)
      return record.error !== undefined ? record : record.routeParams
    },

    drain({ deadline } = {}) {
      if (!Number.isFinite(deadline) || deadline < 0) {
        throw new TypeError('invalid http server drain deadline')
      }
      if (drainState !== null) return drainState.promise
      if (mode === 'closed') {
        return Promise.resolve({ cancelled_requests: 0, outcome: 'closed' })
      }
      const currentTime = now()
      if (!Number.isFinite(currentTime) || currentTime < 0) {
        throw new TypeError('invalid http server drain clock')
      }
      mode = 'draining'
      for (const listener of listenerRecords.values()) {
        for (const resolve of listener.accepts.splice(0)) {
          resolve({ error: 'unavailable' })
        }
      }
      let resolveDrain
      const promise = new Promise((resolve) => { resolveDrain = resolve })
      drainState = {
        done: false,
        promise,
        resolve: resolveDrain,
        timer: null,
      }
      if (active.size === 0) {
        finishDrain('drained')
        return promise
      }
      const delay = Math.max(0, deadline - currentTime)
      drainState.timer = setTimeoutImpl(() => {
        if (drainState.done) return
        const tokens = [...active.keys()]
        for (const token of tokens) cancelRecord(active.get(token), active, cancelled)
        finishDrain('deadline', tokens.length)
      }, delay)
      return promise
    },

    close() {
      if (mode === 'closed') return
      const closingDrain = drainState !== null && !drainState.done
      mode = 'closed'
      for (const listener of listenerRecords.values()) {
        listener.off('request', listener.onRequest)
        for (const resolve of listener.accepts.splice(0)) {
          resolve({ error: 'unavailable' })
        }
      }
      const tokens = [...active.keys()]
      for (const token of tokens) cancelRecord(active.get(token), active, cancelled)
      if (closingDrain) finishDrain('closed', tokens.length)
    },
  }
  return driver
}

function cancelRecord(record, active, cancelled) {
  if (record === undefined) return
  active.delete(record.token)
  cancelled.add(record.token)
  record.state = 'cancelled'
  settleResponseDrain(record, { error: 'cancelled' })
  record.requestCapabilities.destroy()
  record.responseCapabilities.destroy()
}

function settleResponseDrain(record, outcome) {
  if (record.responseDrainResolve === null) return
  const resolve = record.responseDrainResolve
  record.responseDrainResolve = null
  record.responseDrainPromise = null
  resolve(outcome)
}

function defaultWaitForResponseDrain(response) {
  return new Promise((resolve) => response.once('drain', resolve))
}

function failResponseLimit(record, active, cancelled) {
  active.delete(record.token)
  cancelled.add(record.token)
  record.state = 'cancelled'
  settleResponseDrain(record, { error: 'body_too_large' })
  record.responseCapabilities.destroy()
  return { error: 'body_too_large' }
}

function readBody(record, limit, cancel) {
  return new Promise((resolve) => {
    const chunks = []
    let length = 0
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const onData = (chunk) => {
      if (!(chunk instanceof Uint8Array)) {
        finish({ error: 'unavailable' })
        return
      }
      const bytes = snapshotBytes(chunk)
      if (bytes === null) {
        finish({ error: 'unavailable' })
        return
      }
      length += bytes.length
      if (length > limit) {
        record.requestCapabilities.resume()
        finish({ error: 'body_too_large' })
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => finish(new Uint8Array(Buffer.concat(chunks, length)))
    const onAborted = () => {
      cancel()
      finish({ error: 'cancelled' })
    }
    const onError = () => finish({ error: 'unavailable' })
    const cleanup = () => {
      record.requestCapabilities.off('data', onData)
      record.requestCapabilities.off('end', onEnd)
      record.requestCapabilities.off('aborted', onAborted)
      record.requestCapabilities.off('error', onError)
    }
    record.requestCapabilities.on('data', onData)
    record.requestCapabilities.once('end', onEnd)
    record.requestCapabilities.once('aborted', onAborted)
    record.requestCapabilities.once('error', onError)
  })
}

function projectBodyOutcome(outcome, limit) {
  if (outcome.error !== undefined || outcome.length > limit) {
    return { error: outcome.error ?? 'body_too_large' }
  }
  return new Uint8Array(outcome)
}

function contentLengthPreflight(value, limit) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return 'invalid_request'
  }
  try {
    return BigInt(value) > BigInt(limit) ? 'body_too_large' : null
  } catch {
    return 'invalid_request'
  }
}

function parseHeaders(value) {
  if (value === '') return {}
  const headers = {}
  for (const line of value.split('\n')) {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon)
    const fieldValue = line.slice(colon + 1)
    if (colon <= 0
      || !HTTP_TOKEN.test(name)
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(fieldValue)
      || hasUnpairedSurrogate(fieldValue)
      || Object.hasOwn(headers, name.toLowerCase())) {
      throw new TypeError('invalid response header')
    }
    headers[name.toLowerCase()] = fieldValue
  }
  return headers
}

function compileRouteRegistry(routes, listenerRecords) {
  if (!(routes instanceof Map)) throw new TypeError('http server routes must be a Map')
  const iterator = Map.prototype.entries.call(routes)
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const [listenerName, definitions] = step.value
    const listener = listenerRecords.get(listenerName)
    if (listener === undefined || !Array.isArray(definitions)) {
      throw new TypeError('invalid http server route registry')
    }
    const length = definitions.length
    const compiled = []
    for (let index = 0; index < length; index += 1) {
      compiled.push(compileRoute(definitions[index]))
    }
    for (let left = 0; left < compiled.length; left += 1) {
      for (let right = left + 1; right < compiled.length; right += 1) {
        if (routesAmbiguous(compiled[left], compiled[right])) {
          throw new TypeError('ambiguous http server route')
        }
      }
    }
    compiled.sort((left, right) => (
      right.specificity - left.specificity
      || compareUtf8(left.method, right.method)
      || compareUtf8(left.pattern, right.pattern)
    ))
    listener.routes = compiled
  }
}

function compileRoute(definition) {
  if (definition === null
    || typeof definition !== 'object'
    || Array.isArray(definition)
    || Object.keys(definition).sort().join(',') !== 'method,pattern') {
    throw new TypeError('invalid http server route')
  }
  const method = definition.method
  const pattern = definition.pattern
  if (typeof method !== 'string'
    || !HTTP_TOKEN.test(method)
    || method !== method.toUpperCase()
    || typeof pattern !== 'string'
    || !pattern.startsWith('/')
    || pattern.includes('?')
    || pattern.includes('#')
    || (pattern.length > 1 && (
      pattern.endsWith('/') || pattern.includes('//')
    ))) {
    throw new TypeError('invalid http server route')
  }
  const parameterNames = new Set()
  const segments = pattern === '/'
    ? []
    : pattern.slice(1).split('/').map((segment) => {
      if (segment.startsWith(':')) {
        const name = segment.slice(1)
        if (!/^[a-z][a-z0-9_]*$/u.test(name) || parameterNames.has(name)) {
          throw new TypeError('invalid http server route')
        }
        parameterNames.add(name)
        return { kind: 'parameter', name }
      }
      if (segment.length === 0
        || segment.includes(':')
        || segment.includes('%')
        || segment.includes('\\')
        || segment !== segment.normalize('NFC')
        || /[\u0000-\u001f\u007f]/u.test(segment)) {
        throw new TypeError('invalid http server route')
      }
      return { kind: 'static', value: segment }
    })
  return {
    method,
    pattern,
    segments,
    specificity: segments.filter(({ kind }) => kind === 'static').length,
  }
}

function routesAmbiguous(left, right) {
  if (left.method !== right.method
    || left.segments.length !== right.segments.length
    || left.specificity !== right.specificity) {
    return false
  }
  return left.segments.every((segment, index) => {
    const other = right.segments[index]
    return segment.kind === 'parameter'
      || other.kind === 'parameter'
      || segment.value === other.value
  })
}

function matchRoute(routes, requestEnvelope) {
  const { method, url } = requestEnvelope
  let pathSegments
  try {
    if (routes === null) return { method, params: '{}', path: url }
    if (typeof method !== 'string' || typeof url !== 'string') {
      return { error: 'malformed' }
    }
    const rawPath = url.split('?', 1)[0]
    if (!rawPath.startsWith('/')
      || (rawPath.length > 1 && (rawPath.endsWith('/') || rawPath.includes('//')))) {
      return { error: 'malformed' }
    }
    pathSegments = rawPath === '/'
      ? []
      : rawPath.slice(1).split('/').map((segment) => {
        const decoded = decodeURIComponent(segment).normalize('NFC')
        if (decoded.includes('/')
          || decoded.includes('\\')
          || /[\u0000-\u001f\u007f]/u.test(decoded)) {
          throw new TypeError()
        }
        return decoded
      })
  } catch {
    return { error: 'malformed' }
  }
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== pathSegments.length) {
      continue
    }
    const params = {}
    let matched = true
    for (let index = 0; index < route.segments.length; index += 1) {
      const segment = route.segments[index]
      const value = pathSegments[index]
      if (segment.kind === 'static') {
        if (segment.value !== value) {
          matched = false
          break
        }
      } else {
        params[segment.name] = value
      }
    }
    if (matched) {
      return {
        method,
        params: JSON.stringify(Object.fromEntries(
          Object.entries(params).sort(([left], [right]) => compareUtf8(left, right)),
        )),
        path: url,
      }
    }
  }
  return { error: 'unmatched' }
}

function snapshotRequestEnvelope(value) {
  if (value === null || typeof value !== 'object') return null
  const headers = snapshotPropertyReader(value, 'headers')
  const method = snapshotPropertyReader(value, 'method')
  const url = snapshotPropertyReader(value, 'url')
  if (headers === null || method === null || url === null) return null
  try {
    return {
      headers: headers(),
      method: method(),
      url: url(),
    }
  } catch {
    return null
  }
}

function snapshotPropertyReader(value, name) {
  let owner = value
  try {
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if ('value' in descriptor) {
          const snapshot = descriptor.value
          return () => snapshot
        }
        if (typeof descriptor.get !== 'function') return null
        return Function.prototype.bind.call(descriptor.get, value)
      }
      owner = Object.getPrototypeOf(owner)
    }
  } catch {
    return null
  }
  return null
}

function snapshotHeaders(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return { contentLength: undefined, outcome: { error: 'invalid_request' } }
  }
  const seen = new Set()
  const normalized = []
  let contentLength
  let invalid = false
  const fields = Object.keys(headers).map((name) => [
    name,
    snapshotOwnEnumerableReader(headers, name),
  ])
  if (fields.some(([, reader]) => reader === null)) {
    return { contentLength: undefined, outcome: { error: 'invalid_request' } }
  }
  for (const [name, reader] of fields) {
    let value
    try {
      value = reader()
    } catch {
      invalid = true
      continue
    }
    if (typeof name !== 'string' || !HTTP_TOKEN.test(name)) {
      invalid = true
      continue
    }
    const canonicalName = name.toLowerCase()
    if (canonicalName === 'content-length') contentLength = value
    if (seen.has(canonicalName)) {
      invalid = true
      continue
    }
    seen.add(canonicalName)
    const values = snapshotHeaderValueList(value)
    if (values === null || values.length === 0) {
      invalid = true
      continue
    }
    let invalidValue = false
    for (const entry of values) {
      if (
        typeof entry !== 'string'
        || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(entry)
        || hasUnpairedSurrogate(entry)
      ) {
        invalidValue = true
        break
      }
    }
    if (invalidValue) {
      invalid = true
      continue
    }
    normalized.push([canonicalName, Array.prototype.join.call(values, ',')])
  }
  return {
    contentLength,
    outcome: invalid
      ? { error: 'invalid_request' }
      : normalized
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([name, value]) => `${name}:${value}`)
        .join('\n'),
  }
}

function snapshotHeaderValueList(value) {
  if (!Array.isArray(value)) return [value]
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (lengthDescriptor === undefined
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0) {
    return null
  }
  const readers = []
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const reader = snapshotOwnEnumerableReader(value, String(index))
    if (reader === null) return null
    readers.push(reader)
  }
  try {
    return readers.map((reader) => reader())
  } catch {
    return null
  }
}

function snapshotBytes(value) {
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

function snapshotOwnEnumerableReader(value, name) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined || descriptor.enumerable !== true) return null
    if ('value' in descriptor) {
      const snapshot = descriptor.value
      return () => snapshot
    }
    if (typeof descriptor.get !== 'function') return null
    return Function.prototype.bind.call(descriptor.get, value)
  } catch {
    return null
  }
}

function compareUtf8(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
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

function snapshotServerCapabilities(value) {
  if (value === null || typeof value !== 'object') return null
  const on = value.on
  const off = value.off
  if (typeof on !== 'function' || typeof off !== 'function') return null
  return {
    off: Function.prototype.bind.call(off, value),
    on: Function.prototype.bind.call(on, value),
  }
}

function snapshotRequestCapabilities(value) {
  if (value === null || typeof value !== 'object') return null
  const readers = {
    destroy: snapshotPropertyReader(value, 'destroy'),
    off: snapshotPropertyReader(value, 'off'),
    on: snapshotPropertyReader(value, 'on'),
    once: snapshotPropertyReader(value, 'once'),
    resume: snapshotPropertyReader(value, 'resume'),
  }
  if (Object.values(readers).some((reader) => reader === null)) return null
  try {
    const destroy = readers.destroy()
    const off = readers.off()
    const on = readers.on()
    const once = readers.once()
    const resume = readers.resume()
    if (
      typeof destroy !== 'function'
      || typeof off !== 'function'
      || typeof on !== 'function'
      || typeof once !== 'function'
      || typeof resume !== 'function'
    ) {
      return null
    }
    return {
      destroy: Function.prototype.bind.call(destroy, value),
      off: Function.prototype.bind.call(off, value),
      on: Function.prototype.bind.call(on, value),
      once: Function.prototype.bind.call(once, value),
      resume: Function.prototype.bind.call(resume, value),
    }
  } catch {
    return null
  }
}

function snapshotResponseCapabilities(value) {
  if (value === null || typeof value !== 'object') return null
  const readers = {
    destroy: snapshotPropertyReader(value, 'destroy'),
    end: snapshotPropertyReader(value, 'end'),
    once: snapshotPropertyReader(value, 'once'),
    setHeader: snapshotPropertyReader(value, 'setHeader'),
    write: snapshotPropertyReader(value, 'write'),
    writeHead: snapshotPropertyReader(value, 'writeHead'),
  }
  if (Object.values(readers).some((reader) => reader === null)) return null
  try {
    const setStatusCode = snapshotPropertyWriter(value, 'statusCode')
    const writableEnded = snapshotBooleanObserver(value, 'writableEnded')
    const destroy = readers.destroy()
    const end = readers.end()
    const once = readers.once()
    const setHeader = readers.setHeader()
    const write = readers.write()
    const writeHead = readers.writeHead()
    if (
      typeof destroy !== 'function'
      || typeof end !== 'function'
      || typeof once !== 'function'
      || typeof setHeader !== 'function'
      || typeof write !== 'function'
      || typeof writeHead !== 'function'
      || setStatusCode === null
      || writableEnded === null
    ) {
      return null
    }
    return {
      destroy: Function.prototype.bind.call(destroy, value),
      end: Function.prototype.bind.call(end, value),
      once: Function.prototype.bind.call(once, value),
      setHeader: Function.prototype.bind.call(setHeader, value),
      setStatusCode,
      write: Function.prototype.bind.call(write, value),
      writeHead: Function.prototype.bind.call(writeHead, value),
      writableEnded,
    }
  } catch {
    return null
  }
}

function snapshotPropertyWriter(value, name) {
  let owner = value
  try {
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if ('value' in descriptor) {
          if (descriptor.writable !== true) return null
          const snapshot = { ...descriptor }
          return (next) => {
            try {
              Object.defineProperty(value, name, { ...snapshot, value: next })
              return true
            } catch {
              return false
            }
          }
        }
        if (typeof descriptor.set !== 'function') return null
        const write = Function.prototype.bind.call(descriptor.set, value)
        return (next) => {
          try {
            write(next)
            return true
          } catch {
            return false
          }
        }
      }
      owner = Object.getPrototypeOf(owner)
    }
  } catch {
    return null
  }
  return null
}

function snapshotBooleanObserver(value, name) {
  let owner = value
  try {
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor !== undefined) {
        if ('value' in descriptor) {
          return typeof descriptor.value === 'boolean'
            ? () => descriptor.value
            : null
        }
        if (typeof descriptor.get !== 'function') return null
        const read = Function.prototype.bind.call(descriptor.get, value)
        return () => {
          try {
            const result = read()
            return typeof result === 'boolean' ? result : null
          } catch {
            return null
          }
        }
      }
      owner = Object.getPrototypeOf(owner)
    }
  } catch {
    return null
  }
  return null
}

function defaultNow() {
  return typeof performance?.now === 'function' ? performance.now() : Date.now()
}
