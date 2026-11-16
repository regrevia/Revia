import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = new URL('../', import.meta.url)
export const BUILDER = new URL('scripts/build-source-import-manifest.js', repository)
export const SELECTION = new URL('scripts/source-import-selection.mjs', repository)

// The selection resolves the published paths from its own source, so the test
// reads the same list rather than keeping a second copy that could fall behind
// when a file is added to the publication set.
export async function publishedPaths() {
  const source = await readFile(SELECTION, 'utf8')
  const block = /const EXPLICIT_PATHS = \[([\s\S]*?)\n\]/u.exec(source)
  assert.ok(block, 'the selection no longer declares EXPLICIT_PATHS')
  const paths = [...block[1].matchAll(/'([^']+)'/gu)].map((match) => match[1])
  assert.ok(paths.length > 50, `read only ${paths.length} published paths`)
  return paths
}

// The explicit paths are published whether they are files or directories, and
// the kind the path has is what the list means, so the fixture has to reproduce
// the kind the repository has. Writing the declared directory as a file made
// every healthy root look like a tree whose directory had been replaced, which
// is one of the counterexamples the gate now refuses.
export async function publishedDirectories() {
  const directories = new Set()
  for (const path of await publishedPaths()) {
    const stat = await lstat(fileURLToPath(new URL(path, repository))).catch(() => null)
    if (stat?.isDirectory()) directories.add(path)
  }
  return directories
}

// What a refresh publishes for this tree: a declared directory is published by
// walking it rather than by listing it, so it stands for the file the fixture
// puts inside it.
export async function publishedSelection() {
  const directories = await publishedDirectories()
  const selection = []
  for (const path of await publishedPaths()) {
    selection.push(directories.has(path) ? `${path}/published.md` : path)
  }
  return selection
}

export function stub(path) {
  if (path === 'package.json') return `${JSON.stringify({ type: 'module' })}\n`
  return path.endsWith('.json') ? '{}\n' : 'published\n'
}

// Every mode walks the source roots and every mode resolves the selection, so
// a fixture that wants to exercise any one fault has to hold the rest of the
// published tree: a root without one reports the missing path instead.
export async function populatePublished(root, missing) {
  for (const directory of ['doc', 'native', 'src', 'test', 'test-support']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  const directories = await publishedDirectories()
  for (const path of await publishedPaths()) {
    if (path === missing) continue
    // The selection and the builder are the copies the fixture runs; a stub
    // written over either would replace the code under test.
    if (path === 'scripts/build-source-import-manifest.js') continue
    if (path === 'scripts/source-import-selection.mjs') continue
    // A declared directory is published by walking it, so it needs the
    // directory and something inside for the walk to find.
    if (directories.has(path)) {
      await mkdir(join(root, path), { recursive: true })
      await writeFile(join(root, path, 'published.md'), stub(path))
      continue
    }
    await mkdir(dirname(join(root, path)), { recursive: true })
    // `package.json` decides how Node reads the copy, so the stub has to stay
    // JSON and keep the module type the shipped script is written in.
    await writeFile(join(root, path), stub(path))
  }
}

export async function temporaryRoot(missing) {
  const root = await mkdtemp(join(tmpdir(), 'revia-explicit-path-missing-'))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await copyFile(BUILDER, join(root, 'scripts/build-source-import-manifest.js'))
  await copyFile(SELECTION, join(root, 'scripts/source-import-selection.mjs'))
  await writeFile(
    join(root, 'SOURCE_IMPORT_FILES.json'),
    `${JSON.stringify({ files: [], schema: 'revia.source-import-allowlist@1.0.0' })}\n`,
  )
  await populatePublished(root, missing)
  return root
}

export function run(root, mode = '--refresh') {
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

// A published path that is not in the tree is a different repair from a file
// the admission list forgot: the first means the tree lost a file the build
// must publish, the second means the list is stale. Both used to report the
// unnamed `source-import-failed`, which names neither.
