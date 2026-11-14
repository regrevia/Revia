import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

export function stub(path) {
  if (path === 'package.json') return `${JSON.stringify({ type: 'module' })}\n`
  return path.endsWith('.json') ? '{}\n' : 'published\n'
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
  for (const directory of ['doc', 'native', 'src', 'test', 'test-support']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  for (const path of await publishedPaths()) {
    if (path === missing) continue
    // The selection and the builder are the copies the fixture runs; a stub
    // written over either would replace the code under test.
    if (path === 'scripts/build-source-import-manifest.js') continue
    if (path === 'scripts/source-import-selection.mjs') continue
    await mkdir(dirname(join(root, path)), { recursive: true })
    // `package.json` decides how Node reads the copy, so the stub has to stay
    // JSON and keep the module type the shipped script is written in.
    await writeFile(join(root, path), stub(path))
  }
  return root
}

export function run(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts/build-source-import-manifest.js'), '--refresh'],
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
