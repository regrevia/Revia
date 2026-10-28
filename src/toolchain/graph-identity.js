const IDENTITY_KINDS = new Set([
  'call',
  'cap',
  'function',
  'let',
  'literal',
  'match',
  'match-branch',
  'return',
])
const UID_PATTERN = /^[a-z2-7]{25}[aeimquy4]$/

export const COMPACT_IDENTITY_ALLOCATOR = Object.freeze({
  algorithm: 're.deterministic-uid-sequence@0.1.0',
  schema: 're.identity-allocator@0.1.0',
})

export function deterministicUidFactory() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let counter = 0
  return () => {
    let value = counter
    counter += 1
    let prefix = ''
    for (let index = 0; index < 7; index += 1) {
      prefix = alphabet[value % 32] + prefix
      value = Math.floor(value / 32)
    }
    return `${prefix}${'a'.repeat(19)}`
  }
}

export function assignMissingGraphUids(graph, uidFactory) {
  visitIdentityNodes(graph, (node) => {
    node.uid ??= uidFactory()
  })
}

export function validateGraphIdentities(
  graph,
  { occupiedUids = [] } = {},
) {
  const diagnostics = []
  const occupied = new Set(occupiedUids)
  const seen = new Set()
  const labels = new Map()
  for (const uid of occupied) {
    if (isValidUid(uid)) {
      labels.set(uid.slice(0, 7), uid)
    }
  }

  visitIdentityNodes(graph, (node) => {
    const uid = node.uid
    if (!isValidUid(uid)) {
      pushOnce(
        diagnostics,
        (diagnostic) =>
          diagnostic.code === 'invalid-uid' &&
          Object.is(diagnostic.actual, uid),
        { actual: uid, code: 'invalid-uid' },
      )
      return
    }

    if (seen.has(uid) || occupied.has(uid)) {
      pushOnce(
        diagnostics,
        (diagnostic) =>
          diagnostic.code === 'uid-collision' && diagnostic.uid === uid,
        { code: 'uid-collision', uid },
      )
    }
    const label = uid.slice(0, 7)
    const previousUid = labels.get(label)
    if (previousUid !== undefined && previousUid !== uid) {
      pushOnce(
        diagnostics,
        (diagnostic) =>
          diagnostic.code === 'ambiguous-label' &&
          diagnostic.label === label,
        {
          code: 'ambiguous-label',
          label,
          uids: [previousUid, uid],
        },
      )
    } else if (previousUid === undefined) {
      labels.set(label, uid)
    }
    seen.add(uid)
  })
  return diagnostics
}

export function isValidUid(uid) {
  return typeof uid === 'string' && UID_PATTERN.test(uid)
}

function visitIdentityNodes(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) visitIdentityNodes(item, visit)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (IDENTITY_KINDS.has(value.kind)) visit(value)
  for (const child of Object.values(value)) visitIdentityNodes(child, visit)
}

function pushOnce(diagnostics, matches, diagnostic) {
  if (!diagnostics.some(matches)) diagnostics.push(diagnostic)
}
