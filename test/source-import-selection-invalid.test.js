import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A module that is gone and a module that is there but broken are different
// repairs: the first is restored from Git, the second is read and fixed. Only
// the absence had a name, so the broken one reached the operator as
// `source-import-failed`, a fallback that carries no bytes, no path and no
// parse position — everything needed to act on it was thrown away by
// stableCode() because the whole SyntaxError message fails its pattern. The
// guide already promised the opposite: "a module that is present and broken
// still reports what broke".
async function breakModule(root) {
  // A trailing unclosed parenthesis is a parse error with no import and no
  // missing file involved, so it exercises the recovery path alone.
  await appendFile(join(root, 'scripts/source-import-selection.mjs'), '\nexport const broken = (\n')
}

test('a selection module that is present and broken reports what broke', async () => {
  for (const mode of ['--check', '--write', '--refresh']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root, '--refresh')).status, 0, `${mode} baseline`)
    await breakModule(root)

    const result = await run(root, mode)

    assert.equal(result.status, 1, mode)
    assert.equal(result.stdout, '', mode)
    // One name for the fault, in every mode: the module is loaded before any
    // mode decides what to do, so the mode cannot change the answer.
    assert.equal(result.stderr, 'source-import-selection-invalid\n', mode)
  }
})

test('a module that cannot be opened is not a module that will not parse', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  assert.equal((await run(root, '--refresh')).status, 0, 'baseline')
  // Removing the read permission leaves a file that is present and unreadable,
  // which no syntax fix repairs: the operator has to change mode bits, so the
  // two faults must not share a name.
  const module = join(root, 'scripts/source-import-selection.mjs')
  const source = await readFile(module)
  await chmod(module, 0o000)
  try {
    const result = await run(root, '--check')
    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'source-import-selection-unreadable\n')
  } finally {
    await chmod(module, 0o644)
    assert.deepEqual(await readFile(module), source, 'restore')
  }
})

// A path that holds a directory is not a module that is absent, unreadable or
// broken: nothing is missing from Git, no mode bits bring it back, and the
// source is not what has to change. The loader refuses it before it parses
// anything, with `ERR_UNSUPPORTED_DIR_IMPORT`, which matched none of the three
// names and fell through to `source-import-failed` — the fallback that keeps a
// path out of the refusal and tells the operator nothing about which repair
// applies. The kind is the whole answer here, so it is refused by name.
async function replaceWithDirectory(root) {
  const module = join(root, 'scripts/source-import-selection.mjs')
  const kept = join(root, 'scripts/source-import-selection.mjs.kept')
  await rename(module, kept)
  await mkdir(module)
  return async () => {
    await rm(module, { recursive: true, force: true })
    await rename(kept, module)
  }
}

test('a directory where the module belongs is not a module that will not parse', async () => {
  for (const mode of ['--check', '--write', '--refresh']) {
    const root = await temporaryRoot('nothing-is-missing')
    assert.equal((await run(root, '--refresh')).status, 0, `${mode} baseline`)
    const restore = await replaceWithDirectory(root)
    try {
      const result = await run(root, mode)

      assert.equal(result.status, 1, mode)
      assert.equal(result.stdout, '', mode)
      // The module is loaded before the mode decides anything, so the mode
      // cannot change the name the operator reads.
      assert.equal(result.stderr, 'source-import-selection-invalid-kind\n', mode)
    } finally {
      await restore()
    }
  }
})

test('the guide names the broken module as its own fault', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  // The guide used to promise that a broken module "still reports what broke"
  // while the gate printed the unnamed failure, so the sentence sent the
  // operator looking for a report that did not exist. Each of the three
  // faults now has to be named where the operator reads about them.
  assert.match(guide, /`source-import-selection-invalid`/u)
  assert.match(guide, /`source-import-selection-unreadable`/u)
  assert.match(guide, /`source-import-selection-missing`/u)
  assert.match(guide, /`source-import-selection-invalid-kind`/u)
  assert.doesNotMatch(guide, /a module that is present and broken still reports what broke/u,
    'the guide must not promise a report the gate does not print')
})
