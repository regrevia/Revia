import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// --check compares bytes, so it reads the manifest without parsing it and has
// no content to fault. A directory on that path cannot be read at all, and the
// raw EISDIR carried an absolute path that stableCode() dropped, so the mode
// named nothing while the same obstacle under the writing modes already had a
// name. The reading mode now says what the path was.
test('a manifest that cannot be read is named in --check', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'), { force: true })
  await mkdir(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-unreadable\n')
  assert.equal(result.stdout, '')
})

// The absent manifest keeps its own name: it is not drift, since there are no
// bytes to disagree, and --refresh writes it. Folding the two together would
// send an operator to delete a path that is already gone.
test('an absent manifest keeps saying it is missing', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'), { force: true })

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-missing\n')
})
