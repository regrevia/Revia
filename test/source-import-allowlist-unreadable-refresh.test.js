import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// --refresh reads the list before replacing it, because a marked list is
// refused rather than erased. That read can be refused too, and it used to
// rethrow the raw EACCES, whose absolute path stableCode() drops: the one mode
// whose job is to rewrite the list printed the unnamed failure, while the
// modes that only read it named the file.
test('a list that cannot be read is named in --refresh too', async () => {
  const root = await temporaryRoot('a list nobody may read')
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  await chmod(allowlist, 0o000)

  let result
  try {
    result = await run(root, '--refresh')
  } finally {
    await chmod(allowlist, 0o644)
  }

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-unreadable\n')
  assert.equal(result.stdout, '')
})

// The refusal that read exists for is not a file-system error and must keep
// reaching the operator unchanged, so mapping every failure here would be the
// eager fix and this is the case that fails under it.
test('a marked list is still refused by --refresh', async () => {
  const root = await temporaryRoot('a marked list')
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  const { readFile, writeFile } = await import('node:fs/promises')
  const bytes = await readFile(allowlist)
  await writeFile(allowlist, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'byte-order-mark-not-allowed\n')
})
