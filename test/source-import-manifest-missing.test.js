import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// --refresh writes both documents, so a tree can hold a fresh allowlist and no
// manifest at all: the first run after a clone that skipped it, or a checkout
// where the file was deleted. Reading the manifest is the only step that
// touches it, and it threw a raw ENOENT carrying an absolute path, which
// stableCode() drops to source-import-failed — the same word an unparseable
// document reports.
test('a missing manifest is named instead of the unnamed failure', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-missing\n')
  assert.equal(result.stdout, '')
})

// The name has to be the missing file, not the stale one: a manifest that is
// present but disagrees is a different repair, and --refresh fixes that one.
test('a stale manifest is still drift, not missing', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await writeFile(join(root, 'README.md'), 'edited after the refresh\n')

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-drift\n')
})

// The catch is narrowed to ENOENT: a manifest that is there but cannot be read
// is a different fault, and reporting it as missing would send the operator to
// restore a file that is already at the path.
test('a manifest that cannot be read is not called missing', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-unreadable\n')
})
