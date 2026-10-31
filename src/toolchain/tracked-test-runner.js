import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MINIMUM_NODE_VERSION = '22.16.0'

export function selectTrackedTests({
  cwd,
  requested = [],
  readdirSyncImpl = readdirSync,
} = {}) {
  if (typeof cwd !== 'string'
    || cwd.length === 0
    || !Array.isArray(requested)
    || typeof readdirSyncImpl !== 'function') {
    fail('tracked test discovery failed')
  }
  let entries
  try {
    entries = collectTests(join(cwd, 'test'), 'test', readdirSyncImpl)
  } catch {
    fail('tracked test discovery failed')
  }
  const tracked = new Set(entries)
  if (tracked.size === 0) fail('tracked test discovery failed')
  if (requested.length === 0) return [...tracked].sort()

  const selected = new Set()
  for (const entry of requested) {
    if (!validTestPath(entry) || !tracked.has(entry) || selected.has(entry)) {
      fail('invalid tracked test selection')
    }
    selected.add(entry)
  }
  return [...selected].sort()
}

export function runTrackedTests({
  cwd,
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  requested = [],
  spawnSyncImpl,
  readdirSyncImpl = readdirSync,
} = {}) {
  if (typeof execPath !== 'string' || execPath.length === 0) {
    fail('tracked test execution failed')
  }
  requireSupportedNodeVersion(nodeVersion)
  const tests = selectTrackedTests({ cwd, requested, readdirSyncImpl })
  const runner = spawnSyncImpl ?? spawnSync
  const result = runner(execPath, [
    '--test',
    '--experimental-test-isolation=none',
    ...tests,
  ], {
    cwd,
    shell: false,
    stdio: 'inherit',
  })
  if (result?.error !== undefined
    || !(result?.status === null || Number.isInteger(result?.status))
    || !(result?.signal === null || typeof result?.signal === 'string')) {
    fail('tracked test execution failed')
  }
  return {
    signal: result.signal,
    status: result.status,
    tests: tests.length,
  }
}

function requireSupportedNodeVersion(version) {
  const match = typeof version === 'string'
    ? /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
    : null
  const actual = match === null
    ? null
    : match.slice(1, 4).map(Number)
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number)
  const difference = actual?.findIndex((part, index) => part !== minimum[index]) ?? -1
  const belowMinimum = actual === null
    || (difference !== -1 && actual[difference] < minimum[difference])
    || (difference === -1 && match[4] !== undefined)

  if (belowMinimum) {
    throw Object.assign(
      new TypeError(`requires Node.js >=${MINIMUM_NODE_VERSION}, found ${version ?? 'unknown'}`),
      { code: 'unsupported-node-version' },
    )
  }
}

function collectTests(absolute, relative, readdirSyncImpl) {
  return readdirSyncImpl(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name)
    const childRelative = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) fail('tracked test discovery failed')
    if (entry.isDirectory()) return collectTests(child, childRelative, readdirSyncImpl)
    if (entry.isFile() && validTestPath(childRelative)) return [childRelative]
    if (entry.isFile()) return []
    fail('tracked test discovery failed')
  }).sort()
}

function validTestPath(value) {
  if (typeof value !== 'string'
    || !value.startsWith('test/')
    || !value.endsWith('.test.js')
    || !/^test\/[A-Za-z0-9._/-]+\.test\.js$/u.test(value)
    || value.includes('\\')
    || value.includes('//')) {
    return false
  }
  const segments = value.split('/')
  return segments.length >= 2
    && segments.every((segment) => (
      segment.length > 0 && segment !== '.' && segment !== '..'
    ))
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
