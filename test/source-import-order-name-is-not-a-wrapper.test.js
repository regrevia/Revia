import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot } from '../test-support/source-import-fixture.js'

// The fixture's `run` takes a mode string only, and these cases need the
// builder inside the fixture root rather than the repository's copy.
function attempted(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'scripts/build-source-import-manifest.js'), ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function received(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// A root with one --refresh behind it, so the list is the order the tree
// publishes and every case below starts from a correct list.
async function settledRoot(label) {
  const root = await temporaryRoot(label)
  received(await attempted(root, ['--refresh']))
  return { root, list: join(root, 'SOURCE_IMPORT_FILES.json') }
}

test('a list that only lost its final newline was not reordered', async () => {
  const { root, list } = await settledRoot('wrapper-only-newline')
  const correct = await readFile(list, 'utf8')
  await writeFile(list, correct.replace(/\n$/u, ''))

  const receipt = received(await attempted(root, ['--refresh']))
  assert.equal(
    receipt.allowlist_transition,
    'replaced',
    'no path changed order, so the order was found correct rather than repaired',
  )
  assert.equal(await readFile(list, 'utf8'), correct, 'the repair still restores the bytes')
})

test('a list that only changed indentation was not reordered', async () => {
  const { root, list } = await settledRoot('wrapper-only-indent')
  const correct = await readFile(list, 'utf8')
  await writeFile(list, `${JSON.stringify(JSON.parse(correct), null, 4)}\n`)

  const receipt = received(await attempted(root, ['--refresh']))
  assert.equal(receipt.allowlist_transition, 'replaced')
  assert.equal(await readFile(list, 'utf8'), correct)
})

test('a list that really swapped two paths is still reordered', async () => {
  const { root, list } = await settledRoot('order-really-changed')
  const parsed = JSON.parse(await readFile(list, 'utf8'))
  const files = [parsed.files[1], parsed.files[0], ...parsed.files.slice(2)]
  await writeFile(list, `${JSON.stringify({ ...parsed, files }, null, 2)}\n`)

  const receipt = received(await attempted(root, ['--refresh']))
  assert.equal(
    receipt.allowlist_transition,
    'reordered',
    'a repair that put the order back must keep saying so',
  )
  const repaired = JSON.parse(await readFile(list, 'utf8'))
  assert.deepEqual(repaired.files.slice(0, 2), [parsed.files[0], parsed.files[1]])
})

test('a written list is no longer reported as reordered', async () => {
  const { root, list } = await settledRoot('reordered-then-settles')
  const parsed = JSON.parse(await readFile(list, 'utf8'))
  const files = [parsed.files[1], parsed.files[0], ...parsed.files.slice(2)]
  await writeFile(list, `${JSON.stringify({ ...parsed, files }, null, 2)}\n`)
  received(await attempted(root, ['--refresh']))

  const settled = await stat(list)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const receipt = received(await attempted(root, ['--refresh']))
  assert.equal(
    receipt.allowlist_transition,
    'unchanged',
    'the repair landed, so the next refresh finds nothing to do',
  )
  assert.equal((await stat(list)).mtimeMs, settled.mtimeMs, 'and it does not write again')
  await chmod(list, 0o644)
})

test('the guide says which repair is the order and which is the shape', async () => {
  const guide = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8')
  assert.match(
    guide,
    /reformatted\s+without\s+moving\s+a\s+path/u,
    'the guide must name the wrapper-only repair and keep it out of `reordered`',
  )
})
