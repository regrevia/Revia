import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MINIMUM_NODE_VERSION = '22.16.0'
export const TRACKED_TEST_RUNNER_SCHEMA = 'revia.test-population@0.1.0'
const DISCOVERY_ARGS = ['ls-files', '-z', '--', 'test/*.test.js']
const MAX_GIT_OUTPUT = 16 * 1024 * 1024

export function selectTrackedTests({
  cwd,
  requested = [],
  spawnSyncImpl = spawnSync,
  readdirSyncImpl = readdirSync,
} = {}) {
  if (typeof cwd !== 'string'
    || cwd.length === 0
    || !Array.isArray(requested)
    || typeof spawnSyncImpl !== 'function'
    || typeof readdirSyncImpl !== 'function') {
    fail('tracked test discovery failed')
  }
  const { intended, discovered } = discoverTestPopulation({
    cwd,
    spawnSyncImpl,
    readdirSyncImpl,
  })
  const tracked = new Set(intended)
  if (tracked.size === 0 || discovered.length === 0) {
    fail('tracked test discovery failed')
  }
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
  const runner = spawnSyncImpl ?? spawnSync
  const population = discoverTestPopulation({
    cwd,
    spawnSyncImpl: runner,
    readdirSyncImpl,
  })
  const tests = selectFromIntended(population.intended, requested)
  const executions = tests.map((test) => {
    const result = runner(execPath, [
      '--test',
      '--experimental-test-isolation=none',
      '--test-reporter=junit',
      test,
    ], {
      cwd,
      shell: false,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    if (result?.error !== undefined
      || !(result?.status === null || Number.isInteger(result?.status))
      || !(result?.signal === null || typeof result?.signal === 'string')) {
      fail('tracked test execution failed')
    }
    return {
      file: test,
      status: result.status,
      signal: result.signal,
      output: result.stdout ?? '',
    }
  })
  const selected = [...tests].sort()
  const executionEvidence = executions.map(({ file, status: value, signal: termination, output }) => {
    const testsRun = parseExecutedTestCount(output)
    return {
      file,
      status: value,
      signal: termination,
      tests: testsRun,
      outcome: termination !== null
        ? 'signaled'
        : testsRun === 0
          ? 'no-report'
          : value === 0
            ? 'passed'
            : 'failed',
    }
  })
  const executed = executionEvidence
    .filter(({ tests }) => tests > 0)
    .map(({ file }) => file)
  const status = executions.find(({ status: value }) => value !== 0)?.status ?? 0
  const signal = executions.find(({ signal: value }) => value !== null)?.signal ?? null
  const executedSet = new Set(executed)
  return {
    population: {
      schema: TRACKED_TEST_RUNNER_SCHEMA,
      node: {
        minimum: MINIMUM_NODE_VERSION,
        version: nodeVersion,
      },
      intended: population.intended,
      discovered: population.discovered,
      selected,
      executed,
      executions: executionEvidence,
      status,
      signal,
      complete: status === 0
        && signal === null
        && samePopulation(population.intended, population.discovered)
        && samePopulation(population.intended, selected)
        && samePopulation(selected, executed)
    },
    output: executions.map(({ output }) => output).join(''),
    signal,
    status,
    tests: tests.length,
  }
}

export function parseExecutedTestFiles(source, { cwd, selected } = {}) {
  if (Buffer.isBuffer(source)) source = source.toString('utf8')
  if (typeof source !== 'string'
    || typeof cwd !== 'string'
    || !Array.isArray(selected)) {
    fail('tracked test execution evidence invalid')
  }
  const selectedSet = new Set(selected)
  const executed = new Set()
  for (const match of source.matchAll(/\btestcase\b[^>]*\bfile="([^"]+)"/gu)) {
    const file = decodeXml(match[1])
    const absolute = isAbsolute(file) ? file : resolve(cwd, file)
    const value = normalizeRelativePath(relative(cwd, absolute))
    if (!validTestPath(value) || !selectedSet.has(value)) {
      fail('tracked test execution evidence invalid')
    }
    executed.add(value)
  }
  return [...executed].sort()
}

function parseExecutedTestCount(source) {
  if (typeof source !== 'string') return 0
  const match = /<!--\s*tests\s+([1-9][0-9]*)\s*-->/u.exec(source)
  return match === null ? 0 : Number(match[1])
}

function samePopulation(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function discoverTestPopulation({ cwd, spawnSyncImpl, readdirSyncImpl }) {
  const result = spawnSyncImpl('git', DISCOVERY_ARGS, {
    cwd,
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
  })
  if (result?.error !== undefined
    || result?.status !== 0
    || !Buffer.isBuffer(result.stdout)) {
    fail('tracked test discovery failed')
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
  } catch {
    fail('tracked test discovery failed')
  }
  const intended = text.length === 0
    ? []
    : text.split('\0').filter((entry) => entry !== '')
  if (intended.some((entry) => !validTestPath(entry))
    || new Set(intended).size !== intended.length) {
    fail('tracked test discovery failed')
  }
  let discovered
  try {
    discovered = collectTests(join(cwd, 'test'), 'test', readdirSyncImpl)
  } catch {
    fail('tracked test discovery failed')
  }
  if (new Set(discovered).size !== discovered.length) {
    fail('tracked test discovery failed')
  }
  return {
    intended: [...new Set(intended)].sort(),
    discovered: [...new Set(discovered)].sort(),
  }
}

function selectFromIntended(intended, requested) {
  const tracked = new Set(intended)
  if (tracked.size === 0) fail('tracked test discovery failed')
  if (!Array.isArray(requested) || requested.length === 0) {
    return [...tracked].sort()
  }
  const selected = new Set()
  for (const entry of requested) {
    if (!validTestPath(entry) || !tracked.has(entry) || selected.has(entry)) {
      fail('invalid tracked test selection')
    }
    selected.add(entry)
  }
  return [...selected].sort()
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

function normalizeRelativePath(value) {
  return value.split(sep).join('/').replace(/^\.\/+/u, '')
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function fail(code) {
  throw Object.assign(new TypeError(code), { code })
}
