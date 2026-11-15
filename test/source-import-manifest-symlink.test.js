import assert from 'node:assert/strict'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A link at the manifest path is not the manifest: the write lands on whatever
// the link points at, so the mode that writes reports the bytes it computed
// while the file Git tracks is still the link. Reading follows the same link,
// so a dangling one looks exactly like a missing manifest.
test('a linked manifest path is named in every mode', async () => {
  for (const mode of ['--check', '--write', '--refresh']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0, mode)
    await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
    await writeFile(join(root, 'elsewhere.json'), 'x')
    await symlink(join(root, 'elsewhere.json'), join(root, 'SOURCE_IMPORT_MANIFEST.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-manifest-symlink\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

// A dangling link has no bytes to disagree with, so the drift comparison and
// the missing case both miss what is wrong with the path.
test('a link that points at nothing is not a missing manifest', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
  await symlink(join(root, 'nothing-here.json'), join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-symlink\n')
})
