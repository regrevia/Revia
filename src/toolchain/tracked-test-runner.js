import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const MINIMUM_NODE_VERSION = '22.16.0'
export const TRACKED_TEST_RUNNER_SCHEMA = 'revia.test-population@0.2.0'
const DISCOVERY_ARGS = ['ls-files', '-z', '--', 'test/*.test.js']
const REVISION_ARGS = ['rev-parse', '--verify', 'HEAD^{commit}']
const WORKTREE_STATUS_ARGS = ['status', '--porcelain=v1', '--untracked-files=all']
const MAX_GIT_OUTPUT = 16 * 1024 * 1024
const FIXTURE_SCHEMA = 'revia.test-population-fixture@0.1.0'
const COMMAND_SCHEMA = 'revia.test-command@0.1.0'
const CANONICALIZATION = 'revia.canonical-json@1'
const HASH_ALGORITHM = 'sha256'
const TEST_COMMAND_ARGS = [
  '--test',
  '--experimental-test-isolation=none',
  '--test-reporter=junit',
]
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

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
  const sourceRevision = readSourceRevision(cwd, runner)
  const worktreeStatusBefore = readWorktreeStatus(cwd, runner)
  const population = discoverTestPopulation({
    cwd,
    spawnSyncImpl: runner,
    readdirSyncImpl,
  })
  const tests = selectFromIntended(population.intended, requested)
  const executions = tests.map((test) => {
    const result = runner(execPath, [
      ...TEST_COMMAND_ARGS,
      test,
    ], {
      cwd,
      env: cleanChildEnvironment(),
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
  const worktreeStatusAfter = readWorktreeStatus(cwd, runner)
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
  const signal = executions.find(({ signal: value }) => value !== null)?.signal ?? null
  const failedChild = executions.find(({ status: value }) => value !== 0)
  const childStatus = failedChild === undefined ? 0 : failedChild.status ?? 1
  const executionStatus = signal !== null
    || executionEvidence.some(({ outcome }) => outcome === 'no-report')
    ? 1
    : childStatus
  const fullPopulationComplete = samePopulation(population.intended, population.discovered)
    && samePopulation(population.intended, selected)
    && samePopulation(selected, executed)
  const status = executionStatus === 0
    && requested.length === 0
    && !fullPopulationComplete
    ? 1
    : executionStatus
  const output = executions.map(({ output: childOutput }) => childOutput).join('')
  const command = {
    arguments_prefix: TEST_COMMAND_ARGS,
    executable: 'node',
    executable_path_digest: digestBytes(Buffer.from(execPath, 'utf8')),
    schema: COMMAND_SCHEMA,
    selected,
    shell: false,
    working_directory: '.',
  }
  const fixtureDigest = digestCanonical({
    intended: population.intended,
    schema: FIXTURE_SCHEMA,
    source_revision: sourceRevision,
  })
  const worktreeClean = worktreeStatusBefore === ''
    && worktreeStatusAfter === ''
  const worktreeStatusDigest = digestCanonical({
    after: digestBytes(Buffer.from(worktreeStatusAfter, 'utf8')),
    before: digestBytes(Buffer.from(worktreeStatusBefore, 'utf8')),
  })
  const reportContent = {
    canonicalization: CANONICALIZATION,
    command,
    command_digest: digestCanonical(command),
    command_schema: COMMAND_SCHEMA,
    complete: executionStatus === 0
      && signal === null
      && fullPopulationComplete,
    discovered: population.discovered,
    execution_log_digest: digestBytes(Buffer.from(output, 'utf8')),
    execution_status: executionStatus,
    executions: executionEvidence,
    executed,
    fixture_digest: fixtureDigest,
    fixture_schema: FIXTURE_SCHEMA,
    full_population_requested: requested.length === 0,
    hash_algorithm: HASH_ALGORITHM,
    intended: population.intended,
    node: {
      minimum: MINIMUM_NODE_VERSION,
      version: nodeVersion,
    },
    schema: TRACKED_TEST_RUNNER_SCHEMA,
    selected,
    signal,
    source_revision: sourceRevision,
    status,
    working_tree_clean: worktreeClean,
    worktree_status_digest: worktreeStatusDigest,
  }
  const report = {
    ...reportContent,
    evidence_digest: digestCanonical(reportContent),
  }
  return {
    population: report,
    output,
    signal,
    status,
    tests: tests.length,
  }
}

export function validateTrackedTestPopulationReport(
  report,
  { executionLog } = {},
) {
  try {
    if (!plainObject(report)
      || !exactFields(report, [
        'canonicalization',
        'command',
        'command_digest',
        'command_schema',
        'complete',
        'discovered',
        'evidence_digest',
        'execution_log_digest',
        'execution_status',
        'executions',
        'executed',
        'fixture_digest',
        'fixture_schema',
        'full_population_requested',
        'hash_algorithm',
        'intended',
        'node',
        'schema',
        'selected',
        'signal',
        'source_revision',
        'status',
        'working_tree_clean',
        'worktree_status_digest',
      ])
      || report.schema !== TRACKED_TEST_RUNNER_SCHEMA
      || report.hash_algorithm !== HASH_ALGORITHM
      || report.canonicalization !== CANONICALIZATION
      || report.command_schema !== COMMAND_SCHEMA
      || report.fixture_schema !== FIXTURE_SCHEMA
      || !REVISION.test(report.source_revision)
      || !DIGEST.test(report.fixture_digest)
      || !DIGEST.test(report.command_digest)
      || !DIGEST.test(report.execution_log_digest)
      || !DIGEST.test(report.worktree_status_digest)
      || !DIGEST.test(report.evidence_digest)) {
      return invalidReport('test-population-report-invalid')
    }
    if (typeof report.working_tree_clean !== 'boolean') {
      return invalidReport('test-population-worktree-state-invalid')
    }

    if (!plainObject(report.node)
      || !exactFields(report.node, ['minimum', 'version'])
      || report.node.minimum !== MINIMUM_NODE_VERSION
      || !supportedNodeVersion(report.node.version)) {
      return invalidReport('test-population-node-identity-invalid')
    }
    if (report.intended.length === 0
      || report.selected.length === 0
      || (report.discovered.length === 0 && report.status === 0)) {
      return invalidReport('test-population-list-invalid')
    }
    for (const values of [
      report.intended,
      report.discovered,
      report.selected,
      report.executed,
    ]) {
      if (!validPopulation(values)) {
        return invalidReport('test-population-list-invalid')
      }
    }

    const expectedFixtureDigest = digestCanonical({
      intended: report.intended,
      schema: FIXTURE_SCHEMA,
      source_revision: report.source_revision,
    })
    if (report.fixture_digest !== expectedFixtureDigest) {
      return invalidReport('test-population-fixture-digest-mismatch')
    }
    if (!validCommand(report.command, report.selected)
      || report.command_digest !== digestCanonical(report.command)) {
      return invalidReport('test-population-command-mismatch')
    }
    if (typeof executionLog !== 'string'
      || report.execution_log_digest
        !== digestBytes(Buffer.from(executionLog, 'utf8'))) {
      return invalidReport('test-population-execution-log-digest-mismatch')
    }
    if (!validExecutions(report.executions, report.selected)) {
      return invalidReport('test-population-executions-invalid')
    }

    const expectedExecuted = report.executions
      .filter(({ tests }) => tests > 0)
      .map(({ file }) => file)
    const expectedSignal = report.executions
      .find(({ signal: value }) => value !== null)?.signal ?? null
    const failedChild = report.executions.find(({ status: value }) => value !== 0)
    const childStatus = failedChild === undefined ? 0 : failedChild.status ?? 1
    const expectedExecutionStatus = expectedSignal !== null
      || report.executions.some(({ outcome }) => outcome === 'no-report')
      ? 1
      : childStatus
    const fullPopulationComplete = samePopulation(
      report.intended,
      report.discovered,
    ) && samePopulation(report.intended, report.selected)
      && samePopulation(report.selected, expectedExecuted)
    const expectedStatus = expectedExecutionStatus === 0
      && report.full_population_requested
      && !fullPopulationComplete
      ? 1
      : expectedExecutionStatus
    const { evidence_digest: ignoredDigest, ...content } = report
    if (report.executed.length !== expectedExecuted.length
      || !samePopulation(report.executed, expectedExecuted)
      || report.signal !== expectedSignal
      || report.execution_status !== expectedExecutionStatus
      || report.status !== expectedStatus
      || report.complete !== (
        expectedExecutionStatus === 0
        && expectedSignal === null
        && fullPopulationComplete
      )
      || typeof report.full_population_requested !== 'boolean'
      || report.evidence_digest !== digestCanonical(content)) {
      return invalidReport('test-population-evidence-digest-mismatch')
    }
    return { ok: true }
  } catch {
    return invalidReport('test-population-report-invalid')
  }
}

function cleanChildEnvironment() {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  return environment
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
  const match = parseNodeVersion(version)
  const actual = match?.parts ?? null
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number)
  const difference = actual?.findIndex((part, index) => part !== minimum[index]) ?? -1
  const belowMinimum = actual === null
    || (difference !== -1 && actual[difference] < minimum[difference])
    || (difference === -1 && match.prerelease !== undefined)

  if (belowMinimum) {
    throw Object.assign(
      new TypeError(`requires Node.js >=${MINIMUM_NODE_VERSION}, found ${version ?? 'unknown'}`),
      { code: 'unsupported-node-version' },
    )
  }
}

function readSourceRevision(cwd, spawnSyncImpl) {
  const result = spawnSyncImpl('git', REVISION_ARGS, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024,
    shell: false,
  })
  const revision = typeof result?.stdout === 'string'
    ? result.stdout.trim()
    : ''
  if (result?.error !== undefined
    || result?.status !== 0
    || !REVISION.test(revision)) {
    fail('tracked test provenance failed')
  }
  return revision
}

function readWorktreeStatus(cwd, spawnSyncImpl) {
  const result = spawnSyncImpl('git', WORKTREE_STATUS_ARGS, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
  })
  if (result?.error !== undefined
    || result?.status !== 0
    || typeof result.stdout !== 'string') {
    fail('tracked test provenance failed')
  }
  return result.stdout
}

