import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli/re.js', import.meta.url))
const source = await readFile(
  new URL('../examples/hello.re', import.meta.url),
  'utf8',
)

function runCli(...arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

test('fresh compact builds are byte-identical across processes and directories', async (context) => {
  const first = await createOutputRoot('first')
  const second = await createOutputRoot('second')
  context.after(() => Promise.all([
    rm(first, { force: true, recursive: true }),
    rm(second, { force: true, recursive: true }),
  ]))

  const firstRun = await buildFreshOutput(first)
  const secondRun = await buildFreshOutput(second)

  assert.deepEqual(firstRun.manifest.manifest, secondRun.manifest.manifest)
  assert.deepEqual(firstRun.views, secondRun.views)
  assert.equal(firstRun.canonical, secondRun.canonical)
  assert.deepEqual(firstRun.tree, secondRun.tree)

  const releaseLock = JSON.parse(firstRun.tree['release-lock.json'])
  assert.deepEqual(releaseLock.identity_allocator, {
    algorithm: 're.deterministic-uid-sequence@0.1.0',
    schema: 're.identity-allocator@0.1.0',
  })
})

async function createOutputRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `re-${label}-`))
  await writeFile(join(root, 'hello.re'), source, 'utf8')
  return root
}

async function buildFreshOutput(root) {
  const file = join(root, 'hello.re')
  const out = join(root, 'build')

  const written = runCli('check', '--write', file)
  assert.equal(written.status, 0, written.stderr)
  const canonical = await readFile(file, 'utf8')
  const rewritten = runCli('check', '--write', file)
  assert.equal(rewritten.status, 0, rewritten.stderr)
  assert.equal(await readFile(file, 'utf8'), canonical)

  const manifest = runCli('manifest', file)
  assert.equal(manifest.status, 0, manifest.stderr)

  const views = {}
  for (const [name, arguments_] of [
    ['text', ['view', file]],
    ['html', ['view', '--format', 'html', file]],
    ['svg', ['view', '--format', 'svg', file]],
  ]) {
    const view = runCli(...arguments_)
    assert.equal(view.status, 0, view.stderr)
    views[name] = view.stdout
  }

  const built = runCli('build', '--out', out, file)
  assert.equal(built.status, 0, built.stderr)

  const tree = {}
  for (const name of (await readdir(out)).sort()) {
    tree[name] = await readFile(join(out, name), 'utf8')
  }
  return {
    canonical,
    manifest: JSON.parse(manifest.stdout),
    tree,
    views,
  }
}
