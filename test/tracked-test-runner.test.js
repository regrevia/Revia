import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  execFileSync,
  spawnSync,
} from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MINIMUM_NODE_VERSION,
  parseExecutedTestFiles,
  runTrackedTests,
  selectTrackedTests,
  validateTrackedTestPopulationReport,
} from '../src/toolchain/tracked-test-runner.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RUNNER = join(ROOT, 'scripts/run-tracked-tests.js')
const TEST_SOURCE_REVISION = 'a'.repeat(40)
const POPULATION_CORPUS = JSON.parse(readFileSync(
  join(ROOT, 'test/fixtures/tracked-test-population-evidence.json'),
  'utf8',
))

function populationCase(id) {
  const fixture = POPULATION_CORPUS.cases.find((entry) => entry.id === id)
  assert.ok(fixture, `missing population corpus case: ${id}`)
  return fixture
}

function runTrackedTestsWithFixture(
  options,
  revision = TEST_SOURCE_REVISION,
  workingTreeStatus = '',
) {
  const spawnSyncImpl = options.spawnSyncImpl
  return runTrackedTests({
    ...options,
    spawnSyncImpl(command, args, spawnOptions) {
      if (command === 'git' && args[0] === 'rev-parse') {
        return {
          status: 0,
          stdout: `${revision}\n`,
        }
      }
      if (command === 'git' && args[0] === 'status') {
        return { status: 0, stdout: workingTreeStatus }
      }
      return spawnSyncImpl(command, args, spawnOptions)
    },
  })
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

test('tracked test runner floor matches the declared package engine', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.engines.node, `>=${MINIMUM_NODE_VERSION}`)
})

test('Node validation uploads machine population and execution evidence', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/validate.yml'), 'utf8')
  assert.match(workflow, /evidence_dir="\$RUNNER_TEMP\/revia-node-test-population"/u)
  assert.match(workflow, /node scripts\/run-tracked-tests\.js > "\$evidence_dir\/node-test-population\.json" 2> "\$evidence_dir\/node-test-execution\.log"/u)
  assert.match(workflow, /name: Upload Node population evidence/u)
  assert.match(workflow, /if: always\(\)/u)
  assert.match(workflow, /node-test-population-\$\{\{ matrix\.node-version \}\}/u)
  assert.match(workflow, /\$\{\{\s*runner\.temp\s*\}\}\/revia-node-test-population\/node-test-population\.json[\s\S]*?\$\{\{\s*runner\.temp\s*\}\}\/revia-node-test-population\/node-test-execution\.log[\s\S]*?\$\{\{\s*runner\.temp\s*\}\}\/revia-node-test-population\/node-test-runner\.error/u)
})

test('population evidence corpus fixes clean, truncated, missing-report, and subset controls', () => {
  assert.equal(
    POPULATION_CORPUS.schema,
    'revia.test-population-evidence-corpus@0.1.0',
  )
  assert.deepEqual(
    POPULATION_CORPUS.cases.map(({ id }) => id),
    [
      'clean-full-population',
      'discovery-truncated',
      'incomplete-discovery',
      'unexpected-discovery',
      'missing-execution-report',
      'explicit-subset',
    ],
  )
})

