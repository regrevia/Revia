import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  runTrackedTests,
  selectTrackedTests,
} from '../src/toolchain/tracked-test-runner.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

test('tracked test selection is sorted and ignores non-test files', () => {
  const calls = []
  const selected = selectTrackedTests({
    cwd: '/repo',
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
  assert.deepEqual(calls, [{ path: '/repo/test', options: { withFileTypes: true } }])
})

test('requested test subset cannot select probes, escape test root, or repeat paths', () => {
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
      () => selectTrackedTests({ cwd: '/repo', requested, readdirSyncImpl }),
      /invalid tracked test selection/u,
    )
  }
  assert.deepEqual(selectTrackedTests({
    cwd: '/repo',
    requested: ['test/b.test.js'],
    readdirSyncImpl,
  }), ['test/b.test.js'])
})

test('tracked test selection fails closed on git errors and empty output', () => {
  for (const readdirSyncImpl of [
    () => { throw new Error('private filesystem detail') },
    () => [],
  ]) {
    assert.throws(
      () => selectTrackedTests({
        cwd: '/repo',
        readdirSyncImpl,
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
    requested: ['test/a.test.js'],
    spawnSyncImpl(command, args, options) {
      calls.push({ args, command, options })
      return { signal: null, status: 7 }
    },
    readdirSyncImpl: () => [
      { name: 'b.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'a.test.js', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ],
  })

  assert.deepEqual(result, { signal: null, status: 7, tests: 1 })
  assert.deepEqual(calls[0], {
    args: [
      '--test',
      '--experimental-test-isolation=none',
      'test/a.test.js',
    ],
    command: '/node',
    options: {
      cwd: '/repo',
      shell: false,
      stdio: 'inherit',
    },
  })
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
