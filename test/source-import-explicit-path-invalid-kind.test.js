import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// An explicit path is published by the selection whether it is a file or a
// directory, so a path that changed kind is published as the wrong thing and
// the file or directory it replaced disappears from the published set without
// a word: a tree that turned the workflow into a directory refreshed clean and
// dropped the workflow. The kind is what the list means, so it is refused.
test('a published file that became a directory is refused', async () => {
  const root = await temporaryRoot('a published file that became a directory')
  const file = join(root, '.github', 'workflows', 'validate.yml')
  await rm(file)
  await mkdir(file)
  await writeFile(join(file, 'stray.js'), 'export const stray = 1\n')

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-explicit-path-invalid\n')
  assert.equal(result.stdout, '')
})

// The declared directories are published for the same reason files are, and
// the one the tree carries is the guard against refusing every directory
// named in the list -- a refusal that would report a healthy tree as broken.
test('a published directory that became a file is refused', async () => {
  const root = await temporaryRoot('a published directory that became a file')
  const directory = join(root, 'examples', 'agent-expense-review')
  await rm(directory, { recursive: true, force: true })
  await writeFile(directory, 'export const stray = 1\n')

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-explicit-path-invalid\n')
  assert.equal(result.stdout, '')
})

// The refusal is about the kind, not about walking: the declared directory is
// still walked on a healthy tree, so its contents stay published.
test('a healthy tree still publishes the declared directory', async () => {
  const root = await temporaryRoot('a healthy tree')

  const result = await run(root, '--refresh')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const listed = JSON.parse(await readFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'utf8')).files
  assert.ok(listed.some((path) => path.startsWith('examples/agent-expense-review/')))
})
