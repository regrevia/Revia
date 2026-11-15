import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// Only --refresh walks the sources. A directory inside a walked root that the
// process cannot enter stopped the walk with EACCES, which carries an absolute
// path and so becomes the unnamed failure: the operator saw a fault with no
// name and no repair, in the one mode whose whole job is to rewrite the list
// from the tree.
//
// A directory is used rather than a file so the case also holds when the suite
// runs as root, where a mode bit on a file would not stop a read.
test('a directory the walk cannot enter is named in --refresh', async () => {
  const root = await temporaryRoot('a directory the walk cannot enter')
  const locked = join(root, 'src/deep')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'x.mjs'), 'x\n')
  await chmod(locked, 0o000)

  let result
  try {
    result = await run(root, '--refresh')
  } finally {
    await chmod(locked, 0o755)
  }

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-directory-unreadable\n')
  assert.equal(result.stdout, '')
})

// The reading modes compare the list against the manifest and never walk, so a
// directory they cannot enter is not their fault to report: nothing they do
// touches the tree. Pinning this keeps the new name from spreading to modes
// that cannot reach it.
test('the reading modes never walk, so the same tree is not their fault', async () => {
  const root = await temporaryRoot('a directory the walk cannot enter')
  const locked = join(root, 'src/deep')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'x.mjs'), 'x\n')
  await chmod(locked, 0o000)

  let refreshed
  try {
    refreshed = await run(root, '--refresh')
  } finally {
    await chmod(locked, 0o755)
  }
  assert.equal(refreshed.status, 1)

  // With the directory readable again the list is written, and the manifest it
  // describes is then checkable: the two modes that read it never entered.
  const repaired = await run(root, '--refresh')
  assert.equal(repaired.status, 0)
  const checked = await run(root, '--check')
  assert.notEqual(checked.stderr, 'source-import-directory-unreadable\n')
})
