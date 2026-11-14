import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const repository = new URL('../', import.meta.url)
const BUILDER = new URL('scripts/build-source-import-manifest.js', repository)
const SELECTION = new URL('scripts/source-import-selection.mjs', repository)
const MARK = Buffer.from([0xef, 0xbb, 0xbf])
const CLEAN = `${JSON.stringify({
  files: ['note.txt'],
  schema: 'revia.source-import-allowlist@1.0.0',
})}\n`

// The builder resolves its root from its own location, so a byte-for-byte copy
// under a temporary root lets the shipped script run against fixtures without
// touching the repository's own allowlist or manifest.
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'revia-source-import-mark-'))
  await mkdir(join(root, 'scripts'))
  await copyFile(BUILDER, join(root, 'scripts/build-source-import-manifest.js'))
  await copyFile(SELECTION, join(root, 'scripts/source-import-selection.mjs'))
  await writeFile(join(root, 'note.txt'), 'hello\n')
  await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), CLEAN)
  return root
}

function run(root, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts/build-source-import-manifest.js'), mode],
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

async function marked(path) {
  const bytes = await readFile(path)
  return Buffer.concat([MARK, bytes])
}

test('the gate names a byte-order mark instead of the unnamed failure', async () => {
  const root = await temporaryRoot()
  const written = await run(root, '--write')
  assert.equal(written.status, 0, written.stderr)
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  const clean = await readFile(allowlist)
  await writeFile(allowlist, Buffer.concat([MARK, clean]))

  const checked = await run(root, '--check')
  assert.equal(checked.status, 1)
  assert.equal(checked.stderr, 'byte-order-mark-not-allowed\n')
  // The file is well-formed JSON with three bytes in front, so the parse is not
  // what refused it; naming the mark is the whole claim.
  assert.doesNotThrow(() => JSON.parse(clean.toString('utf8')))
  assert.equal(clean.subarray(0, 3).equals(MARK), false)

  const written2 = await run(root, '--write')
  assert.equal(written2.status, 1)
  assert.equal(written2.stderr, 'byte-order-mark-not-allowed\n')
})

test('--refresh refuses the same mark instead of rewriting the file', async () => {
  const root = await temporaryRoot()
  assert.equal((await run(root, '--write')).status, 0)
  const allowlist = join(root, 'SOURCE_IMPORT_FILES.json')
  const markedBytes = Buffer.concat([MARK, await readFile(allowlist)])
  await writeFile(allowlist, markedBytes)

  const refreshed = await run(root, '--refresh')
  assert.equal(refreshed.status, 1)
  assert.equal(refreshed.stderr, 'byte-order-mark-not-allowed\n')
  // A refresh that erased the mark would make --check and --refresh disagree
  // about whether the same bytes are acceptable.
  assert.deepEqual(await readFile(allowlist), markedBytes)
})

test('a mark on the manifest is named, not reported as drift', async () => {
  const root = await temporaryRoot()
  assert.equal((await run(root, '--write')).status, 0)
  const manifest = join(root, 'SOURCE_IMPORT_MANIFEST.json')
  await writeFile(manifest, await marked(manifest))

  const checked = await run(root, '--check')
  assert.equal(checked.status, 1)
  assert.equal(checked.stderr, 'byte-order-mark-not-allowed\n')
})

test('drift and malformed input keep their own names', async () => {
  const root = await temporaryRoot()
  assert.equal((await run(root, '--write')).status, 0)
  const manifest = join(root, 'SOURCE_IMPORT_MANIFEST.json')
  await writeFile(manifest, '{"files":[],"license":"MPL-2.0","schema":"revia.source-import@1.0.0"}\n')
  const drifted = await run(root, '--check')
  assert.equal(drifted.status, 1)
  assert.equal(drifted.stderr, 'source-import-manifest-drift\n')

  await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), '{"files":[\n')
  const malformed = await run(root, '--check')
  assert.equal(malformed.status, 1)
  // The mark branch must not swallow every syntax error in the file.
  assert.equal(malformed.stderr, 'source-import-failed\n')
})

test('the contributor guide names the refusal and all three modes', async () => {
  const guide = await readFile(new URL('AGENTS.md', repository), 'utf8')
  // A code nobody documents is a code nobody can act on: the guide has to say
  // which modes report it and what to do instead of stripping the bytes.
  assert.match(guide, /`byte-order-mark-not-allowed`/u)
  assert.match(
    guide,
    /`--check`, `--write` and `--refresh` alike/u,
    'the guide must not narrow the refusal to one mode',
  )
  assert.match(guide, /restore the file from Git/u)
})

test('the repository\'s own allowlist and manifest carry no mark', async () => {
  for (const name of ['SOURCE_IMPORT_FILES.json', 'SOURCE_IMPORT_MANIFEST.json']) {
    const bytes = await readFile(new URL(name, repository))
    assert.equal(
      bytes.subarray(0, MARK.length).equals(MARK),
      false,
      `${name} opens with a byte-order mark`,
    )
  }
})
