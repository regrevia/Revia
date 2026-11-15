import assert from 'node:assert/strict'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The allowlist has the same hole the manifest had: a link is not the list,
// so a refresh writes through it and reports success while the tracked file
// stays a link. The reading modes fold the failure into the unnamed error
// because neither the missing case nor the marked-list case describes it.
test('a linked allowlist path is named in every mode', async () => {
  for (const mode of ['--check', '--write', '--refresh']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0, mode)
    await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
    await writeFile(join(root, 'elsewhere.json'), 'x')
    await symlink(join(root, 'elsewhere.json'), join(root, 'SOURCE_IMPORT_FILES.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-allowlist-symlink\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

// A link that points at nothing cannot be read at all, so it must not be
// mistaken for the absent list that --refresh exists to write.
test('a dangling allowlist link is not a missing list', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
  await symlink(join(root, 'nothing-here.json'), join(root, 'SOURCE_IMPORT_FILES.json'))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-symlink\n')
})
