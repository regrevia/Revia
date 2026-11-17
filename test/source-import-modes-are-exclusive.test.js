// The gate picks its job from one argument and used to ignore the rest, so a
// command line carrying a writing mode anywhere wrote while the operator read
// it as the reading one. These cases pin one mode exactly, and pin that a
// refusal to guess leaves the tree alone.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
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

// A root whose list is present, readable, and stale: dropping one line leaves
// a list `--check` refuses and `--write` repairs, so whether the tree moved is
// visible after the call rather than inferred from the exit code.
async function staleRoot() {
  const root = await temporaryRoot('nothing-is-missing')
  const list = join(root, 'SOURCE_IMPORT_FILES.json')
  const settled = await attempted(root, ['--refresh'])
  assert.equal(settled.status, 0, settled.stderr)
  const lines = (await readFile(list, 'utf8')).trimEnd().split('\n')
  await writeFile(list, `${[lines[0], ...lines.slice(2)].join('\n')}\n`)
  return { root, list }
}

const AMBIGUOUS = [
  ['--refresh', '--check'],
  ['--check', '--refresh'],
  ['--write', '--check'],
  ['--check', '--write'],
  ['--check', '--check'],
  ['--check', '--bogus'],
  ['--refresh', 'extra'],
]

test('a command line that names two jobs is refused, not resolved by position', async () => {
  const { root, list } = await staleRoot()
  const before = await readFile(list, 'utf8')
  for (const args of AMBIGUOUS) {
    const result = await attempted(root, args)
    assert.equal(result.status, 64, `${args.join(' ')} must not pick a mode`)
    assert.equal(result.stdout, '', `${args.join(' ')} must not report work done`)
    assert.match(result.stderr, /^Usage: /u)
    assert.equal(
      await readFile(list, 'utf8'),
      before,
      `${args.join(' ')} must leave the list as it found it`,
    )
  }
})

test('one job still runs, in every mode', async () => {
  const { root, list } = await staleRoot()
  const stale = await readFile(list, 'utf8')
  const refused = await attempted(root, ['--check'])
  assert.equal(refused.status, 1)
  assert.equal(refused.stderr, 'source-import-allowlist-unparseable\n')
  assert.equal(await readFile(list, 'utf8'), stale, '--check writes nothing')

  const repaired = await attempted(root, ['--refresh'])
  assert.equal(repaired.status, 0, repaired.stderr)
  assert.equal(JSON.parse(repaired.stdout).allowlist_transition, 'replaced')
  assert.notEqual(await readFile(list, 'utf8'), stale, '--refresh is the mode that repairs')

  const clean = await attempted(root, ['--check'])
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(JSON.parse(clean.stdout).allowlist_transition, 'unchanged')
})

test('the usage line asks for exactly one job', async () => {
  const { root } = await staleRoot()
  const result = await attempted(root, ['--check', '--write'])
  assert.match(result.stderr, /Usage: /u)
  assert.match(
    result.stderr,
    /--refresh\|--write\|--check/u,
    'the usage line names the jobs it accepts',
  )
  assert.match(
    await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    /names exactly one/u,
    'the guide must say the gate picks its job from one argument',
  )
})
