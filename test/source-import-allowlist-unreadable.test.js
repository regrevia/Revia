import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A path that cannot be read as a list is not a list with something wrong in
// it: parsing never gets that far. The raw EISDIR carried an absolute path,
// which stableCode() dropped to the unnamed failure, so --check and --write
// named nothing while --refresh had a name for the same obstacle.
test('an allowlist that cannot be read is named in the reading modes', async () => {
  for (const mode of ['--check', '--write']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root)).status, 0, mode)
    await rm(join(root, 'SOURCE_IMPORT_FILES.json'), { force: true })
    await mkdir(join(root, 'SOURCE_IMPORT_FILES.json'))

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-allowlist-unreadable\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

// The absent list keeps its own name: it is the state --refresh exists to fix,
// and it must not be folded into a fault the operator cannot repair by writing.
test('an absent allowlist keeps saying it is missing', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await rm(join(root, 'SOURCE_IMPORT_FILES.json'), { force: true })

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-missing\n')
})
