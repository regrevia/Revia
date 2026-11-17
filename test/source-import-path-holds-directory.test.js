import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { run, temporaryRoot } from '../test-support/source-import-fixture.js'

// A directory standing on the allowlist or the manifest path is the one kind
// the gate deliberately lets past the kind refusal: both are opened in every
// mode, and every mode has its own answer for a path that holds a directory.
// The two answers are not interchangeable — a mode that only reads says the
// path cannot be read, a mode that would replace it says it cannot be written
// — and which one an operator sees is a fact about the mode, so it is pinned
// in all three rather than in the one that happened to have a test.
const MODES = ['--check', '--write', '--refresh']

async function healthy() {
  const root = await temporaryRoot('nothing-is-missing')
  const first = await run(root, '--refresh')
  assert.equal(first.status, 0, first.stderr)
  return root
}

async function refuse(mode, path) {
  const root = await healthy()
  await rm(join(root, path), { force: true })
  await mkdir(join(root, path))
  const result = await run(root, mode)
  await rm(join(root, path), { recursive: true, force: true })
  return result
}

// A refusal that never reached a decision has nothing to report: the mode
// stopped before it computed a transition, and an invented `unchanged` would
// look exactly like a mode that looked and agreed. The two write refusals are
// the other side of that line and carry the transition they interrupted, so
// each caller says which it is holding rather than the helper guessing.
function assertRefused(result, code, transition) {
  assert.equal(result.status, 1)
  assert.equal(result.stderr, `${code}\n`)
  if (transition === undefined) {
    assert.equal(result.stdout, '')
    return
  }
  assert.deepEqual(JSON.parse(result.stdout), {
    allowlist_transition: transition,
    reason: code,
    schema: 'revia.source-import-refusal@1.0.0',
  })
}

// Nothing can be read from a directory, so the two modes that only read have
// no content to name: they report the path that will not be read.
test('a directory on the allowlist path is unreadable to the reading modes', async () => {
  for (const mode of ['--check', '--write']) {
    assertRefused(
      await refuse(mode, 'SOURCE_IMPORT_FILES.json'),
      'source-import-allowlist-unreadable',
    )
  }
})

// --refresh is the mode that replaces the list, so it gets as far as the write
// and names the write: the repair it was run for did not land.
test('a directory on the allowlist path is unwritable to the repair mode', async () => {
  assertRefused(
    await refuse('--refresh', 'SOURCE_IMPORT_FILES.json'),
    'source-import-allowlist-unwritable',
    'created',
  )
})

// The same split for the manifest, which is compared in one mode and replaced
// in the other two.
test('a directory on the manifest path is unreadable to the comparing mode', async () => {
  assertRefused(
    await refuse('--check', 'SOURCE_IMPORT_MANIFEST.json'),
    'source-import-manifest-unreadable',
  )
})

test('a directory on the manifest path is unwritable to the writing modes', async () => {
  for (const mode of ['--write', '--refresh']) {
    assertRefused(
      await refuse(mode, 'SOURCE_IMPORT_MANIFEST.json'),
      'source-import-manifest-unwritable',
      'unchanged',
    )
  }
})

// A repair that reordered the list leaves a directory alone, so the two
// refusals above are the only thing a directory can produce: it never becomes
// a list, and a mode that reached its write still could not land it.
// A refusal an operator only learns from the guide is a claim with nothing
// behind it, so the guide is read here rather than trusted: both names, and
// which mode reaches which, have to be on the page an operator is sent to.
test('the guide names both refusals and the mode that reaches each', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  const clause = guide.split('\n').join(' ').replace(/\s+/gu, ' ')
  assert.match(clause, /the same directory is `source-import-allowlist-unwritable` there/u)
  assert.match(
    clause,
    /the two modes that only read report `source-import-allowlist-unreadable`/u,
  )
  assert.match(clause, /a fact about the mode rather than two names for one fault/u)
  assert.match(clause, /that refusal is the same in every mode, because `--refresh` reads the list/u)
})

test('the gate never removes a directory it cannot write through', async () => {
  const root = await healthy()
  const listPath = join(root, 'SOURCE_IMPORT_FILES.json')
  const before = await import('node:fs/promises').then(({ stat }) => stat(listPath))
  await rm(listPath)
  await mkdir(listPath)
  const result = await run(root, '--refresh')
  const after = await import('node:fs/promises').then(({ stat }) => stat(listPath))
  assertRefused(result, 'source-import-allowlist-unwritable', 'created')
  assert.equal(after.isDirectory(), true)
  assert.notEqual(before.isDirectory(), true)
})
