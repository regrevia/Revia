import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot } from '../test-support/source-import-fixture.js'

// A list can name the same path twice in perfect sorted order. Nothing about
// that file's order is wrong, so refusing it as `order-invalid` sent the
// operator to look at the ordering while the fault was in the list's shape,
// which is the name that already describes a list the schema cannot read.
const ROOT = new URL('../', import.meta.url)

function modeRun(root, mode, ms = 20000) {
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
      resolve(killed ? { status: null, stdout, stderr: 'blocked' } : { status, stdout, stderr })
    })
  })
}

async function settledRoot(label) {
  const root = await temporaryRoot(label)
  const list = join(root, 'SOURCE_IMPORT_FILES.json')
  const first = await modeRun(root, '--refresh')
  assert.equal(first.status, 0, first.stderr)
  return { root, list }
}

test('a sorted list that repeats a path is a shape fault, not an order fault', async () => {
  const { root, list } = await settledRoot('duplicate-shape')
  const correct = JSON.parse(await readFile(list, 'utf8'))
  const repeated = { ...correct, files: [...correct.files] }
  repeated.files.splice(1, 0, correct.files[0])
  repeated.files.sort()
  // The order is the rendered one; only the membership repeats.
  assert.deepEqual([...repeated.files].sort(), repeated.files)
  await writeFile(list, `${JSON.stringify(repeated, null, 2)}\n`)

  for (const mode of ['--check', '--write']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 1, `${mode} accepted a list naming a path twice`)
    assert.equal(result.stderr, 'source-import-allowlist-invalid\n', mode)
    assert.equal(result.stdout, '', mode)
  }
})

test('a list that is only out of order still reports the order', async () => {
  const { root, list } = await settledRoot('order-still-order')
  const correct = JSON.parse(await readFile(list, 'utf8'))
  const swapped = { ...correct, files: [correct.files[1], correct.files[0], ...correct.files.slice(2)] }
  await writeFile(list, `${JSON.stringify(swapped, null, 2)}\n`)

  for (const mode of ['--check', '--write']) {
    const result = await modeRun(root, mode)
    assert.equal(result.status, 1, `${mode} accepted a list out of order`)
    assert.equal(result.stderr, 'source-import-allowlist-order-invalid\n', mode)
  }
})

test('the refresh still repairs a list that names a path twice', async () => {
  const { root, list } = await settledRoot('duplicate-repair')
  const correct = JSON.parse(await readFile(list, 'utf8'))
  const repeated = { ...correct, files: [...correct.files] }
  repeated.files.splice(1, 0, correct.files[0])
  repeated.files.sort()
  await writeFile(list, `${JSON.stringify(repeated, null, 2)}\n`)

  const refreshed = await modeRun(root, '--refresh')
  assert.equal(refreshed.status, 0, refreshed.stderr)
  const receipt = JSON.parse(refreshed.stdout)
  assert.equal(receipt.file_count, correct.files.length)
  const repaired = JSON.parse(await readFile(list, 'utf8'))
  assert.equal(repaired.files.length, correct.files.length)
  assert.equal(new Set(repaired.files).size, repaired.files.length)
})

test('the guide says which fault a repeated path is', async () => {
  const guide = await readFile(new URL('AGENTS.md', ROOT), 'utf8')
  assert.match(
    guide,
    /source-import-allowlist-invalid`[\s\S]{0,120}?names the same path twice is that\s+shape fault/u,
    'the guide does not say that a repeated path is a shape fault',
  )
})
