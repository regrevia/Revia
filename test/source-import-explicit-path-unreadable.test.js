import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { publishedPaths, run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A published path whose directory cannot be entered is not gone and not
// stale: the file is still there, and neither a refresh nor a list edit can
// reach it. The walk names a directory it cannot enter, but the explicit paths
// are not walked from their parent, so this one raised EACCES with an absolute
// path in the message and the unnamed failure was printed.
test('a published path in a directory that cannot be entered is named', async () => {
  const root = await temporaryRoot('a published path nobody may reach')
  const found = (await publishedPaths()).find((path) => path.includes('/'))
  assert.ok(found, 'the selection publishes no nested path')
  const parent = join(root, dirname(found))
  await chmod(parent, 0o000)

  let result
  try {
    result = await run(root, '--refresh')
  } finally {
    await chmod(parent, 0o755)
  }

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-explicit-path-unreadable\n')
  assert.equal(result.stdout, '')
})

// The repairs stay apart: a path that is gone comes back by restoring it, while
// this one is there and the directory holding it needs its permission fixed.
// This case would pass under the new name too, so the case above carries the
// fault.
test('a published path that is gone keeps its own name', async () => {
  const found = (await publishedPaths()).find((path) => path.includes('/'))
  assert.ok(found, 'the selection publishes no nested path')
  const root = await temporaryRoot(found)

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-explicit-path-missing\n')
})
