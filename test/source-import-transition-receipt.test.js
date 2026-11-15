import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot, run } from '../test-support/source-import-fixture.js'

const ALLOWLIST = 'SOURCE_IMPORT_FILES.json'
const MANIFEST = 'SOURCE_IMPORT_MANIFEST.json'

function receipt(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// A mode that repaired the tree and a mode that found nothing to do leave the
// same bytes and the same exit code, so neither the file nor the status can
// tell them apart. The receipt is the only place the difference survives, and
// these tests assert the transition together with the outcome it claims: a
// receipt that says `created` without a manifest on disk is as wrong as one
// that says `unchanged` after replacing the file.

test('--write creates a manifest it reports as created', async () => {
  const root = await temporaryRoot(ALLOWLIST)
  await run(root, '--refresh')
  await unlink(join(root, MANIFEST))

  const written = receipt(await run(root, '--write'))

  assert.equal(written.manifest_transition, 'created')
  const onDisk = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'))
  assert.ok(onDisk.files.length > 0)
  // The claim is about this file, so the receipt's digest has to describe it.
  assert.equal(written.file_count, onDisk.files.length)
})

test('--write leaves a matching manifest alone and says unchanged', async () => {
  const root = await temporaryRoot(ALLOWLIST)
  await run(root, '--refresh')
  const before = await stat(join(root, MANIFEST))

  const again = receipt(await run(root, '--write'))

  assert.equal(again.manifest_transition, 'unchanged')
  const after = await stat(join(root, MANIFEST))
  // "not rewritten" is the postcondition this transition claims, and only the
  // modified time can show it: the bytes would match either way.
  assert.equal(after.mtimeMs, before.mtimeMs)
})

test('--write replaces a stale manifest and says so', async () => {
  const root = await temporaryRoot(ALLOWLIST)
  await run(root, '--refresh')
  // A manifest that holds the wrong bytes is the case a hard-coded
  // `unchanged` would pass while the tree stayed wrong.
  await writeFile(join(root, MANIFEST), '{"files":[],"schema":"x"}')

  const repaired = receipt(await run(root, '--write'))

  assert.equal(repaired.manifest_transition, 'replaced')
  const onDisk = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'))
  assert.equal(onDisk.schema, 'revia.source-import@1.0.0')
  assert.equal(onDisk.files.length, repaired.file_count)
})

test('--refresh writes a missing allowlist and reports created', async () => {
  const root = await temporaryRoot(ALLOWLIST)
  await run(root, '--refresh')
  await unlink(join(root, ALLOWLIST))

  const rebuilt = receipt(await run(root, '--refresh'))

  // A list that is not there was not replaced: nothing existed to compare with,
  // and `replaced` would describe a file the tree never had.
  assert.equal(rebuilt.allowlist_transition, 'created')
  const onDisk = await readFile(join(root, ALLOWLIST), 'utf8')
  assert.ok(onDisk.trim().length > 0)
})

test('--refresh reports the same transition names for the same states', async () => {
  const root = await temporaryRoot(ALLOWLIST)

  const first = receipt(await run(root, '--refresh'))
  assert.equal(first.allowlist_transition, 'replaced')
  assert.equal(first.manifest_transition, 'created')

  const second = receipt(await run(root, '--refresh'))
  assert.equal(second.allowlist_transition, 'unchanged')
  assert.equal(second.manifest_transition, 'unchanged')
})

test('--check reports the state it read in the same names', async () => {
  const root = await temporaryRoot(ALLOWLIST)
  await run(root, '--refresh')

  const checked = receipt(await run(root, '--check'))

  assert.equal(checked.allowlist_transition, 'unchanged')
  assert.equal(checked.manifest_transition, 'unchanged')
})