function validCommand(command, selected) {
  return plainObject(command)
    && exactFields(command, [
      'arguments_prefix',
      'executable',
      'executable_path_digest',
      'schema',
      'selected',
      'shell',
      'working_directory',
    ])
    && command.executable === 'node'
    && DIGEST.test(command.executable_path_digest)
    && command.schema === COMMAND_SCHEMA
    && Array.isArray(command.arguments_prefix)
    && samePopulation(command.arguments_prefix, TEST_COMMAND_ARGS)
    && samePopulation(command.selected, selected)
    && command.shell === false
    && command.working_directory === '.'
}

function validExecutions(executions, selected) {
  if (!Array.isArray(executions) || executions.length !== selected.length) {
    return false
  }
  return executions.every((entry, index) =>
    plainObject(entry)
      && exactFields(entry, ['file', 'outcome', 'signal', 'status', 'tests'])
      && entry.file === selected[index]
      && (entry.status === null || Number.isSafeInteger(entry.status))
      && (entry.signal === null || typeof entry.signal === 'string')
      && Number.isSafeInteger(entry.tests)
      && entry.tests >= 0
      && entry.outcome === (
        entry.signal !== null
          ? 'signaled'
          : entry.tests === 0
            ? 'no-report'
            : entry.status === 0
              ? 'passed'
              : 'failed'
      ))
}

function validPopulation(values) {
  return Array.isArray(values)
    && values.every(validTestPath)
    && values.every((value, index) =>
      index === 0 || compareUtf8(values[index - 1], value) < 0)
}

function parseNodeVersion(version) {
  const match = typeof version === 'string'
    ? /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
    : null
  return match === null
    ? null
    : {
      parts: match.slice(1, 4).map(Number),
      prerelease: match[4],
    }
}

function supportedNodeVersion(version) {
  const parsed = parseNodeVersion(version)
  if (parsed === null) return false
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number)
  const difference = parsed.parts.findIndex(
    (part, index) => part !== minimum[index],
  )
  return !(difference === -1 && parsed.prerelease !== undefined)
    && !(difference !== -1 && parsed.parts[difference] < minimum[difference])
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestCanonical(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'))
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareUtf8).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function exactFields(value, fields) {
  const keys = Object.keys(value).sort(compareUtf8)
  const expected = [...fields].sort(compareUtf8)
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
}

function invalidReport(code) {
  return { code, ok: false }
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
