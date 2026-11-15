import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { temporaryRoot } from '../test-support/source-import-fixture.js'

// `mkfifo` is the shortest way to a path that opens for reading and never
// answers. Windows has no such file type, so the case below is skipped there
// rather than proved on a platform the release does not gate this way.
const canMakePipe = process.platform !== 'win32'

// The whole point is that the gate answers, so every call here is bounded and
// the child is killed when it does not: an unbounded one would hang the suite
// instead of failing it, and a hang is exactly the fault being fixed.
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

async function pipeAt(root, name) {
  const path = join(root, name)
  await unlink(path).catch(() => {})
  execFileSync('mkfifo', [path])
  return path
}

// Every mode that touches these two paths opens them. A pipe opens and then
// holds the reader forever, so the fault is not a wrong answer but no answer:
// the gate stops without writing anything, and nothing tells the operator what
// to remove.
test('a pipe where the manifest belongs is refused instead of blocking', { skip: !canMakePipe }, async () => {
  const root = await temporaryRoot('m')
  // Let the gate build both files once, so the list is by construction one it
  // accepts; the pipe is then the only thing wrong with this tree.
  assert.equal((await bounded(root, '--refresh')).status, 0)
  await pipeAt(root, 'SOURCE_IMPORT_MANIFEST.json')
  const result = await bounded(root, '--check')
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-manifest-invalid-kind\n')
  assert.equal(result.stdout, '')
})

test('a pipe where the allowlist belongs is refused instead of blocking', { skip: !canMakePipe }, async () => {
  const root = await temporaryRoot('m')
  await pipeAt(root, 'SOURCE_IMPORT_FILES.json')
  const result = await bounded(root, '--check')
  assert.equal(result.status, 1)
  assert.equal(result.stderr, 'source-import-allowlist-invalid-kind\n')
  assert.equal(result.stdout, '')
})

test('a healthy tree still refreshes with both files in place', { skip: !canMakePipe }, async () => {
  const root = await temporaryRoot('m')
  const result = await bounded(root, '--refresh')
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const manifest = JSON.parse(await readFile(join(root, 'SOURCE_IMPORT_MANIFEST.json'), 'utf8'))
  assert.ok(manifest.files.length > 0)
})
