import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot } from '../test-support/source-import-fixture.js'

const repository = new URL('../', import.meta.url)

// Only the mode that rewrites the list walks a root, so a pipe standing in one
// is invisible to the two modes that read: the same tree was called clean by
// `--check` and `--write` and refused by `--refresh`. The fault is not a wrong
// name but two answers for one tree, so every mode is asked here.
const canMakePipe = process.platform !== 'win32'

// A pipe opens and never answers, so the child is bounded: the case has to fail
// rather than hang when the refusal is wrong.
function bounded(root, mode, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'build-source-import-manifest.js'), mode], {
      cwd: root,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, ms)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve(killed
        ? { status: null, stdout, stderr: 'blocked' }
        : { status, stdout, stderr })
    })
  })
}

function modeRun(root, mode, ms = 8000) {
  return canMakePipe ? bounded(root, mode, ms) : bounded(root, mode, ms)
}

async function healthy(root) {
  const result = await modeRun(root, '--refresh')
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(await readFile(join(root, 'SOURCE_IMPORT_FILES.json'), 'utf8'))
}

function entryLines(text) {
  return text.split('\n').filter((line) => line.startsWith('    "'))
}

test('a pipe inside a walked root is named by every mode, not just the one that walks', { skip: !canMakePipe }, async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await healthy(root)
  const pipe = join(root, 'src/FIFO_PROBE')
  await unlink(pipe).catch(() => {})
  execFileSync('mkfifo', [pipe])

  for (const mode of ['--check', '--write', '--refresh']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 1, `${mode} accepted a pipe in a walked root`)
    assert.equal(result.stderr, 'source-import-entry-invalid\n', mode)
    assert.equal(result.stdout, '', `${mode} described a tree it could not walk`)
  }
})

test('a pipe removed from a walked root leaves the tree refreshable again', { skip: !canMakePipe }, async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await healthy(root)
  const pipe = join(root, 'src/FIFO_PROBE')
  await unlink(pipe).catch(() => {})
  execFileSync('mkfifo', [pipe])
  await unlink(pipe)

  for (const mode of ['--check', '--write']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
  }
})

test('a list in the wrong order is refused by the reading modes and repaired by the mode that writes it', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await healthy(root)
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  const rendered = await readFile(allowlist, 'utf8')
  const entries = entryLines(rendered)
  assert.ok(entries.length > 2, `read only ${entries.length} entries`)
  // The order is the one thing a reader refuses and a writer fixes, so the same
  // list is put in front of both without touching what it publishes.
  await writeFile(allowlist, rendered.replace(`${entries[0]}\n${entries[1]}`, `${entries[1]}\n${entries[0]}`))

  for (const mode of ['--check', '--write']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 1, `${mode} accepted a list out of order`)
    assert.equal(result.stderr, 'source-import-allowlist-order-invalid\n', mode)
    assert.equal(result.stdout, '', mode)
  }

  const refreshed = await modeRun(root, '--refresh')
  assert.equal(refreshed.status, 0, refreshed.stderr)
  const receipt = JSON.parse(refreshed.stdout)
  // A repair of the order publishes the same files as before, and calling it
  // `replaced` described it exactly like any other rewrite.
  assert.equal(receipt.allowlist_transition, 'reordered')

  const checked = await modeRun(root, '--check')
  assert.equal(checked.status, 0, checked.stderr)
})

test('a list that publishes something else is still replaced, not reordered', async () => {
  const root = await temporaryRoot('nothing-is-missing')
  await healthy(root)
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  const rendered = await readFile(allowlist, 'utf8')
  const entries = entryLines(rendered)
  // Dropping an entry keeps the order and changes what the list publishes,
  // which is the state `replaced` describes; a middle one keeps the commas.
  const dropped = entries[1]
  const shortened = rendered.replace(`${dropped}\n`, '')
  await writeFile(allowlist, shortened)
  assert.deepEqual(entryLines(shortened), entries.filter((line) => line !== dropped))

  const refreshed = await modeRun(root, '--refresh')
  assert.equal(refreshed.status, 0, refreshed.stderr)
  assert.equal(JSON.parse(refreshed.stdout).allowlist_transition, 'replaced')
})

test('--refresh publishes the files the walk it already ran named', async () => {
  // The walk is what refuses a pipe, so the mode that repairs must publish from
  // the same walk rather than reading the roots a second time: two walks could
  // disagree about a tree that changed between them, and the receipts would
  // then describe a tree neither of them saw. The claim is a property of the
  // source, so it is read the way the layout test reads the renderer's name.
  const source = await readFile(
    new URL('scripts/build-source-import-manifest.js', repository),
    'utf8',
  )
  const walks = [...source.matchAll(/selectFiles\(ROOT\)/gu)]
  assert.equal(
    walks.length,
    1,
    `the gate walks the source roots ${walks.length} times`,
  )
  const refresh = source.indexOf("if (mode === '--refresh')")
  assert.ok(refresh > 0, 'the writer branch is gone')
  assert.ok(
    source.indexOf('renderAllowlist(files)') > refresh,
    'the writer must render the files the walk named, not a second walk',
  )
})

test('the contributor guide names the walk and the word it now reports', async () => {
  const guide = await readFile(new URL('AGENTS.md', repository), 'utf8')
  // A refusal no guide mentions is a refusal nobody can act on, and a
  // vocabulary that grows without a place to read it is a dialect per mode.
  assert.match(
    guide,
    /Every mode walks the source roots, not only the one that writes the list/u,
    'the guide must say which modes walk the roots',
  )
  assert.match(guide, /`source-import-entry-invalid`/u)
  assert.match(guide, /`--refresh` names it `reordered`/u)
  assert.match(guide, /`created`, `replaced`\s+or `unchanged`, in one vocabulary/u)
})
