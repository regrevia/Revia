import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runTrackedTests,
  selectTrackedTests,
} from '../src/toolchain/tracked-test-runner.js'

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
