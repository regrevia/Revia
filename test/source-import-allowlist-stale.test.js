// The two modes that only read built the manifest from the allowlist and never
// looked at the set they had just walked, so a source file that landed under a
// walked root without being listed was invisible to both: `--check` reported a
// clean tree and `--write` left the manifest short of the file the refresh
// would publish. The walk was already there for the object check, so the
// published set and the named set can be compared without a second walk.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot } from '../test-support/source-import-fixture.js'

const ROOT = new URL('../', import.meta.url)
const UNLISTED = 'src/unlisted-module.js'

function modeRun(root, mode, milliseconds = 20000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts', 'build-source-import-manifest.js'), mode],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), milliseconds)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, out, stderr: err })
    })
  })
}

async function published(label) {
  const root = await temporaryRoot(label)
  const opened = await modeRun(root, '--refresh')
  assert.equal(opened.status, 0, opened.stderr)
  return root
}

test('--check refuses a tree the list has gone stale about', async () => {
  const root = await published('unlisted-source')
  await writeFile(join(root, UNLISTED), 'export const answer = 42\n')
  const checked = await modeRun(root, '--check')
  assert.equal(checked.status, 1)
  assert.equal(checked.stderr, 'source-import-allowlist-stale\n')
  assert.equal(checked.out, '')
  // Only the mode that reports on the tree refuses: writing the manifest for
  // the list it read is what `--write` is for, and `--refresh` is the repair.
  const written = await modeRun(root, '--write')
  assert.equal(written.status, 0, written.stderr)
})

test('the refresh repairs the list and the next check is clean', async () => {
  const root = await published('unlisted-repair')
  const before = JSON.parse(await readFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'utf8'))
  await writeFile(join(root, UNLISTED), 'export const answer = 42\n')
  const repaired = await modeRun(root, '--refresh')
  assert.equal(repaired.status, 0, repaired.stderr)
  const receipt = JSON.parse(repaired.out)
  assert.equal(receipt.allowlist_transition, 'replaced')
  assert.equal(receipt.file_count, before.files.length + 1)
  const after = JSON.parse(await readFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'utf8'))
  assert.equal(after.files.includes(UNLISTED), true)
  const clean = await modeRun(root, '--check')
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(JSON.parse(clean.out).allowlist_transition, 'unchanged')
})

test('a listed path the tree lost keeps its own name', async () => {
  const root = await published('lost-listed')
  await writeFile(join(root, UNLISTED), 'export const answer = 42\n')
  assert.equal((await modeRun(root, '--refresh')).status, 0)
  const { rm } = await import('node:fs/promises')
  await rm(join(root, UNLISTED))
  for (const mode of ['--check', '--write']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 1, mode)
    // The list is stale about nothing here: the file the tree lost is what has
    // to come back, so the stale name must not cover a missing one.
    assert.equal(result.stderr, 'source-import-file-missing\n', mode)
  }
})

test('the guide says a list missing a walked path is stale', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.match(
    guide,
    /source-import-allowlist-stale[\s\S]{0,400}?--refresh/u,
  )
  assert.match(guide, /source-import-file-missing/u)
})
