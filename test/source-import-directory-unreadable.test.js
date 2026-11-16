import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// Every mode walks the source roots, so a directory inside a walked root that
// the process cannot enter stops the walk whichever mode asked. The walk used
// to live inside the writer, so this fault stopped `--refresh` alone: `--check`
// compared the list against a tree it had never entered and called the tree
// clean. The walk is now hoisted ahead of the mode branch, and the refusal is
// raised inside `walk()` rather than at the call site so a nested directory is
// told apart from a root that is gone: `ENOENT` is rethrown untouched and still
// becomes `source-import-source-root-missing` at the caller. The two repairs
// stay apart — restore the directory, or fix the permission to enter it.
//
// A directory is used rather than a file so the case also holds when the suite
// runs as root, where a mode bit on a file would not stop a read.
test('a directory the walk cannot enter is named in every mode', async () => {
  const root = await temporaryRoot('a directory the walk cannot enter')
  const locked = join(root, 'src/deep')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'x.mjs'), 'x\n')

  // The list and the manifest are written first, so each mode reaches the walk
  // rather than one of its own absent-file answers.
  const settled = await run(root, '--refresh')
  assert.equal(settled.status, 0, settled.stderr)

  await chmod(locked, 0o000)
  try {
    for (const mode of ['--check', '--write', '--refresh']) {
      const result = await run(root, mode)
      assert.equal(result.status, 1, `${mode} called a tree it cannot enter clean`)
      assert.equal(result.stderr, 'source-import-directory-unreadable\n', `${mode} named one fault two ways`)
      assert.equal(result.stdout, '', `${mode} published a receipt for a tree it could not walk`)
    }
  } finally {
    await chmod(locked, 0o755)
  }
})

// The refusal lands before anything is written, so the lock is the whole of the
// interruption: once it is lifted the tree checks clean with the list it
// already had. A mode that half-wrote before failing would show up here as a
// transition where `unchanged` belongs.
test('a lock that is lifted leaves the tree as it was', async () => {
  const root = await temporaryRoot('a directory the walk cannot enter')
  const locked = join(root, 'src/deep')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'x.mjs'), 'x\n')

  const settled = await run(root, '--refresh')
  assert.equal(settled.status, 0, settled.stderr)

  await chmod(locked, 0o000)
  try {
    assert.equal((await run(root, '--refresh')).status, 1)
  } finally {
    await chmod(locked, 0o755)
  }

  const repaired = await run(root, '--refresh')
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(JSON.parse(repaired.stdout).allowlist_transition, 'unchanged')
  assert.equal(JSON.parse(repaired.stdout).manifest_transition, 'unchanged')

  const checked = await run(root, '--check')
  assert.equal(checked.status, 0, checked.stderr)
})
