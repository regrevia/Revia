import assert from 'node:assert/strict'
import { chmod, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// The walk used to belong to --refresh alone, so a tree missing a published
// root was refused by that mode and called clean by the two that read it. Now
// every mode walks, and this file asks every mode: the same tree has to draw
// the same refusal whichever command the operator ran, otherwise the name is
// a property of the mode rather than of the fault.
const MODES = ['--check', '--write', '--refresh']

// A tree the gate itself calls clean. Breaking it from here means the refusal
// below is the only thing wrong, so no earlier check can answer instead.
async function healthy() {
  const root = await temporaryRoot('nothing-is-missing')
  const first = await run(root, '--refresh')
  assert.equal(first.status, 0, first.stderr)
  return root
}

async function refuse(mode, breakTree) {
  const root = await healthy()
  const restore = await breakTree(root)
  try {
    return await run(root, mode)
  } finally {
    await restore?.()
  }
}

function assertRefused(result, code) {
  assert.equal(result.status, 1)
  assert.equal(result.stderr, `${code}\n`)
  assert.equal(result.stdout, '')
}

// `native` is the largest published root and the one whose absence an operator
// can cause by checking out a subset of the tree; the walk is where it lands.
test('a published source root that is gone is named in every mode', async () => {
  for (const mode of MODES) {
    const result = await refuse(mode, async (root) => {
      await rm(join(root, 'native'), { recursive: true, force: true })
    })
    assertRefused(result, 'source-import-source-root-missing')
  }
})

// A root the tree holds a file at is not a directory to restore: it is removed
// and replaced, not chmodded. Only the walk asks the question, so the reading
// modes answer it with the same name.
test('a source root that is a file is named in every mode', async () => {
  for (const mode of MODES) {
    const result = await refuse(mode, async (root) => {
      await rm(join(root, 'native'), { recursive: true, force: true })
      await writeFile(join(root, 'native'), 'not a directory\n')
    })
    assertRefused(result, 'source-import-source-root-invalid')
  }
})

// The root is asked about before the walk, so a link standing where a root
// belongs never publishes whatever it points at: it is the same refusal every
// other link in the tree draws.
test('a source root that is a symbolic link is named in every mode', async () => {
  for (const mode of MODES) {
    const result = await refuse(mode, async (root) => {
      await rm(join(root, 'native'), { recursive: true, force: true })
      await symlink(join(root, 'src'), join(root, 'native'))
    })
    assertRefused(result, 'source-import-symlink')
  }
})

// The catch is narrowed to ENOENT: a fault inside a root must keep its own
// name, or the operator who reads it looks for a directory that is present.
test('a fault inside a root keeps its own name in every mode', async () => {
  for (const mode of MODES) {
    const result = await refuse(mode, async (root) => {
      await symlink(join(root, 'README.md'), join(root, 'doc/link.md'))
    })
    assertRefused(result, 'source-import-symlink')
  }
})

// A root that is there and cannot be entered is neither absent nor the wrong
// kind: no refresh brings it back and nothing is removed, so it is a
// permission to fix rather than a directory to restore.
test('a source root that cannot be entered is named in every mode', async () => {
  for (const mode of MODES) {
    const result = await refuse(mode, async (root) => {
      const rootPath = join(root, 'native')
      await chmod(rootPath, 0o000)
      return () => chmod(rootPath, 0o755)
    })
    assertRefused(result, 'source-import-directory-unreadable')
  }
})
