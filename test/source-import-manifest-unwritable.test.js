import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The modes that write the manifest were the last unguarded pair: when the
// path is occupied by a directory the write cannot land, and the EISDIR it
// threw carried an absolute path that stableCode() dropped to
// source-import-failed. Nothing about that word says the file is unwritable.
test('a manifest path that cannot be written is named', async () => {
  for (const mode of ['--refresh', '--write']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0)
    await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
    await mkdir(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-manifest-unwritable\n', mode)
    // Both modes wrote the list before they reached the manifest, and both
    // found it correct, so the transition they carry is the allowlist one:
    // `unchanged`. The field describes what this mode decided, not what the
    // other mode would have done with the same tree.
    assert.deepEqual(JSON.parse(result.stdout), {
      allowlist_transition: 'unchanged',
      reason: 'source-import-manifest-unwritable',
      schema: 'revia.source-import-refusal@1.0.0',
    }, mode)
  }
})

// --check never writes, so a directory at the manifest path is the same
// unreadable case the previous package named, not an unwritable one.
test('a directory at the manifest path is not drift in --check', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  await rm(join(root, 'SOURCE_IMPORT_MANIFEST.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_MANIFEST.json'))

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-unreadable\n')
})
