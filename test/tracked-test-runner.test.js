import assert from 'node:assert/strict'
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
} from '../src/toolchain/tracked-test-runner.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RUNNER = join(ROOT, 'scripts/run-tracked-tests.js')

test('tracked test runner floor matches the declared package engine', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.engines.node, `>=${MINIMUM_NODE_VERSION}`)
})

test('Node validation uploads machine population and execution evidence', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/validate.yml'), 'utf8')
  assert.match(workflow, /node scripts\/run-tracked-tests\.js > node-test-population\.json 2> node-test-execution\.log/u)
  assert.match(workflow, /name: Upload Node population evidence/u)
  assert.match(workflow, /if: always\(\)/u)
  assert.match(workflow, /node-test-population-\$\{\{ matrix\.node-version \}\}/u)
  assert.match(workflow, /node-test-population\.json[\s\S]*?node-test-execution\.log[\s\S]*?node-test-runner\.error/u)
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

test('tracked test runner invokes Node without a shell and returns stable status', () => {
  const calls = []
  const result = runTrackedTests({
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
  assert.deepEqual(calls[1], {
    args: [
      '--test',
      '--experimental-test-isolation=none',
      '--test-reporter=junit',
      'test/a.test.js',
    ],
    command: '/node',
    options: {
      cwd: '/repo',
      shell: false,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  })
})

test('tracked test runner fails closed when a child has no exit status or signal', () => {
  const report = runTrackedTests({
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
  const report = runTrackedTests({
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

  assert.deepEqual(report.population.intended, ['test/a.test.js'])
  assert.deepEqual(report.population.discovered, ['test/a.test.js', 'test/probe.test.js'])
  assert.deepEqual(report.population.selected, ['test/a.test.js'])
  assert.deepEqual(report.population.executed, ['test/a.test.js'])
  assert.equal(report.population.complete, false)
  assert.deepEqual(report.population.executions, [{
    file: 'test/a.test.js',
    status: 0,
    signal: null,
    tests: 1,
    outcome: 'passed',
  }])
})

test('tracked test runner does not count an empty test report as executed', () => {
  const report = runTrackedTests({
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
  const report = runTrackedTests({
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

  assert.deepEqual(report.population.intended, ['test/a.test.js', 'test/b.test.js'])
  assert.deepEqual(report.population.discovered, ['test/a.test.js'])
  assert.equal(report.population.execution_status, 0)
  assert.equal(report.population.status, 1)
  assert.equal(report.status, 1)
  assert.equal(report.population.complete, false)
})

test('no-defect full population control keeps a complete successful run green', () => {
  const report = runTrackedTests({
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

  assert.equal(report.population.execution_status, 0)
  assert.equal(report.population.status, 0)
  assert.equal(report.status, 0)
  assert.equal(report.population.complete, true)
})

test('a passing explicit subset is not reported as a complete full population', () => {
  const report = runTrackedTests({
    cwd: '/repo',
    execPath: '/node',
    nodeVersion: '22.16.0',
    requested: ['test/a.test.js'],
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
  assert.equal(report.population.complete, false)
  assert.deepEqual(report.population.selected, ['test/a.test.js'])
  assert.deepEqual(report.population.executed, ['test/a.test.js'])
})

test('CLI refuses a green child run when discovered population differs from intent', () => {
  const root = mkdtempSync(join(tmpdir(), 'revia-test-population-'))
  try {
    const testRoot = join(root, 'test')
    mkdirSync(testRoot)
    writeFileSync(join(testRoot, 'a.test.js'), "import test from 'node:test'; test('passes', () => {})\n")
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', 'test/a.test.js'], { cwd: root })
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
    const result = runTrackedTests({
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