test('tracked test selection is sorted and ignores non-test files', () => {
  const calls = []
  const selected = selectTrackedTests({
    cwd: '/repo',
    spawnSyncImpl(command, args, options) {
      calls.push({ args, command, options })
      return {
        status: 0,
        stdout: Buffer.from('test/z.test.js\0test/a.test.js\0'),
      }
    },
    readdirSyncImpl(path, options) {
      calls.push({ path, options })
      if (path === '/repo/test') {
        return [
          { name: 'z.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'README.md', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        ]
      }
      return []
    },
  })

  assert.deepEqual(selected, ['test/a.test.js', 'test/z.test.js'])
  assert.deepEqual(calls, [
    {
      args: ['ls-files', '-z', '--', 'test/*.test.js'],
      command: 'git',
      options: {
        cwd: '/repo',
        encoding: null,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
      },
    },
    { path: '/repo/test', options: { withFileTypes: true } },
  ])
})

test('requested test subset cannot select probes, escape test root, or repeat paths', () => {
  const spawnSyncImpl = () => ({
    status: 0,
    stdout: Buffer.from('test/a.test.js\0test/b.test.js\0'),
  })
  const readdirSyncImpl = () => [
    { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    { name: 'b.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
  ]
  for (const requested of [
    ['test/revprobe.test.js'],
    ['../test/a.test.js'],
    ['/tmp/a.test.js'],
    ['test/a.test.js', 'test/a.test.js'],
  ]) {
    assert.throws(
      () => selectTrackedTests({ cwd: '/repo', requested, spawnSyncImpl, readdirSyncImpl }),
      /invalid tracked test selection/u,
    )
  }
  assert.deepEqual(selectTrackedTests({
    cwd: '/repo',
    requested: ['test/b.test.js'],
    spawnSyncImpl,
    readdirSyncImpl,
  }), ['test/b.test.js'])
})

test('tracked test selection fails closed on git errors and empty output', () => {
  for (const spawnSyncImpl of [
    () => ({ error: new Error('private git detail'), status: null, stdout: Buffer.alloc(0) }),
    () => ({ status: 1, stdout: Buffer.alloc(0) }),
    () => ({ status: 0, stdout: Buffer.alloc(0) }),
    () => ({ status: 0, stdout: Buffer.from('scratch_probe.test.js\0') }),
  ]) {
    assert.throws(
      () => selectTrackedTests({
        cwd: '/repo',
        spawnSyncImpl,
      }),
      /tracked test discovery failed/u,
    )
  }
})

test('tracked test runner fails closed when source revision or worktree status is unavailable', () => {
  for (const provenanceFailure of ['revision', 'status']) {
    let discovered = false
    let executed = false
    assert.throws(
      () => runTrackedTests({
        cwd: '/repo',
        execPath: '/node',
        nodeVersion: '22.16.0',
        spawnSyncImpl(command, args) {
          if (command === 'git' && args[0] === 'rev-parse') {
            return provenanceFailure === 'revision'
              ? { status: 128, stdout: '' }
              : { status: 0, stdout: `${TEST_SOURCE_REVISION}\n` }
          }
          if (command === 'git' && args[0] === 'status') {
            return { status: 1, stdout: '' }
          }
          if (command === 'git') {
            return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
          }
          executed = true
          return {
            signal: null,
            status: 0,
            stdout: '<testsuites><!-- tests 1 --></testsuites>',
          }
        },
        readdirSyncImpl() {
          discovered = true
          return [
            { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          ]
        },
      }),
      (error) => error.code === 'tracked test provenance failed',
    )
    assert.equal(discovered, false)
    assert.equal(executed, false)
  }
})

test('tracked test runner invokes Node without a shell and returns stable status', () => {
  const calls = []
  const result = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    requested: ['test/a.test.js'],
    spawnSyncImpl(command, args, options) {
      calls.push({ args, command, options })
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return { signal: null, status: 7, stdout: '<testsuites><!-- tests 1 --></testsuites>' }
    },
    readdirSyncImpl: () => [
      { name: 'b.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.equal(result.signal, null)
  assert.equal(result.status, 7)
  assert.equal(result.tests, 1)
  assert.equal(result.population.complete, false)
  assert.deepEqual(result.population.executions, [{
    file: 'test/a.test.js',
    status: 7,
    signal: null,
    tests: 1,
    outcome: 'failed',
  }])
  assert.deepEqual(calls[1].args, [
    '--test',
    '--experimental-test-isolation=none',
    '--test-reporter=junit',
    'test/a.test.js',
  ])
  assert.equal(calls[1].command, '/node')
  const { env: childEnvironment, ...childOptions } = calls[1].options
  assert.deepEqual(childOptions, {
    cwd: '/repo',
    shell: false,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  assert.equal(calls[1].options.cwd, '/repo')
  assert.equal(calls[1].options.shell, false)
  assert.equal(calls[1].options.encoding, 'utf8')
  assert.equal(calls[1].options.stdio, 'pipe')
  assert.equal(childEnvironment.NODE_TEST_CONTEXT, undefined)
})

test('tracked test runner fails closed when a child has no exit status or signal', () => {
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return {
        signal: null,
        status: null,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.equal(report.population.execution_status, 1)
  assert.equal(report.population.status, 1)
  assert.equal(report.status, 1)
  assert.equal(report.population.complete, false)
})

test('tracked test population excludes untracked probes and binds executed files to JUnit evidence', () => {
  const expected = populationCase('unexpected-discovery')
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return { signal: null, status: 0, stdout: '<testsuites><!-- tests 1 --></testsuites>' }
    },
    readdirSyncImpl(path) {
      if (path !== '/repo/test') return []
      return [
        { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: 'probe.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ]
    },
  })

  assert.deepEqual(report.population.intended, expected.intended)
  assert.deepEqual(report.population.discovered, expected.discovered)
  assert.deepEqual(report.population.selected, expected.selected)
  assert.deepEqual(report.population.executed, expected.executed)
  assert.equal(report.population.status, expected.status)
  assert.equal(report.population.complete, expected.complete)
  assert.deepEqual(report.population.executions, [{
    file: 'test/a.test.js',
    status: 0,
    signal: null,
    tests: 1,
    outcome: 'passed',
  }])
})

test('a successful child cannot hide truncated test discovery', () => {
  const expected = populationCase('discovery-truncated')
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [],
  })

  assert.deepEqual(report.population.intended, expected.intended)
  assert.deepEqual(report.population.discovered, expected.discovered)
  assert.deepEqual(report.population.selected, expected.selected)
  assert.deepEqual(report.population.executed, expected.executed)
  assert.equal(report.population.execution_status, expected.execution_status)
  assert.equal(report.population.status, expected.status)
  assert.equal(report.population.complete, expected.complete)
  assert.deepEqual(
    validateTrackedTestPopulationReport(report.population, {
      executionLog: report.output,
    }),
    { ok: true },
  )
})

test('tracked test runner does not count an empty test report as executed', () => {
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return { signal: null, status: 0, stdout: '<testsuites/>' }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.deepEqual(report.population.executed, [])
  assert.equal(report.population.execution_status, 1)
  assert.equal(report.population.status, 1)
  assert.equal(report.status, 1)
  assert.equal(report.population.complete, false)
  assert.deepEqual(report.population.executions, [{
    file: 'test/a.test.js',
    status: 0,
    signal: null,
    tests: 0,
    outcome: 'no-report',
  }])
})

test('full population gate fails when the discovered population differs from intent', () => {
  const expected = populationCase('incomplete-discovery')
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0test/b.test.js\0') }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.deepEqual(report.population.intended, expected.intended)
  assert.deepEqual(report.population.discovered, expected.discovered)
  assert.deepEqual(report.population.selected, expected.selected)
  assert.deepEqual(report.population.executed, expected.executed)
  assert.equal(report.population.execution_status, expected.execution_status)
  assert.equal(report.population.status, expected.status)
  assert.equal(report.population.complete, expected.complete)
})

test('no-defect full population control keeps a complete successful run green', () => {
  const expected = populationCase('clean-full-population')
  const result = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  const { population: report } = result
  assert.equal(report.execution_status, expected.execution_status)
  assert.equal(report.schema, 'revia.test-population@0.2.0')
  assert.equal(report.status, expected.status)
  assert.equal(report.complete, expected.complete)
  assert.equal(report.source_revision, TEST_SOURCE_REVISION)
  assert.equal(report.working_tree_clean, true)
  assert.equal(JSON.stringify(report).includes('/node'), false)
  assert.match(report.worktree_status_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.match(report.fixture_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.match(report.command_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.match(report.execution_log_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(report.execution_log_digest, sha256(result.output))
  assert.match(report.evidence_digest, /^sha256:[0-9a-f]{64}$/u)
  assert.deepEqual(
    validateTrackedTestPopulationReport(report, { executionLog: result.output }),
    { ok: true },
  )

  const alteredPopulation = structuredClone(report)
  alteredPopulation.executed = []
  assert.deepEqual(
    validateTrackedTestPopulationReport(alteredPopulation, {
      executionLog: result.output,
    }),
    { code: 'test-population-evidence-digest-mismatch', ok: false },
  )
})

test('population provenance changes when fixture, command, or source revision changes', () => {
  const makeReport = ({
    execPath = '/node',
    files = ['test/a.test.js'],
    requested = [],
    revision = TEST_SOURCE_REVISION,
    worktreeStatus = '',
  } = {}) => runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath,
    nodeVersion: '22.16.0',
    requested,
    spawnSyncImpl(command, args) {
      if (command === 'git' && args[0] === 'ls-files') {
        return { status: 0, stdout: Buffer.from(`${files.join('\0')}\0`) }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => files.map((file) => ({
      name: file.slice('test/'.length),
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    })),
  }, revision, worktreeStatus).population

  const base = makeReport()
  const changedCommand = makeReport({ execPath: '/alternate/node' })
  const changedRevision = makeReport({ revision: 'b'.repeat(40) })
  const changedFixture = makeReport({
    files: ['test/a.test.js', 'test/b.test.js'],
  })
  const dirtyWorktree = makeReport({
    worktreeStatus: ' M src/toolchain/tracked-test-runner.js\n',
  })
  assert.notEqual(base.fixture_digest, changedRevision.fixture_digest)
  assert.notEqual(base.fixture_digest, changedFixture.fixture_digest)
  assert.notEqual(base.command_digest, changedCommand.command_digest)
  assert.notEqual(base.evidence_digest, changedCommand.evidence_digest)
  assert.equal(base.working_tree_clean, true)
  assert.equal(dirtyWorktree.working_tree_clean, false)
  assert.notEqual(base.worktree_status_digest, dirtyWorktree.worktree_status_digest)
})

test('a passing explicit subset is not reported as a complete full population', () => {
  const expected = populationCase('explicit-subset')
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    requested: ['test/a.test.js', 'test/b.test.js'],
    spawnSyncImpl(command) {
      if (command === 'git') {
        return {
          status: 0,
          stdout: Buffer.from('test/a.test.js\0test/b.test.js\0test/c.test.js\0'),
        }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'b.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'c.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.equal(report.status, expected.status)
  assert.equal(report.population.complete, expected.complete)
  assert.deepEqual(report.population.selected, ['test/a.test.js', 'test/b.test.js'])
  assert.deepEqual(report.population.executed, ['test/a.test.js', 'test/b.test.js'])
})

test('an explicit selection equal to the full intended population can be complete', () => {
  const report = runTrackedTestsWithFixture({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    requested: ['test/b.test.js', 'test/a.test.js'],
    spawnSyncImpl(command) {
      if (command === 'git') {
        return { status: 0, stdout: Buffer.from('test/a.test.js\0test/b.test.js\0') }
      }
      return {
        signal: null,
        status: 0,
        stdout: '<testsuites><!-- tests 1 --></testsuites>',
      }
    },
    readdirSyncImpl: () => [
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'b.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.equal(report.status, 0)
  assert.equal(report.population.complete, true)
  assert.deepEqual(report.population.selected, ['test/a.test.js', 'test/b.test.js'])
  assert.deepEqual(report.population.executed, ['test/a.test.js', 'test/b.test.js'])
})

test('CLI refuses a green child run when discovered population differs from intent', () => {
  const root = mkdtempSync(join(tmpdir(), 'revia-test-population-'))
  try {
    const testRoot = join(root, 'test')
    mkdirSync(testRoot)
    writeFileSync(join(testRoot, 'a.test.js'), "import test from 'node:test'; test('passes', () => {})\n")
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', 'test/a.test.js'], { cwd: root })
    execFileSync('git', [
      '-c', 'user.name=Revia Test',
      '-c', 'user.email=revia-test@example.invalid',
      'commit', '--quiet', '-m', 'population fixture',
    ], { cwd: root })
    writeFileSync(join(testRoot, 'probe.test.js'), "import test from 'node:test'; test('probe', () => {})\n")
    const result = spawnSync(process.execPath, [RUNNER], {
      cwd: root,
      encoding: 'utf8',
    })
    const report = JSON.parse(result.stdout)

    assert.equal(result.status, 1)
    assert.deepEqual(report.intended, ['test/a.test.js'])
    assert.deepEqual(report.discovered, ['test/a.test.js', 'test/probe.test.js'])
    assert.deepEqual(report.selected, ['test/a.test.js'])
    assert.deepEqual(report.executed, ['test/a.test.js'])
    assert.equal(report.execution_status, 0)
    assert.equal(report.status, 1)
    assert.equal(report.complete, false)
    assert.deepEqual(report.executions.map(({ outcome }) => outcome), ['passed'])
    assert.deepEqual(
      validateTrackedTestPopulationReport(report, { executionLog: result.stderr }),
      { ok: true },
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('JUnit execution evidence rejects files outside the selected population', () => {
  assert.throws(
    () => parseExecutedTestFiles(
      '<testsuites><testcase file="/repo/test/other.test.js"/></testsuites>',
      { cwd: '/repo', selected: ['test/a.test.js'] },
    ),
    /tracked test execution evidence invalid/u,
  )
})

test('tracked test runner rejects Node versions below the full-suite runtime floor before discovery or spawn', () => {
  for (const nodeVersion of ['22.0.0', '22.7.1', '22.15.1', '21.9.9']) {
    let discovered = false
    let spawned = false

    assert.throws(
      () => runTrackedTests({
        cwd: '/repo',
        execPath: '/node',
        nodeVersion,
        requested: ['test/a.test.js'],
        readdirSyncImpl() {
          discovered = true
          return [
            {
              name: 'a.test.js',
              isDirectory: () => false,
              isFile: () => true,
              isSymbolicLink: () => false,
            },
          ]
        },
        spawnSyncImpl() {
          spawned = true
          return { signal: null, status: 0 }
        },
      }),
      (error) => error.code === 'unsupported-node-version'
        && error.message.includes('requires Node.js >=22.16.0')
        && error.message.includes(`found ${nodeVersion}`),
    )

    assert.equal(discovered, false)
    assert.equal(spawned, false)
  }
})

test('tracked test runner accepts the declared Node floor and subsequent major versions', () => {
  for (const nodeVersion of ['22.16.0', '22.16.1', '23.0.0']) {
    const result = runTrackedTestsWithFixture({
      cwd: '/repo',
      execPath: '/node',
      nodeVersion,
      requested: ['test/a.test.js'],
      spawnSyncImpl(command) {
        if (command === 'git') {
          return { status: 0, stdout: Buffer.from('test/a.test.js\0') }
        }
        return {
          signal: null,
          status: 0,
          stdout: '<testsuites><!-- tests 1 --><testcase file="/repo/test/a.test.js"/></testsuites>',
        }
      },
      readdirSyncImpl: () => [
        {
          name: 'a.test.js',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
      ],
    })

    assert.deepEqual(result.population.executed, ['test/a.test.js'])
    assert.equal(result.population.complete, true)
  }
})

test('bound Windows runner verifies the exact source-built executable before launch', () => {
  const workflow = readFileSync(
    join(ROOT, '.github/workflows/windows-native.yml'),
    'utf8',
  )
  assert.match(
    workflow,
    /windows-x64-build:[\s\S]*?outputs:\s*\n\s+executable_sha256:\s+\$\{\{\s*steps\.verify-executable\.outputs\.sha256\s*\}\}/u,
  )
  assert.match(
    workflow,
    /- name: Verify build target and record executable digest\s*\n\s+id: verify-executable/u,
  )
  assert.match(
    workflow,
    /Get-FileHash[\s\S]*?\$env:GITHUB_OUTPUT[\s\S]*?sha256=\$hash/u,
  )
  assert.match(
    workflow,
    /windows-x64-bound-runner:[\s\S]*?EXPECTED_EXE_SHA256:\s+\$\{\{\s*needs\.windows-x64-build\.outputs\.executable_sha256\s*\}\}/u,
  )

  const verifyDownloaded = workflow.indexOf(
    'if ($hash -ne $env:EXPECTED_EXE_SHA256)',
  )
  const launchDownloaded = workflow.indexOf('& $exe --version', verifyDownloaded)
  assert.notEqual(verifyDownloaded, -1)
  assert.notEqual(launchDownloaded, -1)
  assert.ok(verifyDownloaded < launchDownloaded)
})
