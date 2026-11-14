import assert from 'node:assert/strict'
import { rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'


// `native` is the largest published root and the one whose absence an operator
// can cause by checking out a subset of the tree; the walk is where it lands.
test('a published source root that is gone is named', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await rm(join(root, 'native'), { recursive: true, force: true })

  const result = await run(root)

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-source-root-missing\n')
  assert.equal(result.stdout, '')
})

// The catch is narrowed to ENOENT: a fault inside a root must keep its own
// name, or the operator who reads it looks for a directory that is present.
test('a fault inside a root keeps its own name', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await symlink(join(root, 'README.md'), join(root, 'doc/link.md'))

  const result = await run(root)

  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-symlink\n')
})
