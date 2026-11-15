import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// --refresh writes the allowlist, so a directory on that path stops the one
// mode that could repair the list. The EISDIR it threw carried an absolute
// path that stableCode() dropped to source-import-failed, which says nothing
// about the path refusing the file.
test('a refresh that cannot write the allowlist is named', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
  await mkdir(join(root, 'SOURCE_IMPORT_FILES.json'))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-unwritable\n')
  assert.equal(result.stdout, '')
})

// The reading modes never write, so a directory on the path there is still the
// unreadable case the earlier package left unnamed on purpose: it is not
// unwritable, and saying so would point the operator at permissions.
test('the reading modes keep their unreadable case', async () => {
  for (const mode of ['--check', '--write']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0)
    await rm(join(root, 'SOURCE_IMPORT_FILES.json'))
    await mkdir(join(root, 'SOURCE_IMPORT_FILES.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-failed\n', mode)
  }
})

// Refusing a marked list is not a write fault, and --refresh refuses one
// before writing: a refresh must not erase the mark that made it refuse.
test('a marked allowlist is still refused before the write', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root)).status, 0)
  const path = join(root, 'SOURCE_IMPORT_FILES.json')
  await writeFile(path, `\uFEFF${await readFile(path, 'utf8')}`)

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'byte-order-mark-not-allowed\n')
})
