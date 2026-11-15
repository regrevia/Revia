import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The allowlist is the input the whole gate is built on: every path the
// manifest hashes comes from it. When it is gone, --check and --write both
// threw a raw ENOENT carrying an absolute path, and stableCode() dropped that
// to source-import-failed — the same word a document it cannot parse reports.
// --refresh is different: it writes the list, so not having one yet is the
// state it exists to fix.
test('a missing allowlist is named in --check and --write', async () => {
  for (const mode of ['--check', '--write']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0)
    await rm(join(root, 'SOURCE_IMPORT_FILES.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-allowlist-missing\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

// The catch is narrowed to ENOENT: a list that is at the path but cannot be
// read is a different fault, and calling it missing would send the operator to
// rewrite a file that is already there. It is not unnamed either, since this
// package gave the reading modes a name of their own for it.
test('an allowlist that cannot be read is not called missing', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_FILES.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-unreadable\n')
})

// --refresh writes the allowlist, so an absent one is the empty case it is
// there for rather than a fault; the manifest it then writes is complete.
test('a missing allowlist is what --refresh writes', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /"file_count":\d+/u)
})
