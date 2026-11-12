import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { selectFiles } from '../scripts/source-import-selection.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// `--refresh` rewrites the allowlist from this selection, so any admitted file
// the selection cannot reach is dropped on the next refresh without a diff
// that mentions dropping it. Keeping the two sets equal is the whole contract.
test('refresh selects exactly the admitted files', async () => {
  const admitted = JSON.parse(
    readFileSync(join(ROOT, 'SOURCE_IMPORT_FILES.json'), 'utf8'),
  ).files
  const selected = await selectFiles(ROOT)
  const dropped = admitted.filter((path) => !selected.includes(path))
  assert.deepEqual(dropped, [], 'refresh would drop admitted files')
  assert.deepEqual(
    selected.filter((path) => !admitted.includes(path)),
    [],
    'files on disk are not admitted',
  )
})
