import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// Every other link in the tree is refused: an entry inside a walked root is
// source-import-symlink, an explicit path is source-import-symlink, the
// allowlist and the manifest have their own names for the same reason. A link
// sitting on a source root was the one that got through, because the walk is
// entered before anything looks at the root itself -- so a root that points
// somewhere else quietly publishes whatever it points at instead of the tree.
test('a source root that is a link is refused rather than followed', async () => {
  const root = await temporaryRoot('a root that is a link')
  const outside = join(root, 'outside-src')
  await mkdir(outside)
  await writeFile(join(outside, 'stray.js'), 'export const stray = 1\n')
  await rm(join(root, 'src'), { recursive: true, force: true })
  await symlink(outside, join(root, 'src'))

  const result = await run(root, '--refresh')

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-symlink\n')
  assert.equal(result.stdout, '')
})

// The refusal has to be about the link, not about the root: a root that is a
// real directory still refreshes, which is what a broader check would break.
test('a source root that is a directory still refreshes', async () => {
  const root = await temporaryRoot('a root that is a directory')

  const result = await run(root, '--refresh')

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
})
