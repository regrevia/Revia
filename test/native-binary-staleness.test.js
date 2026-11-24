import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { isNativeBinaryStale, newestWatchedSource } from './native-binary-staleness.js'

// The guard's boundary is the equality case: a source file restored from an
// archive can carry the binary's own mtime, and `newest > binary.mtimeMs` read
// that as fresh. These cases pin the three relations the decision has to
// separate, plus the absent binary, without spawning a compiler.

const BASE_MTIME_MS = 1_700_000_000_000

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'revia-native-staleness-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeFileAt(path, mtimeMs, contents = 'fn main() {}\n') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  const seconds = mtimeMs / 1000
  utimesSync(path, seconds, seconds)
}

test('a source file newer than the binary makes it stale', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    const binary = join(root, 'native', 'target', 'debug', 'revia')
    writeFileAt(source, BASE_MTIME_MS)
    writeFileAt(binary, BASE_MTIME_MS - 1_000, 'binary\n')
    assert.equal(isNativeBinaryStale(binary, join(root, 'native')), true)
  } finally {
    cleanup()
  }
})

test('a source file sharing the binary mtime makes it stale', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    const binary = join(root, 'native', 'target', 'debug', 'revia')
    writeFileAt(source, BASE_MTIME_MS)
    writeFileAt(binary, BASE_MTIME_MS, 'binary\n')
    assert.equal(isNativeBinaryStale(binary, join(root, 'native')), true)
  } finally {
    cleanup()
  }
})

test('a binary newer than the watched source is reused', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    const binary = join(root, 'native', 'target', 'debug', 'revia')
    writeFileAt(source, BASE_MTIME_MS)
    writeFileAt(binary, BASE_MTIME_MS + 1_000, 'binary\n')
    assert.equal(isNativeBinaryStale(binary, join(root, 'native')), false)
  } finally {
    cleanup()
  }
})

test('an absent binary is stale', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    writeFileAt(source, BASE_MTIME_MS)
    const binary = join(root, 'native', 'target', 'debug', 'revia')
    assert.equal(isNativeBinaryStale(binary, join(root, 'native')), true)
  } finally {
    cleanup()
  }
})

test('build output does not count as watched source', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    const binary = join(root, 'native', 'target', 'debug', 'revia')
    writeFileAt(source, BASE_MTIME_MS)
    writeFileAt(binary, BASE_MTIME_MS + 1_000, 'binary\n')
    writeFileAt(join(root, 'native', 'target', 'debug', 'generated.rs'), BASE_MTIME_MS + 5_000)
    assert.equal(isNativeBinaryStale(binary, join(root, 'native')), false)
  } finally {
    cleanup()
  }
})

test('the newest watched source ignores other extensions', () => {
  const { root, cleanup } = makeTree()
  try {
    const source = join(root, 'native', 'revia-core', 'src', 'lib.rs')
    writeFileAt(source, BASE_MTIME_MS)
    writeFileAt(join(root, 'native', 'README.md'), BASE_MTIME_MS + 5_000, 'docs\n')
    assert.equal(newestWatchedSource(join(root, 'native')), BASE_MTIME_MS)
  } finally {
    cleanup()
  }
})
