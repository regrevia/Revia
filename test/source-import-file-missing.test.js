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

function allowlist(files) {
  return `${JSON.stringify({ files, schema: 'revia.source-import-allowlist@1.0.0' })}\n`
}

// The builder resolves its root from its own location, so a byte-for-byte copy
// under a temporary root lets the shipped script run against fixtures without
// touching the repository's own allowlist or manifest.
async function temporaryRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'revia-source-import-missing-'))
  await mkdir(join(root, 'scripts'))
  await copyFile(BUILDER, join(root, 'scripts/build-source-import-manifest.js'))
  await copyFile(SELECTION, join(root, 'scripts/source-import-selection.mjs'))
  await writeFile(join(root, 'note.txt'), 'hello\n')
  await writeFile(join(root, 'SOURCE_IMPORT_FILES.json'), allowlist(files))
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

test('a listed path that is absent is named instead of the unnamed failure', async () => {
  const root = await temporaryRoot(['gone.txt', 'note.txt'])
  for (const mode of ['--check', '--write']) {
    const result = await run(root, mode)
    assert.equal(result.status, 1, `${mode} accepted a missing listed path`)
    assert.equal(result.stderr, 'source-import-file-missing\n', mode)
    assert.equal(result.stdout, '', `${mode} wrote a result it did not compute`)
  }
})

test('a listed path that is a directory keeps its own name', async () => {
  const root = await temporaryRoot(['nested', 'note.txt'])
  await mkdir(join(root, 'nested'))
  const checked = await run(root, '--check')
  assert.equal(checked.status, 1)
  // A directory exists, so it is a different defect from an absent one.
  assert.equal(checked.stderr, 'source-import-file-invalid\n')
})

test('a listed path that is a symbolic link keeps its own name', async () => {
  const root = await temporaryRoot(['alias.txt', 'note.txt'])
  const { symlink } = await import('node:fs/promises')
  await symlink(join(root, 'note.txt'), join(root, 'alias.txt'))
  const checked = await run(root, '--check')
  assert.equal(checked.status, 1)
  assert.equal(checked.stderr, 'source-import-file-invalid\n')
})

test('a manifest that disagrees with the files is still drift', async () => {
  const root = await temporaryRoot(['note.txt'])
  assert.equal((await run(root, '--write')).status, 0)
  const manifest = join(root, 'SOURCE_IMPORT_MANIFEST.json')
  await writeFile(manifest, await readFile(manifest, 'utf8'))
  await writeFile(join(root, 'note.txt'), 'changed\n')
  const checked = await run(root, '--check')
  assert.equal(checked.status, 1)
  assert.equal(checked.stderr, 'source-import-manifest-drift\n')
})

test('the contributor guide names the absent-path refusal', async () => {
  const guide = await readFile(new URL('AGENTS.md', repository), 'utf8')
  // The gate now has a name for "the path you listed is not there"; a code
  // nobody documents is a code nobody can act on.
  assert.match(guide, /`source-import-file-missing`/u)
  assert.match(
    guide,
    /a path listed in the allowlist that is not in the tree/u,
    'the guide must say what the code means, not only that it exists',
  )
  assert.match(guide, /`source-import-file-invalid`/u)
})
