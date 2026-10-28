const POLICY_FIELDS = [
  'connectionsCheckingInterval',
  'headersTimeout',
  'keepAliveTimeout',
  'maxHeadersCount',
  'maxRequestsPerSocket',
  'requestTimeout',
]

export function applyServerHttpConnectionPolicy({ policy, servers } = {}) {
  const frozenPolicy = validatePolicy(policy)
  const records = snapshotServers(servers)
  try {
    writeValues(records, frozenPolicy)
  } catch {
    rollback(records, (record) => record.original)
    throw new TypeError('http server connection policy apply failed')
  }
  let state = 'applied'
  let restoredSummary = null
  const appliedSummary = {
    applied_servers: records.map(({ name }) => name),
    ok: true,
  }

  return {
    apply() {
      return state === 'applied'
        ? structuredClone(appliedSummary)
        : { ok: false, reason: 'restored' }
    },
    restore() {
      if (state === 'restored') return structuredClone(restoredSummary)
      const drifted = records
        .filter(({ server }) => POLICY_FIELDS.some(
          (field) => !Object.is(server[field], frozenPolicy[field]),
        ))
        .map(({ name }) => name)
      if (drifted.length > 0) {
        return {
          drifted_servers: drifted,
          ok: false,
          reason: 'external-drift',
        }
      }
      try {
        writeValues(records, null, (record) => record.original)
      } catch {
        rollback(records, () => frozenPolicy)
        return {
          drifted_servers: [],
          ok: false,
          reason: 'restore-failed',
        }
      }
      state = 'restored'
      restoredSummary = {
        ok: true,
        restored_servers: records.map(({ name }) => name),
      }
      return structuredClone(restoredSummary)
    },
  }
}

function snapshotServers(servers) {
  if (!(servers instanceof Map)) {
    throw new TypeError('http server policy servers must be a non-empty Map')
  }
  const handles = new Set()
  const records = []
  const iterator = Map.prototype.entries.call(servers)
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const [name, server] = step.value
    if (typeof name !== 'string'
      || name.length === 0
      || server === null
      || typeof server !== 'object'
      || handles.has(server)) {
      throw new TypeError('invalid http server policy server')
    }
    handles.add(server)
    const original = {}
    for (const field of POLICY_FIELDS) {
      const value = server[field]
      if (!(value === null || (Number.isSafeInteger(value) && value >= 0))) {
        throw new TypeError('invalid http server policy server')
      }
      original[field] = value
    }
    records.push({ name, original, server })
  }
  if (records.length === 0) {
    throw new TypeError('http server policy servers must be a non-empty Map')
  }
  return records.sort((left, right) => Buffer.from(left.name, 'utf8').compare(
    Buffer.from(right.name, 'utf8'),
  ))
}

function validatePolicy(policy) {
  if (policy === null
    || typeof policy !== 'object'
    || Array.isArray(policy)
    || Object.keys(policy).sort().join(',') !== POLICY_FIELDS.join(',')) {
    throw new TypeError('invalid http server connection policy')
  }
  for (const field of POLICY_FIELDS) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < 0) {
      throw new TypeError('invalid http server connection policy')
    }
  }
  if (policy.connectionsCheckingInterval === 0
    || (policy.requestTimeout > 0 && policy.headersTimeout > policy.requestTimeout)) {
    throw new TypeError('invalid http server connection policy')
  }
  return Object.freeze(Object.fromEntries(
    POLICY_FIELDS.map((field) => [field, policy[field]]),
  ))
}

function writeValues(records, values, select = () => values) {
  for (const record of records) {
    const selected = select(record)
    for (const field of POLICY_FIELDS) {
      record.server[field] = selected[field]
      if (!Object.is(record.server[field], selected[field])) {
        throw new TypeError('http server connection policy write drift')
      }
    }
  }
}

function rollback(records, select) {
  for (const record of records) {
    const selected = select(record)
    for (const field of POLICY_FIELDS) {
      try {
        record.server[field] = selected[field]
      } catch {
        // The public operation already fails closed; rollback continues best-effort.
      }
    }
  }
}
