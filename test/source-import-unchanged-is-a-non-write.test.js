// `unchanged` has to mean the same thing on both files the gate writes: this
// mode did not write it. The manifest side already guards its write, so a
// correct read-only manifest succeeds. The allowlist side computed the same
// transition and then wrote anyway, so the receipt said "nothing changed"
// about a file it had just rewritten — and on a read-only tree the same word
// turned into a refusal about a list that needed no repair.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { temporaryRoot } from '../test-support/source-import-fixture.js'

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
  return { root, list: join(root, 'SOURCE_IMPORT_FILES.json') }
}

test('a refresh with nothing to repair does not touch the list', async () => {
  const { root, list } = await settledRoot()
  const before = await stat(list)
  await WAIT
  const again = await attempted(root, ['--refresh'])
  assert.equal(again.status, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).allowlist_transition, 'unchanged')
  const after = await stat(list)
  assert.equal(
    after.mtimeMs,
    before.mtimeMs,
    'unchanged must describe a file this mode declined to write',
  )
})

test('a correct but read-only list does not turn a refresh into a refusal', async () => {
  const { root, list } = await settledRoot()
  await chmod(list, 0o444)
  try {
    const result = await attempted(root, ['--refresh'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).allowlist_transition, 'unchanged')
  } finally {
    await chmod(list, 0o644)
  }
})

test('a list that needs repair still names the write it cannot do', async () => {
  const { root, list } = await settledRoot()
  const lines = (await readFile(list, 'utf8')).trimEnd().split('\n')
  await writeFile(list, `${lines.slice(1).join('\n')}\n`)
  await chmod(list, 0o444)
  try {
    const result = await attempted(root, ['--refresh'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'source-import-allowlist-unwritable\n')
  } finally {
    await chmod(list, 0o644)
  }
})

test('the guide gives the word one meaning on both files', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.match(
    guide,
    /The list is left alone the same way/u,
    'the guide must say the list is not written when it is already correct',
  )
  assert.match(
    guide,
    /still writes, because it/u,
    'the guide must keep `reordered` a write',
  )
})

test('a reordered list is still written', async () => {
  const { root, list } = await settledRoot()
  const original = await readFile(list, 'utf8')
  const parsed = JSON.parse(original)
  const swapped = [parsed.files[1], parsed.files[0], ...parsed.files.slice(2)]
  await writeFile(list, original.replace(
    `"${parsed.files[0]}"`,
    `"${swapped[0]}"`,
  ))
  // The two entries changed places without the file gaining or losing one, so
  // the only repair this mode can make is the order it must actually write.
  await writeFile(list, original
    .replace(`"${parsed.files[0]}"`, '\u0000a')
    .replace(`"${parsed.files[1]}"`, `"${parsed.files[0]}"`)
    .replace('\u0000a', `"${parsed.files[1]}"`))
  const result = await attempted(root, ['--refresh'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).allowlist_transition, 'reordered')
  assert.equal(
    await readFile(list, 'utf8'),
    original,
    'reordered is a write, so the order it repaired must land',
  )
})
