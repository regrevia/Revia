// A refresh writes two files, and when the second one cannot be written the
// first must not be: the mode refused, so nothing it computed may have landed.
// The list was written before the manifest was even asked about, so a manifest
// that cannot take the bytes left the list repaired and the tree inconsistent —
// the operator told the repair failed while half of it had happened, and the
// next `--check` reading a list the mode said it did not write.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { publishedSelection, temporaryRoot } from '../test-support/source-import-fixture.js'

function attempted(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts/build-source-import-manifest.js'), ...args],
      { cwd: root },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

const WAIT = new Promise((resolve) => setTimeout(resolve, 25))

async function settledRoot() {
  const root = await temporaryRoot('nothing-is-missing')
  const first = await attempted(root, ['--refresh'])
  assert.equal(first.status, 0, first.stderr)
  return {
    root,
    list: join(root, 'SOURCE_IMPORT_FILES.json'),
    manifest: join(root, 'SOURCE_IMPORT_MANIFEST.json'),
  }
}

// Two writes have to be pending at once, which is what a torn write needs: the
// list names the same files in another order, so the list needs a repair, and
// the manifest holds bytes that describe something else, so the manifest needs
// one too. The repair the mode cannot land is the later one, and the repair it
// must not land first is the earlier one.
async function reordered(list) {
  const lines = (await readFile(list, 'utf8')).trimEnd().split('\n')
  const swapped = [lines[0], lines[1], lines[3], lines[2], ...lines.slice(4)]
  await writeFile(list, `${swapped.join('\n')}\n`)
  return readFile(list, 'utf8')
}

async function bothWritesPending(root) {
  const list = join(root, 'SOURCE_IMPORT_FILES.json')
  const manifest = join(root, 'SOURCE_IMPORT_MANIFEST.json')
  const swapped = await reordered(list)
  // A manifest that describes a tree this one is not: `--refresh` has to
  // replace it, and the list has to be repaired in the same run.
  await writeFile(manifest, `${JSON.stringify({ files: [], schema: 'stale' })}\n`)
  return { list, manifest, swapped }
}

test('a refresh that cannot land the manifest does not repair the list first', async () => {
  const { root } = await settledRoot()
  const { list, manifest, swapped } = await bothWritesPending(root)
  await WAIT
  const listBefore = await stat(list)
  const manifestBefore = await stat(manifest)
  await chmod(manifest, 0o444)
  try {
    const result = await attempted(root, ['--refresh'])

    assert.equal(result.status, 1)
    assert.equal(result.stderr, 'source-import-manifest-unwritable\n')
    // The refusal is about the write that could not land, and the transition
    // it carries is the decision the mode reached: the list needed repairing
    // whether or not the bytes were allowed to land.
    assert.deepEqual(JSON.parse(result.stdout), {
      allowlist_transition: 'reordered',
      reason: 'source-import-manifest-unwritable',
      schema: 'revia.source-import-refusal@1.0.0',
    })
    // A mode that exits non-zero has published nothing: the order it would
    // have written is still in the file it read, untouched, so the next
    // `--check` sees the same tree this one refused.
    assert.equal(
      await readFile(list, 'utf8'),
      swapped,
      'a refused refresh must not have written the list it read',
    )
    const listAfter = await stat(list)
    assert.equal(
      listAfter.mtimeMs,
      listBefore.mtimeMs,
      'the list was written even though the refresh refused',
    )
    const manifestAfter = await stat(manifest)
    assert.equal(
      manifestAfter.mtimeMs,
      manifestBefore.mtimeMs,
      'the manifest that refused the write must be the one left behind',
    )
  } finally {
    await chmod(manifest, 0o644)
  }
})

// The same tree, once the manifest can take the bytes: both writes land and the
// order that was refused above is the order this mode actually publishes. The
// pair is what makes the first case a refusal rather than a limit of the
// fixture.
test('the same refresh lands both writes when the manifest is writable', async () => {
  const { root } = await settledRoot()
  const { list, manifest } = await bothWritesPending(root)
  const result = await attempted(root, ['--refresh'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).allowlist_transition, 'reordered')
  assert.equal(JSON.parse(result.stdout).manifest_transition, 'replaced')
  // The receipt describes a tree that moved, so this is the case that has to
  // show both repairs landing rather than one of them.
  // The count is the tree's, not the fixture's: the two repairs have to
  // publish every path the selection names, and a number written here would
  // call the publication short the day a path was added to it.
  const expected = (await publishedSelection()).length
  assert.equal(JSON.parse(await readFile(list, 'utf8')).files.length, expected)
  const published = JSON.parse(await readFile(manifest, 'utf8'))
  assert.equal(published.files.length, expected)
})

// A refresh with nothing to repair leaves the list alone, so ordering the two
// writes in front of a manifest it will not touch must not have made the list
// depend on the manifest at all -- the case that must stay a success.
test('a refresh with nothing to repair still succeeds against a read-only manifest', async () => {
  const { root, list, manifest } = await settledRoot()
  const before = await stat(list)
  await chmod(manifest, 0o444)
  try {
    const result = await attempted(root, ['--refresh'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).allowlist_transition, 'unchanged')
    assert.equal(JSON.parse(result.stdout).manifest_transition, 'unchanged')
    assert.equal((await stat(list)).mtimeMs, before.mtimeMs)
  } finally {
    await chmod(manifest, 0o644)
  }
})

// The guide has to name the ordering, because an operator who reads only the
// refusal would run the same command again and get the same half-written tree.
test('the guide states that neither write lands unless both can', async () => {
  const { readFile: read } = await import('node:fs/promises')
  const guide = await read(new URL('../AGENTS.md', import.meta.url), 'utf8')
  const clause = guide.split('\n').join(' ').replace(/\s+/gu, ' ')
  assert.match(clause, /writes neither unless both can take the bytes/u)
  assert.match(clause, /the list it would have written is still the list it read/u)
})
