import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  publishedPaths,
  run,
  temporaryRoot,
} from '../test-support/source-import-fixture.js'

test('a published path that is absent is named instead of the unnamed failure', async () => {
  const root = await temporaryRoot('AGENTS.md')
  const result = await run(root)
  assert.equal(result.status, 1, '--refresh accepted a root without AGENTS.md')
  assert.equal(result.stderr, 'source-import-explicit-path-missing\n')
  assert.equal(result.stdout, '', 'a refused refresh wrote a result it did not compute')
})

test('the same root without the refusal selects every published path', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  const result = await run(root)
  assert.equal(result.status, 0, result.stderr)
  const { files } = JSON.parse(
    await readFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'utf8'),
  )
  const expected = [...(await publishedPaths())].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)))
  assert.deepEqual(files, expected)
})
