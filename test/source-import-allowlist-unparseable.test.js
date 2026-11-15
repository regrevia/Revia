import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'
import { ALLOWLIST_SCHEMA } from '../scripts/source-import-selection.mjs'

// A list that is present but holds nothing JSON.parse() can read is not a
// stale entry, not a layout the schema can describe, and not an absent list:
// it is a file that has to be restored from Git. The raw SyntaxError carried
// no name from the gate's vocabulary, so the modes that read the list printed
// the unnamed failure and the operator could not tell a corrupt list from a
// real fault. --refresh is not one of them: it writes the list from the tree
// and never parses the one it replaces, so it stays able to repair this.
test('an allowlist that is not JSON is named in the reading modes', async () => {
  for (const mode of ['--check', '--write']) {
    const root = await temporaryRoot('a list that cannot be parsed')
    await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'not json\n')

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stderr, 'source-import-allowlist-unparseable\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

test('an empty allowlist is the same repair', async () => {
  const root = await temporaryRoot('an empty list')
  await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), '')

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-unparseable\n')
})

// The mark is caught before the parse, so this case exists to keep the new
// name from swallowing a fault that already had one: a marked list must still
// say byte-order-mark-not-allowed.
test('a marked list keeps its own name', async () => {
  const root = await temporaryRoot('a marked list')
  await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), '\ufeff{"schema":"x"}\n')

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'byte-order-mark-not-allowed\n')
})

test('a readable list is still described by its schema', async () => {
  const root = await temporaryRoot('a list of the wrong shape')
  await writeFile(
    join(root, 'SOURCE_IMPORT_FILES.json'),
    `${JSON.stringify({ schema: ALLOWLIST_SCHEMA, files: 'x' })}\n`,
  )

  const result = await run(root, '--check')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-invalid\n')
})
