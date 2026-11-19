import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  newestWatchedSource,
  releaseBinaryPath,
  releaseBinarySkipReason,
  releaseBinaryState,
} from './release-binary-state.js'

// The four consumers of the release binary used to decide whether to measure it
// by asking `existsSync`, and Node reports a test that returned early exactly as
// it reports one that measured and agreed. This file covers the three answers
// the guard can now give, over a synthetic tree with synthetic mtimes, so the
// decision is testable without invoking cargo or depending on what this checkout
// happens to have built.

const second = 1000
const base = 1_700_000_000 * second

async function syntheticTree(t) {
  const root = await mkdtemp(join(tmpdir(), 'revia-release-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'native', 'revia-cli', 'src'), { recursive: true })
  await mkdir(join(root, 'native', 'target', 'release'), { recursive: true })
  return root
}

test('a checkout without a release binary says so instead of passing', async (t) => {
  const root = await syntheticTree(t)
  await writeFile(join(root, 'native', 'revia-cli', 'src', 'main.rs'), 'fn main() {}\n')
  utimesSync(join(root, 'native', 'revia-cli', 'src', 'main.rs'), base / second, base / second)

  const result = releaseBinaryState(root)
  assert.equal(result.state, 'absent')
  assert.equal(result.binary, releaseBinaryPath(root))
  const reason = releaseBinarySkipReason(result)
  assert.match(reason, /native[/\\]target[/\\]release[/\\]revia is not built in this checkout$/u)
})

test('a binary newer than every watched source is the only one measured', async (t) => {
  const root = await syntheticTree(t)
  const source = join(root, 'native', 'revia-cli', 'src', 'main.rs')
  const binary = releaseBinaryPath(root)
  await writeFile(source, 'fn main() {}\n')
  await writeFile(binary, 'binary\n')
  utimesSync(source, base / second, base / second)
  utimesSync(binary, (base + second) / second, (base + second) / second)

  assert.equal(releaseBinaryState(root).state, 'fresh')
})

test('a binary older than the newest watched source is stale, and names the file', async (t) => {
  const root = await syntheticTree(t)
  const source = join(root, 'native', 'revia-cli', 'src', 'main.rs')
  const manifest = join(root, 'native', 'revia-cli', 'Cargo.toml')
  const binary = releaseBinaryPath(root)
  await writeFile(source, 'fn main() {}\n')
  await writeFile(manifest, '[package]\nname = "revia-cli"\n')
  await writeFile(binary, 'binary\n')
  utimesSync(binary, base / second, base / second)
  utimesSync(source, (base + 2 * second) / second, (base + 2 * second) / second)
  utimesSync(manifest, (base + second) / second, (base + second) / second)

  const result = releaseBinaryState(root)
  assert.equal(result.state, 'stale')
  assert.equal(result.newer, source)
  const reason = releaseBinarySkipReason(result)
  assert.match(reason, /is older than .*main\.rs, so it answers for source it was not built from$/u)
})

test('build output never makes a fresh binary look stale', async (t) => {
  const root = await syntheticTree(t)
  const source = join(root, 'native', 'revia-cli', 'src', 'main.rs')
  const binary = releaseBinaryPath(root)
  const artifact = join(root, 'native', 'target', 'release', 'build', 'bundle.toml')
  await mkdir(join(root, 'native', 'target', 'release', 'build'), { recursive: true })
  await writeFile(source, 'fn main() {}\n')
  await writeFile(binary, 'binary\n')
  await writeFile(artifact, 'generated at build time\n')
  utimesSync(source, base / second, base / second)
  utimesSync(binary, (base + second) / second, (base + second) / second)
  utimesSync(artifact, (base + 60 * second) / second, (base + 60 * second) / second)

  assert.equal(newestWatchedSource(join(root, 'native')).path, source)
  assert.equal(releaseBinaryState(root).state, 'fresh')
})

test('a directory standing where the binary belongs is not a binary', async (t) => {
  const root = await syntheticTree(t)
  await mkdir(releaseBinaryPath(root), { recursive: true })

  const result = releaseBinaryState(root)
  assert.equal(result.state, 'absent')
  assert.equal(result.unreadable, 'not-a-file')
  assert.match(releaseBinarySkipReason(result), /is not a file$/u)
})

// A child `node --test` inherits the parent's test context and then speaks the
// internal v8 event protocol instead of the reporter asked for on its command
// line: `NODE_TEST_CONTEXT=child-v8` alone is enough, and the serialized events
// carry the same `skip` reason in a form no JUnit reader parses. The probe below
// is about what a reader of the report sees, so it runs as a plain node process.
function withoutTestContext() {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_TEST_WORKER_ID
  delete environment.NODE_OPTIONS
  return environment
}

// The mechanism, not just the decision: a test that cannot measure must reach
// the report as skipped. Node keeps the case in `<!-- tests N -->`, so the
// tracked population count does not move when a checkout has no build output.
test('a skipped measurement reaches the JUnit report as skipped', async (t) => {
  const root = await syntheticTree(t)
  const probe = join(root, 'probe.test.js')
  const helper = fileURLToPath(new URL('./release-binary-state.js', import.meta.url))
  await writeFile(
    probe,
    [
      "import test from 'node:test'",
      `import { releaseBinaryState, releaseBinarySkipReason } from ${JSON.stringify(helper)}`,
      "test('measures the release binary', (t) => {",
      `  const state = releaseBinaryState(${JSON.stringify(root)})`,
      `  if (state.state !== 'fresh') { t.skip(releaseBinarySkipReason(state)); return }`,
      "  t.fail('the binary is not there, so this must not run')",
      '})',
      '',
    ].join('\n'),
  )
  const result = spawnSync(
    process.execPath,
    ['--test', '--experimental-test-isolation=none', '--test-reporter=junit', probe],
    { cwd: root, encoding: 'utf8', env: withoutTestContext() },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /<skipped type="skipped" message="[^"]*is not built in this checkout"\/>/u)
  assert.match(result.stdout, /<!-- tests 1 -->/u)
  assert.match(result.stdout, /<!-- fail 0 -->/u)
})
