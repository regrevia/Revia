import assert from 'node:assert/strict'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A source root that is not a directory is not a permission problem: nothing
// to enter, and no chmod makes it a directory. It used to be reported as
// source-import-directory-unreadable, which sends the operator to look at mode
// bits instead of at the file standing where the tree belongs.
test('a source root that is not a directory is named as such', async () => {
  const root = await temporaryRoot('a source root that is not a directory')
  await rm(join(root, 'src'), { recursive: true, force: true })
  await writeFile(join(root, 'src'), 'not a directory\n')

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-source-root-invalid\n')
  assert.equal(result.stdout, '')
})

// The two repairs have to stay apart: a root nobody may enter is a permission
// to fix, while a root that is a file has to be removed and replaced. This
// case would pass under the old name too, which is why the case above is the
// one that carries the fault.
test('a root that cannot be entered keeps the unreadable name', async () => {
  const root = await temporaryRoot('a source root nobody may enter')
  const locked = join(root, 'src')
  await chmod(locked, 0o000)

  let result
  try {
    result = await run(root, '--refresh')
  } finally {
    await chmod(locked, 0o755)
  }

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-directory-unreadable\n')
})
