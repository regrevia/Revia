import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

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
  requested = [],
  spawnSyncImpl,
  readdirSyncImpl = readdirSync,
} = {}) {
  if (typeof execPath !== 'string' || execPath.length === 0) {
    fail('tracked test execution failed')
  }
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
